/**
 * Stages 1–4 extraction — the AST-bound half of the level-3 pipeline, per callable:
 * CFG (stage 1) → post-dominance + control dependence (stage 2) → def/use facts (stage 3's
 * extraction half) → the serializable CallableGraphData projection.
 *
 * This is the unit that fans out over the worker pool: it has zero cross-function dependencies
 * (embarrassingly parallel), and its output is plain data, so everything downstream — the
 * reaching-defs solve, the summary wavefront, SDG assembly, emission — never touches an AST
 * again. The same function serves the sequential (--jobs 1) path against the main-thread
 * project, which is what makes N-vs-1 differential testing meaningful.
 */
import { Node, type Project } from "ts-morph";
import { computeSignatureForDecl, type GraphNode } from "../schema";
import { buildCfg } from "./cfg";
import { extractFunctionFacts } from "./defuse";
import { controlDependence, postDominators } from "./dominance";
import type { CallableGraphData, FunctionCfgBuild } from "./model";

/** Extract the full per-callable data product, or null when the callable has no body. */
export function extractCallableData(signature: string, fn: Node, path: string, root: string, k: number): CallableGraphData | null {
  const build = buildCfg(signature, fn);
  if (!build) return null;

  const cdg = controlDependence(build, postDominators(build)).sort(
    (a, b) => a.source - b.source || a.target - b.target,
  );
  const { facts, aliasPairs, returnValueNodes } = extractFunctionFacts(build, root, k);

  return {
    signature,
    path,
    nodes: build.nodes.map((n) => emitNode(n.id, n.kind, n.ast, build)),
    edges: [...build.edges].sort((a, b) => a.source - b.source || a.target - b.target || a.kind.localeCompare(b.kind)),
    cdg,
    entryId: build.entryId,
    exitId: build.exitId,
    paramIds: build.paramIds,
    hasRestParam: hasRestParam(build),
    facts,
    aliasPairs,
    returnValueNodes,
  };
}

/**
 * Walk source files and index callable declarations by canonical signature — the same
 * computeSignatureForDecl the symbol table and call graph use, so keys byte-match. For
 * `const f = () => {}` the signature keys the VariableDeclaration but the CFG is built from the
 * initializer (the node that owns parameters and body). Restrict with `onlyFiles` (absolute
 * paths) when a worker owns just a partition of the project.
 */
export function indexCallableDecls(project: Project, root: string, onlyFiles?: Set<string>): Map<string, Node> {
  const idx = new Map<string, Node>();
  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    if (sf.isDeclarationFile() || fp.includes("/node_modules/")) continue;
    if (onlyFiles && !onlyFiles.has(fp)) continue;
    sf.forEachDescendant((n) => {
      if (
        Node.isFunctionDeclaration(n) ||
        Node.isMethodDeclaration(n) ||
        Node.isConstructorDeclaration(n) ||
        Node.isGetAccessorDeclaration(n) ||
        Node.isSetAccessorDeclaration(n)
      ) {
        const sig = computeSignatureForDecl(n, root);
        if (sig && !idx.has(sig)) idx.set(sig, n);
      } else if (Node.isVariableDeclaration(n)) {
        const init = n.getInitializer();
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          const sig = computeSignatureForDecl(n, root);
          if (sig && !idx.has(sig)) idx.set(sig, init);
        }
      }
    });
  }
  return idx;
}

function emitNode(id: number, kind: GraphNode["kind"], ast: Node | null, build: FunctionCfgBuild): GraphNode {
  const target = ast ?? build.fn; // ENTRY/EXIT carry the whole callable's span
  const s = build.sf.getLineAndColumnAtPos(target.getStart());
  const e = build.sf.getLineAndColumnAtPos(target.getEnd());
  return { id, kind, start_line: s.line, start_column: s.column, end_line: e.line, end_column: e.column };
}

function hasRestParam(build: FunctionCfgBuild): boolean {
  const params = (build.fn as unknown as { getParameters?: () => Node[] }).getParameters?.() ?? [];
  const last = params[params.length - 1];
  return last !== undefined && Node.isParameterDeclaration(last) && last.isRestParameter();
}
