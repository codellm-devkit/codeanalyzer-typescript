/**
 * signatureOf — THE canonicalizer. One function computes a declaration's signature by walking
 * its scope-contributing ancestors, so the caller-side id (assigned during symbol-table build)
 * and the callee-side id (computed during call-graph resolution) are byte-identical. Edges can
 * therefore only ever reference signatures that exist in the symbol table.
 */
import { Node } from "ts-morph";
import { fileKeyOf, signatureOf, constructorSignatureOf } from "./schema";

/** The name a node contributes to a signature's dotted member chain, or null if it contributes none. */
export function contributorName(node: Node): string | null {
  if (Node.isClassDeclaration(node) || Node.isClassExpression(node)) return classLikeName(node);
  if (Node.isInterfaceDeclaration(node)) return node.getName();
  if (Node.isEnumDeclaration(node)) return node.getName();
  if (Node.isTypeAliasDeclaration(node)) return node.getName();
  if (Node.isModuleDeclaration(node)) return node.getName(); // namespace
  if (Node.isFunctionDeclaration(node)) return funcLikeName(node);
  if (Node.isMethodDeclaration(node) || Node.isMethodSignature(node)) return safeName(node);
  if (Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) return safeName(node);
  if (Node.isConstructorDeclaration(node)) return "constructor";
  if (Node.isVariableDeclaration(node)) {
    const init = node.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return node.getName();
    return null;
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return anonName(node);
  return null;
}

/**
 * The segment an unnamed function-like node contributes. Position is the only discriminant a
 * nameless callable has, and it is the one every call-graph builder can compute independently
 * — which is what keeps caller-side and callee-side ids byte-identical. Angle brackets mark the
 * segment synthetic (the `<init>`/`<clinit>` convention). It joins the dotted chain, so an
 * anonymous callable lives in the durable id tier and never collides with the `@line:col`
 * ordinal namespace that body nodes use.
 *
 * Returns null when a VariableDeclaration ancestor already names this callable (`const f = () =>`)
 * — that case is handled above, and contributing here as well would double the segment.
 */
function anonName(node: Node): string | null {
  const parent = node.getParent();
  if (parent && Node.isVariableDeclaration(parent) && parent.getInitializer() === node) return null;
  const { line, column } = node.getSourceFile().getLineAndColumnAtPos(node.getStart());
  return `<anon@${line}:${column}>`;
}

export function isCallableDecl(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isMethodSignature(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node)
  );
}

/**
 * Compute the canonical signature for a declaration node. Unnamed function-like nodes are named
 * positionally (see `anonName`), so this returns null only for nodes that are not declarations at
 * all.
 */
export function computeSignatureForDecl(node: Node, root: string): string | null {
  const sf = node.getSourceFile();
  const { modulePrefix } = fileKeyOf(sf.getFilePath(), root);
  const parts: string[] = [];
  // Ancestors come innermost-first; reverse to outermost-first so the chain reads root → leaf.
  for (const a of node.getAncestors().reverse()) {
    const nm = contributorName(a);
    if (nm !== null) parts.push(nm);
  }
  if (Node.isConstructorDeclaration(node)) {
    parts.push("constructor");
  } else {
    const own = contributorName(node);
    if (own === null) return null;
    parts.push(own);
  }
  return signatureOf(modulePrefix, ...parts);
}

/** Resolve the declaration a call/new expression targets, following import aliases. */
export function resolveCalleeDecl(call: Node): Node | undefined {
  if (!Node.isCallExpression(call) && !Node.isNewExpression(call)) return undefined;
  const expr = call.getExpression();
  let symNode: Node = expr;
  if (Node.isPropertyAccessExpression(expr)) symNode = expr.getNameNode();
  else if (Node.isElementAccessExpression(expr)) return undefined; // dynamic dispatch — best-effort skip
  let sym = symNode.getSymbol();
  if (!sym) return undefined;
  const aliased = sym.getAliasedSymbol();
  if (aliased) sym = aliased;
  const decls = sym.getDeclarations();
  return decls && decls.length ? decls[0] : undefined;
}

/** Where a checker-resolved declaration lives: in-project, a node_modules package, or the TS stdlib. */
export function externalHomeOf(decl: Node): { module: string } | null {
  const p = decl.getSourceFile().getFilePath();
  // TS stdlib (lib.es5.d.ts, lib.dom.d.ts, ...) — checked BEFORE the generic node_modules match,
  // which would otherwise claim these files as belonging to the package `typescript`.
  if (/typescript\/lib\/lib\..*\.d\.ts$/.test(p)) return { module: "(builtin)" };
  // Take the LAST node_modules/<pkg> segment, not the first: under pnpm's virtual store a real
  // path looks like `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/...`, so the first match
  // would capture `.pnpm` instead of the package. The innermost occurrence is always the real home.
  const matches = [...p.matchAll(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/g)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  const pkg = last[1];
  // DefinitelyTyped's node typings model the Node builtins one file per module — name the target
  // by its import specifier (`node:fs`, `node:stream/consumers`) so this path and the import-index
  // fallback (which keys phantoms by specifier) agree on one identity per logical callee, instead
  // of collapsing every builtin under a single `node` module.
  if (pkg === "@types/node") {
    const rel = p.slice((last.index as number) + last[0].length + 1).replace(/(\.d)?\.ts$/, "");
    return { module: rel === "index" ? "node" : `node:${rel}` };
  }
  // Any other `@types/<pkg>` ships only type declarations FOR `<pkg>` — treat the runtime package
  // as home so a package's identity is stable whether its types are bundled or DT-sourced.
  return { module: pkg.startsWith("@types/") ? pkg.slice("@types/".length) : pkg };
}

/**
 * Resolve a call/new site to the signature of an existing symbol-table callable, or an external
 * descriptor when the checker resolved the call to a declaration outside the project (a
 * node_modules package or the TS stdlib), or null when neither applies.
 * `allSignatures` gates in-project resolution so an edge can never dangle into a non-recorded
 * declaration.
 */
export function resolveCalleeSignature(
  call: Node,
  root: string,
  allSignatures: Set<string>,
): { signature: string; isConstructor: boolean; external?: { module: string; member: string } } | null {
  const decl = resolveCalleeDecl(call);
  if (!decl) return null;

  // `new X()` / a bare class reference → the class's (possibly synthesized) constructor.
  if (Node.isClassDeclaration(decl) || Node.isClassExpression(decl)) {
    const csig = computeSignatureForDecl(decl, root);
    if (csig) {
      const target = constructorSignatureOf(csig);
      if (allSignatures.has(target)) return { signature: target, isConstructor: true };
    }
    const home = externalHomeOf(decl);
    if (home) {
      const member = classLikeName(decl);
      return { signature: `${home.module}.${member}`, isConstructor: true, external: { module: home.module, member } };
    }
    return null;
  }

  // const f = () => {} / function expression bound to a variable.
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      const s = computeSignatureForDecl(decl, root);
      if (s && allSignatures.has(s)) return { signature: s, isConstructor: false };
      const home = externalHomeOf(decl);
      if (home) {
        const member = safeName(decl);
        return { signature: `${home.module}.${member}`, isConstructor: false, external: { module: home.module, member } };
      }
      return null;
    }
    return null;
  }

  if (isCallableDecl(decl)) {
    const s = computeSignatureForDecl(decl, root);
    const isConstructor = Node.isConstructorDeclaration(decl);
    if (s && allSignatures.has(s)) return { signature: s, isConstructor };
    const home = externalHomeOf(decl);
    if (home) {
      const member = safeName(decl as never);
      return { signature: `${home.module}.${member}`, isConstructor, external: { module: home.module, member } };
    }
    return null;
  }

  // EXTERNAL-ONLY widening (#53): framework .d.ts files declare callable members as property
  // signatures or function-typed property declarations (`get: IRouterMatcher` in @types/express,
  // `rxSession: (cfg?) => RxSession` in neo4j-driver) — kinds isCallableDecl deliberately excludes
  // for the in-project path (a project property is a field, not a callable). Being the callee of
  // this very call expression is evidence enough that the member is callable, so accept these
  // kinds when — and only when — the declaration homes outside the project.
  if (Node.isPropertySignature(decl) || Node.isPropertyDeclaration(decl)) {
    const home = externalHomeOf(decl);
    if (home) {
      const member = safeName(decl);
      return { signature: `${home.module}.${member}`, isConstructor: false, external: { module: home.module, member } };
    }
  }
  return null;
}

// --- name helpers ---

function safeName(node: { getName(): string | undefined } | { getName(): string }): string {
  const n = (node as { getName(): string | undefined }).getName();
  return n ?? "(anonymous)";
}

function classLikeName(node: Node): string {
  const n = (node as unknown as { getName?: () => string | undefined }).getName?.();
  if (n) return n;
  if ((node as unknown as { isDefaultExport?: () => boolean }).isDefaultExport?.()) return "default";
  return "(anonymous)";
}

function funcLikeName(node: Node): string {
  const fn = node as unknown as { getName?: () => string | undefined; isDefaultExport?: () => boolean };
  const n = fn.getName?.();
  if (n) return n;
  if (fn.isDefaultExport?.()) return "default";
  return "(anonymous)";
}
