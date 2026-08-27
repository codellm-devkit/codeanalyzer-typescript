/**
 * The defuse linker — the local pass that backfills call edges the tsc resolver missed
 * (docs/design/specs/defuse-linker-call-graph.md, #98; python parity: the Jedi + defuse-linker
 * architecture that replaced PyCG). Per-callable and bounded-round only — NO whole-program
 * fixpoint; sorted iteration throughout, so the output is deterministic by construction.
 *
 * Tiers, applied in order (a precise resolution is never widened by a later tier):
 *   T1  local value chase — alias chains `const f = handler; f()` through bounded
 *       symbol→declaration hops (the checker's alias-following covers imports).
 *   T2  decorator invocations — `@Get(':id')` on a method/accessor becomes an edge
 *       decorated-callable → decorator target, EDGE-ONLY (decorator calls live outside walkBody's
 *       reach, so there is no body call node to refine — matching the historical Jelly shape).
 *   T3  external-callback rule — a function value passed to an external/unresolved callee emits
 *       enclosing-callable → function-value, EDGE-ONLY (`.map(u => …)`, `app.get('/x', handler)`).
 *       Deliberate divergence from python (JS is callback-central); recorded in the spec.
 *   T4  bounded interprocedural votes — (a) a parameter-invoking site (`cb()`) resolves to the
 *       function values passed at that position by resolved-internal callers (two rounds: round
 *       one's resolutions vote before round two); (b) `const f = factory(); f()` resolves through
 *       the factory's unique returned function.
 *   T5  CHA-by-name — receiver sites that survive every typed tier resolve to every internal
 *       callable of that method name (bounded per site) — the over-approximation Joern emits for
 *       untyped receivers. Edge-only (ambiguous by definition).
 *
 * Linker resolutions are returned in a map and applied to the L1 `call` body nodes by
 * `backfillCallees` — NEVER written into `callee_signature` (the symbol table round-trips the
 * analysis cache; a persisted resolution would resurface on a warm run with tsc provenance).
 */
import { Node } from "ts-morph";
import { CALL_DEP, type TSCallEdge, type TSCallable, type TSCallsite, type TSExternalSymbol, forEachCallable } from "../schema";
import { computeSignatureForDecl, externalHomeOf, fileKeyOf, isCallableDecl, resolveCalleeSignature } from "../schema";
import { callBodyKeys } from "../schema/l1Body";
import type { CallGraphContext } from "./provider";
import type { CallGraphResult } from "./callGraph";
import { indexCallExpressions } from "./callGraph";

/** Per-call-site resolutions for the sanctioned `callee: null→id` refinement: callerSig → bodyKey → calleeSig. */
export type LinkerResolutions = Map<string, Map<string, string>>;

export interface LinkerOutput {
  result: CallGraphResult;
  resolutions: LinkerResolutions;
}

// ponytail: fixed small bounds; tune from the Joern ledger, not from flags (spec: no backend flag).
const ALIAS_CHASE_LIMIT = 8; // hops through `const f = g` chains
const CHA_FAN_LIMIT = 16; // max name-matched targets per T5 site

export function runDefuseLinker(ctx: CallGraphContext): LinkerOutput {
  const { project, symbol_table, root, log } = ctx;

  // The signature universe (full table — cross-program targets resolve) + the name→sigs CHA index.
  const allSignatures = new Set<string>();
  const byName = new Map<string, string[]>();
  for (const mod of Object.values(symbol_table)) {
    forEachCallable(mod, (c) => {
      allSignatures.add(c.signature);
      const arr = byName.get(c.name) ?? [];
      arr.push(c.signature);
      byName.set(c.name, arr);
    });
  }
  for (const sigs of byName.values()) sigs.sort();

  // Callables to iterate: this program's modules only, sorted for determinism.
  const callables: TSCallable[] = [];
  for (const [key, mod] of Object.entries(symbol_table)) {
    if (ctx.only && !ctx.only.has(key)) continue;
    forEachCallable(mod, (c) => callables.push(c));
  }
  callables.sort((a, b) => a.signature.localeCompare(b.signature));

  const callExprIndex = indexCallExpressions(project);
  const nodeOf = (c: TSCallable, cs: TSCallsite): Node | undefined =>
    callExprIndex.get(`${c.abs_path}#${cs.start_line}:${cs.start_column}-${cs.end_line}:${cs.end_column}`);

  // A resolved-but-external callee is one whose signature is not in the symbol table.
  const isExternalSig = (sig: string | undefined): boolean => !!sig && !allSignatures.has(sig);

  // ---------------------------------------------------------------------------------------------
  // edge/resolution accumulation
  // ---------------------------------------------------------------------------------------------
  const edges = new Map<string, TSCallEdge>();
  const addEdge = (source: string, target: string): void => {
    const k = `${source} ${target}`;
    const ex = edges.get(k);
    if (ex) ex.weight++;
    else edges.set(k, { source, target, type: CALL_DEP, weight: 1, provenance: ["defuse"], tags: {} });
  };
  const external_symbols: Record<string, TSExternalSymbol> = {};
  const resolutions: LinkerResolutions = new Map();
  const resolve = (callerSig: string, bodyKey: string, targetSig: string): void => {
    addEdge(callerSig, targetSig);
    let m = resolutions.get(callerSig);
    if (!m) resolutions.set(callerSig, (m = new Map()));
    m.set(bodyKey, targetSig);
  };

  /**
   * The signature of the first-party callable a VALUE expression denotes, chasing bounded alias
   * chains: a bare arrow/function expression, an identifier for a function declaration, a
   * `const f = () => …` binding, or `const f = g` (g eventually a function) — else null.
   */
  const functionValueSig = (expr: Node): string | null => {
    // IIFE / parenthesized function values: `(() => …)()`, `(function f() {})()`.
    while (Node.isParenthesizedExpression(expr)) expr = expr.getExpression();
    if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) {
      const s = computeSignatureForDecl(expr, root);
      return s && allSignatures.has(s) ? s : null;
    }
    if (!Node.isIdentifier(expr)) return null;
    let node: Node = expr;
    for (let hop = 0; hop < ALIAS_CHASE_LIMIT; hop++) {
      let sym = node.getSymbol();
      if (!sym) return null;
      const aliased = sym.getAliasedSymbol();
      if (aliased) sym = aliased;
      const decl = sym.getDeclarations()?.[0];
      if (!decl) return null;
      if (Node.isFunctionDeclaration(decl) || Node.isArrowFunction(decl) || Node.isFunctionExpression(decl) || Node.isMethodDeclaration(decl)) {
        const s = computeSignatureForDecl(decl, root);
        return s && allSignatures.has(s) ? s : null;
      }
      if (Node.isVariableDeclaration(decl)) {
        const init = decl.getInitializer();
        if (!init) return null;
        if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
          const s = computeSignatureForDecl(decl, root);
          return s && allSignatures.has(s) ? s : null;
        }
        if (Node.isIdentifier(init)) {
          node = init; // alias chain: keep chasing
          continue;
        }
        return null;
      }
      return null;
    }
    return null;
  };

  /** The parameter index of `expr` within `enclosing`, when it names one of its parameters. */
  const paramIndexOf = (expr: Node, enclosing: TSCallable): number | null => {
    if (!Node.isIdentifier(expr)) return null;
    const decl = expr.getSymbol()?.getDeclarations()?.[0];
    if (!decl || !Node.isParameterDeclaration(decl)) return null;
    const name = expr.getText();
    const idx = enclosing.parameters.findIndex((p) => p.name === name);
    return idx >= 0 ? idx : null;
  };

  // ---------------------------------------------------------------------------------------------
  // main site sweep: T1 chase, T3 callback rule, and the T4/T5 worklists
  // ---------------------------------------------------------------------------------------------
  interface ParamSite {
    enclosing: TSCallable;
    bodyKey: string;
    paramIndex: number;
  }
  interface FactorySite {
    enclosing: TSCallable;
    bodyKey: string;
    factorySig: string; // resolved-internal callee of the binding's initializer call
  }
  interface ReceiverSite {
    enclosing: TSCallable;
    cs: TSCallsite;
  }
  const paramSites: ParamSite[] = [];
  const factorySites: FactorySite[] = [];
  const receiverSites: ReceiverSite[] = [];
  // Reverse index for T4 voting: internal target sig → the AST argument lists of its call sites.
  const argsByTarget = new Map<string, Node[][]>();
  const recordCallArgs = (targetSig: string, node: Node | undefined): void => {
    if (!node || !allSignatures.has(targetSig)) return;
    const args = (node as unknown as { getArguments?: () => Node[] }).getArguments?.() ?? [];
    if (!args.length) return;
    const arr = argsByTarget.get(targetSig) ?? [];
    arr.push(args);
    argsByTarget.set(targetSig, arr);
  };

  let t1 = 0;
  let t3 = 0;
  for (const c of callables) {
    for (const [bodyKey, cs] of callBodyKeys(c.call_sites)) {
      const node = nodeOf(c, cs);
      if (cs.callee_signature) {
        recordCallArgs(cs.callee_signature, node);
      } else if (node) {
        const expr = (node as unknown as { getExpression: () => Node }).getExpression();
        // T1 — local value chase on the callee expression itself.
        const chased = functionValueSig(expr);
        if (chased) {
          resolve(c.signature, bodyKey, chased);
          recordCallArgs(chased, node);
          t1++;
        } else {
          const pIdx = paramIndexOf(expr, c);
          if (pIdx !== null) {
            paramSites.push({ enclosing: c, bodyKey, paramIndex: pIdx });
          } else if (Node.isIdentifier(expr)) {
            // T4b — `const f = factory(); f()`: binding initialized by a resolved-internal call.
            const decl = expr.getSymbol()?.getDeclarations()?.[0];
            const init = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
            if (init && Node.isCallExpression(init)) {
              const r = resolveCalleeSignature(init, root, allSignatures);
              if (r && !r.external && allSignatures.has(r.signature)) {
                factorySites.push({ enclosing: c, bodyKey, factorySig: r.signature });
              }
            }
          } else if (Node.isPropertyAccessExpression(expr) && cs.receiver_expr != null && !cs.is_constructor_call) {
            receiverSites.push({ enclosing: c, cs });
          }
        }
      }
      // T3 — external-callback rule: function values handed to an external/unresolved callee.
      if (node && (!cs.callee_signature || isExternalSig(cs.callee_signature))) {
        const args = (node as unknown as { getArguments?: () => Node[] }).getArguments?.() ?? [];
        for (const arg of args) {
          const fn = functionValueSig(arg);
          if (fn && fn !== c.signature) {
            addEdge(c.signature, fn);
            t3++;
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Module-scope sweep (python #131 parity: module-scope execution is attributed to the MODULE).
  // These sites have no call_sites record and no body node — T1 chase and the T3 callback rule
  // apply edge-only, with the module prefix as the source.
  // ---------------------------------------------------------------------------------------------
  const enclosingCallable = (node: Node): Node | undefined => {
    for (const a of node.getAncestors()) if (isCallableDecl(a)) return a;
    return undefined;
  };
  for (const [, node] of [...callExprIndex.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (enclosingCallable(node)) continue;
    const fk = fileKeyOf(node.getSourceFile().getFilePath(), root);
    if (ctx.only && !ctx.only.has(fk.fileKey)) continue;
    const source = fk.modulePrefix;
    const r = resolveCalleeSignature(node, root, allSignatures);
    if (!r) {
      // T1 at module scope: `const f = handler; f()` in top-level code.
      const expr = (node as unknown as { getExpression: () => Node }).getExpression();
      const chased = functionValueSig(expr);
      if (chased) {
        addEdge(source, chased);
        t1++;
      }
    }
    // T3 at module scope — the dominant express idiom: `app.get('/x', handler)` top-level.
    if (!r || r.external) {
      const args = (node as unknown as { getArguments?: () => Node[] }).getArguments?.() ?? [];
      for (const arg of args) {
        const fn = functionValueSig(arg);
        if (fn && fn !== source) {
          addEdge(source, fn);
          t3++;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // T2 — decorator invocations (edge-only). The SOURCE is where the decorator executes: the
  // decorated callable for method/accessor/parameter decorators; the MODULE for class and
  // property decorators (a decorator on a top-level definition runs in module scope — python
  // #131's rule, and Joern's own attribution).
  // ---------------------------------------------------------------------------------------------
  let t2 = 0;
  const files = [...project.getSourceFiles()]
    .filter((sf) => !sf.isDeclarationFile() && !sf.getFilePath().includes("/node_modules/"))
    .sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));
  for (const sf of files) {
    sf.forEachDescendant((n) => {
      if (!Node.isDecorator(n)) return;
      // The edge SOURCE is where the decorator executes: the decorated callable for method/
      // accessor/parameter decorators; the MODULE prefix for class and property decorators.
      let owner = n.getParent();
      if (owner && Node.isParameterDeclaration(owner)) owner = owner.getParent();
      let ownerSig: string | null = null;
      if (owner && (Node.isMethodDeclaration(owner) || Node.isGetAccessorDeclaration(owner) || Node.isSetAccessorDeclaration(owner))) {
        ownerSig = computeSignatureForDecl(owner, root);
        if (!ownerSig || !allSignatures.has(ownerSig)) return;
      } else if (owner && (Node.isClassDeclaration(owner) || Node.isPropertyDeclaration(owner))) {
        ownerSig = fileKeyOf(sf.getFilePath(), root).modulePrefix;
      } else {
        return;
      }
      const expr = n.getExpression();
      let targetSig: string | null = null;
      let external: { module: string; member: string } | null = null;
      if (Node.isCallExpression(expr)) {
        const r = resolveCalleeSignature(expr, root, allSignatures);
        if (r) {
          targetSig = r.signature;
          external = r.external ?? null;
        }
      } else if (Node.isIdentifier(expr)) {
        const direct = functionValueSig(expr);
        if (direct) targetSig = direct;
        else {
          const decl = expr.getSymbol()?.getAliasedSymbol()?.getDeclarations()?.[0] ?? expr.getSymbol()?.getDeclarations()?.[0];
          const home = decl ? externalHomeOf(decl) : null;
          if (home) {
            const member = expr.getText();
            targetSig = `${home.module}.${member}`;
            external = { module: home.module, member };
          }
        }
      }
      if (!targetSig) return;
      if (external) {
        if (!ctx.phantoms) return;
        if (!external_symbols[targetSig]) external_symbols[targetSig] = { name: external.member, module: external.module };
      }
      addEdge(ownerSig, targetSig);
      t2++;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // T4 — bounded votes, two rounds (round one's resolutions vote before round two).
  // ---------------------------------------------------------------------------------------------
  let t4 = 0;
  for (let round = 0; round < 2 && paramSites.length; round++) {
    const unresolvedNext: ParamSite[] = [];
    for (const site of paramSites.sort((a, b) => a.enclosing.signature.localeCompare(b.enclosing.signature) || a.bodyKey.localeCompare(b.bodyKey))) {
      const candidates = new Set<string>();
      for (const args of argsByTarget.get(site.enclosing.signature) ?? []) {
        const arg = args[site.paramIndex];
        if (!arg) continue;
        const fn = functionValueSig(arg);
        if (fn) candidates.add(fn);
      }
      if (!candidates.size) {
        unresolvedNext.push(site);
        continue;
      }
      const sorted = [...candidates].sort();
      for (const target of sorted) {
        addEdge(site.enclosing.signature, target);
        t4++;
        // Round-one resolutions feed round two's votes: a cb() site that now targets `target`
        // makes the enclosing callable a resolved-internal caller of it.
      }
      if (sorted.length === 1) {
        let m = resolutions.get(site.enclosing.signature);
        if (!m) resolutions.set(site.enclosing.signature, (m = new Map()));
        m.set(site.bodyKey, sorted[0] as string);
      }
    }
    paramSites.length = 0;
    paramSites.push(...unresolvedNext);
  }
  // T4b — factory returns: resolve through the factory's unique returned function value.
  const returnSummary = new Map<string, string | null>();
  const uniqueReturnedFn = (factorySig: string): string | null => {
    if (returnSummary.has(factorySig)) return returnSummary.get(factorySig) as string | null;
    let out: string | null = null;
    // Find the factory's AST via any recorded call-site node? Cheaper: search the sorted callables
    // list (same program) for the signature, then its declaration through the call-expression
    // index is unavailable — walk the source file at its span instead.
    const fc = callables.find((c) => c.signature === factorySig);
    if (fc) {
      const sf = project.getSourceFile(fc.abs_path);
      const declNode = sf?.getDescendantAtPos(fc.span.bytes[0]);
      const fnNode = declNode ? [declNode, ...declNode.getAncestors()].find((a) => computeSignatureForDecl(a, root) === factorySig) : undefined;
      if (fnNode) {
        const returned = new Set<string>();
        fnNode.forEachDescendant((d) => {
          if (!Node.isReturnStatement(d)) return;
          const e = d.getExpression();
          if (!e) return;
          const fn = functionValueSig(e);
          if (fn) returned.add(fn);
          else returned.add("<opaque>");
        });
        if (returned.size === 1 && !returned.has("<opaque>")) out = [...returned][0] as string;
      }
    }
    returnSummary.set(factorySig, out);
    return out;
  };
  for (const site of factorySites.sort((a, b) => a.enclosing.signature.localeCompare(b.enclosing.signature) || a.bodyKey.localeCompare(b.bodyKey))) {
    const target = uniqueReturnedFn(site.factorySig);
    if (target) {
      resolve(site.enclosing.signature, site.bodyKey, target);
      t4++;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // T5 — CHA-by-name fallback (edge-only, bounded fan).
  // ---------------------------------------------------------------------------------------------
  let t5 = 0;
  for (const site of receiverSites.sort((a, b) => a.enclosing.signature.localeCompare(b.enclosing.signature))) {
    if (!site.cs) continue;
    const candidates = (byName.get(site.cs.method_name) ?? []).filter((s) => s !== site.enclosing.signature);
    // Over-cap names (get/set/toString-class fan) are skipped outright, not truncated — a partial
    // arbitrary subset would be neither sound-leaning nor deterministic in meaning.
    if (!candidates.length || candidates.length > CHA_FAN_LIMIT) continue;
    for (const target of candidates) {
      addEdge(site.enclosing.signature, target);
      t5++;
    }
  }

  const sortedEdges = [...edges.values()].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  log.info(`call graph (defuse): ${sortedEdges.length} edges — t1=${t1} chase, t2=${t2} decorator, t3=${t3} callback, t4=${t4} votes, t5=${t5} cha`);
  return {
    result: { edges: sortedEdges, external_symbols, synthesized_callables: {} },
    resolutions,
  };
}
