/**
 * config_use dataflow tiers (#101 unit C3). Widens the literal tier (src/semantic_analysis/
 * configUse.ts) with AST symbol resolution PLUS a reassignment check — deliberately NOT the
 * def-use substrate (defuse.ts): its reaching-definitions are keyed by k-limited access paths and
 * carry no string-literal VALUES, so closing a literal through them is machinery beyond this
 * unit. Resolving only an identifier with exactly one string-literal initializer that is never
 * reassigned is strictly MORE conservative than reaching-definitions — it under-approximates, so
 * it can never emit a wrong edge.
 *
 *  - INTRA (-a 3): the read's key expression is a local identifier bound to exactly one string
 *    literal initializer, never reassigned.
 *  - INTERPROC (-a 4): the key is a parameter, and every resolved internal call site passes the
 *    same string literal at that position (one call boundary, no fixpoint).
 *
 * Superset-monotonic: only ADDS `config_uses`, only REMOVES the corresponding `config_reads` —
 * reads that stay unresolved are left byte-identical, not re-tagged.
 *
 * Imports the schema/configUseRules LEAF files directly (never the `../schema` barrel, which
 * re-exports `emit.ts` — the module that imports this one): going through the barrel here would
 * close an import cycle back on emit.ts (mirrors semantic_analysis/configUse.ts's own rule).
 */
import { Node, SyntaxKind, type ParameterDeclaration, type Project, type VariableDeclaration } from "ts-morph";
import type { AnalysisInternal, TSCallable, TSConfigRead } from "../schema/schema";
import { forEachCallable } from "../schema/schema";
import { type ConfigUseSets, keyIndex } from "../semantic_analysis/configUse";
import { ACCESS_RULES } from "../semantic_analysis/configUseRules";

/**
 * `project` gives the AST the tiers read. A no-op below `-a 3` (the literal tier alone stands).
 * Deterministic: `uses` stays sorted.
 */
export function widenConfigUses(app: AnalysisInternal, project: Project, literal: ConfigUseSets, level: number): ConfigUseSets {
  if (level < 3) return literal;
  const idx = keyIndex(app);
  const rootNamespaces = new Map(ACCESS_RULES.map((r) => [r.root, r.namespaces]));
  const uses = [...literal.uses];
  const resolvedSites = new Set<string>();

  for (const read of literal.reads) {
    if (read.reason !== "non-literal") continue;
    const key = resolveKeyThroughDataflow(read, project, app, level);
    if (key === null) continue;
    const namespaces = rootNamespaces.get(read.callee) ?? ["env"];
    const dsts = [...new Set(namespaces.flatMap((ns) => idx.get(`${ns} ${key}`) ?? []))].sort();
    if (!dsts.length) continue; // resolved a literal, but no declared key names it — leave the read standing
    for (const dst of dsts) uses.push({ src: read.site, dst, prov: ["dataflow"] });
    resolvedSites.add(read.site);
  }

  const reads = literal.reads.filter((r) => !resolvedSites.has(r.site));
  uses.sort((a, b) => a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst));
  return { uses, reads };
}

/**
 * The literal a read's key expression closes on, or null. Only ElementAccessExpression reads
 * (`process.env[expr]`) are in scope: a PropertyAccessExpression key is always static already
 * (the literal tier resolved or rejected it), and a CALL-rule read's node is a call expression,
 * which fails the type check below and is left unwidened — out of scope for this unit.
 */
function resolveKeyThroughDataflow(read: TSConfigRead, project: Project, app: AnalysisInternal, level: number): string | null {
  const node = accessNodeFor(read.site, project, app);
  if (!node || !Node.isElementAccessExpression(node)) return null;
  const arg = node.getArgumentExpression();
  if (!arg || !Node.isIdentifier(arg)) return null;
  const decl = arg.getSymbol()?.getDeclarations()?.[0];
  if (!decl) return null;
  // INTRA: `const/let/var key = "LITERAL"` (or a non-interpolated template literal), never reassigned.
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    const value = literalTextOf(init);
    return value !== undefined && !isReassigned(decl) ? value : null;
  }
  // INTERPROC (-a 4): a parameter whose every resolved caller passes one identical literal.
  if (level >= 4 && Node.isParameterDeclaration(decl)) return uniqueLiteralArgument(decl, app, project);
  return null;
}

/**
 * The value of a string literal OR a non-interpolated template literal, or undefined — mirrors
 * the literal tier's own acceptance (`literalArgumentAt` in semantic_analysis/configUse.ts) so
 * the same expression shape resolves the same way at every tier. An INTERPOLATED template
 * (`` `PAYMENT_${x}` ``) parses as a distinct `TemplateExpression` node kind, never this one, so
 * it is excluded for free — no separate `${`-substring guard needed here.
 */
function literalTextOf(node: Node | undefined): string | undefined {
  if (node && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))) return node.getLiteralValue();
  return undefined;
}

/** Every callable in `app`, one flat list — config reads are rare, so re-walking per read costs nothing. */
function allCallables(app: AnalysisInternal): TSCallable[] {
  const out: TSCallable[] = [];
  for (const mod of Object.values(app.symbol_table)) forEachCallable(mod, (c) => out.push(c));
  return out;
}

function findCallable(app: AnalysisInternal, pred: (c: TSCallable) => boolean): TSCallable | undefined {
  return allCallables(app).find(pred);
}

/** The AST node whose exact byte span is [start, end) in `absPath`, or undefined. */
function nodeAtSpan(project: Project, absPath: string, start: number, end: number): Node | undefined {
  let n = project.getSourceFile(absPath)?.getDescendantAtPos(start);
  while (n && (n.getStart() !== start || n.getEnd() !== end)) n = n.getParent();
  return n;
}

/**
 * A read's `site` (`<callable-can-id>@<line:col>`, possibly `/2`-suffixed) back to the AST node
 * at that body node's recorded span. Mirrors callGraph.ts's `indexCallExpressions` precedent
 * (span-keyed AST lookup), keyed here by the byte offsets already recorded on the body node
 * instead of a rebuilt line/col index — config_access spans are captured off ONE AST node
 * (buildConfigAccess), so the exact-span walk-up below never has to disambiguate a collision.
 */
function accessNodeFor(site: string, project: Project, app: AnalysisInternal): Node | undefined {
  const at = site.lastIndexOf("@");
  if (at < 0) return undefined;
  const c = findCallable(app, (x) => x.id === site.slice(0, at));
  const bytes = c?.body[site.slice(at + 1)]?.span?.bytes;
  return c && bytes ? nodeAtSpan(project, c.abs_path, bytes[0], bytes[1]) : undefined;
}

function isAssignmentOperator(k: SyntaxKind): boolean {
  return k >= SyntaxKind.FirstAssignment && k <= SyntaxKind.LastAssignment;
}

/**
 * Any assignment whose left side CONTAINS an identifier resolving to the same declaration — not
 * merely IS one. Fix round 1: the original identity check (`left === id`) missed destructuring
 * reassignment (`({ key } = obj)`, `[key] = arr`), where the tracked identifier is a binding
 * target nested inside the left side, not the whole of it. A local binding can only be
 * referenced within its own lexical scope, so scanning the whole file's assignments covers every
 * possible reference without a separate closure-boundary walk.
 *
 * Deliberately over-inclusive: `obj[key] = value` also counts (the left side's subtree contains
 * `key`, even though `key` is only a computed index there, not itself rebound). That costs a
 * missed edge, never a wrong one — the same posture as every other check in this tier.
 */
function isReassigned(decl: VariableDeclaration): boolean {
  const nameNode = decl.getNameNode();
  if (!Node.isIdentifier(nameNode)) return true; // destructuring binding — conservative, never widen
  const symbol = nameNode.getSymbol();
  // A shorthand `{ key }` binds `key` via a SEPARATE symbol (one per ShorthandPropertyAssignment
  // declaration slot) — plain `.getSymbol()` on its identifier never equals `symbol`, even though
  // it IS the same reassigned variable. `getShorthandAssignmentValueSymbol` is the checker's own
  // resolver for exactly this indirection (confirmed empirically: `.getSymbol()` alone misses it).
  const checker = decl.getProject().getTypeChecker();
  const targetsSymbol = (left: Node): boolean => {
    if (Node.isIdentifier(left)) return left.getSymbol() === symbol;
    return left.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => {
      if (id.getSymbol() === symbol) return true;
      const p = id.getParent();
      return Node.isShorthandPropertyAssignment(p) && checker.getShorthandAssignmentValueSymbol(p) === symbol;
    });
  };
  return decl
    .getSourceFile()
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .some((bin) => isAssignmentOperator(bin.getOperatorToken().getKind()) && targetsSymbol(bin.getLeft()));
}

/**
 * A parameter's enclosing callable, matched on file + start offset the same way builders.ts
 * picks a signature node: the function-like node itself, unless it's an arrow/function-expression
 * bound directly to a `const`/`let` — then the VariableDeclaration IS the signature node, and
 * TSCallable.span follows it, not the function keyword (buildCallable's sigNode/fnNode split).
 */
function uniqueLiteralArgument(decl: ParameterDeclaration, app: AnalysisInternal, project: Project): string | null {
  const fn = decl.getParent();
  if (!fn) return null;
  const params = (fn as unknown as { getParameters?: () => Node[] }).getParameters?.() ?? [];
  const paramIndex = params.findIndex((p) => p === decl);
  if (paramIndex < 0) return null;
  const fnParent = fn.getParent();
  const sigStart = fnParent && Node.isVariableDeclaration(fnParent) && fnParent.getInitializer() === fn ? fnParent.getStart() : fn.getStart();
  const absPath = decl.getSourceFile().getFilePath();
  const callable = findCallable(app, (c) => c.abs_path === absPath && c.span.bytes[0] === sigStart);
  if (!callable) return null;

  // Matched on the BODY node's resolved `callee` id (backfillCallees), not call_sites'
  // callee_signature: the id also carries defuse-linker resolutions, which callee_signature
  // deliberately never persists (cache provenance rule, l2Callees.ts) — a stronger signal for
  // the same cost, so fewer resolvable calls are missed.
  let literal: string | undefined;
  for (const caller of allCallables(app)) {
    for (const node of Object.values(caller.body)) {
      if (node.kind !== "call" || node.callee !== callable.id || !node.span) continue;
      const callNode = nodeAtSpan(project, caller.abs_path, node.span.bytes[0], node.span.bytes[1]);
      const argExpr = callNode && Node.isCallExpression(callNode) ? callNode.getArguments()[paramIndex] : undefined;
      const value = literalTextOf(argExpr);
      if (value === undefined) return null; // missing/dynamic arg breaks agreement
      if (literal === undefined) literal = value;
      else if (literal !== value) return null; // callers disagree
    }
  }
  return literal ?? null; // no resolved caller — nothing to widen
}
