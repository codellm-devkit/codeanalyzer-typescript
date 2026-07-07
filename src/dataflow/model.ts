/**
 * Internal working model shared by the level-3 dataflow stages. The emitted shapes live in
 * schema/graphs.ts.
 *
 * Two tiers, split along the worker boundary:
 *  - `FunctionCfgBuild` is AST-linked (ts-morph nodes) and never leaves the thread that parsed.
 *  - `CallableGraphData` is the plain-data projection of everything downstream stages need —
 *    structured-clone/JSON-safe, so stage-1–4 extraction can fan out over a worker pool and the
 *    summary wavefront can run on data alone (no AST access after extraction).
 */
import type { Node, SourceFile } from "ts-morph";
import type { CfgEdge, GraphNode, GraphNodeKind, PdgEdge } from "../schema";

// ------------------------------------------------------------------------------------------------
// AST-linked build product (stage 1, thread-local)
// ------------------------------------------------------------------------------------------------

/** A CFG node with its AST link. `ast` is null only for the synthetic ENTRY/EXIT pair. */
export interface DfNode {
  id: number;
  kind: GraphNodeKind;
  ast: Node | null;
}

/** The per-callable CFG build product (stage 1), input to fact extraction. */
export interface FunctionCfgBuild {
  signature: string;
  /** The function-like AST node (FunctionDeclaration / Method / Ctor / accessor / arrow / fn-expr). */
  fn: Node;
  sf: SourceFile;
  /** Ordered by id; nodes[0] is ENTRY, nodes[nodes.length - 1] is EXIT. */
  nodes: DfNode[];
  edges: CfgEdge[];
  entryId: number;
  exitId: number;
  /** node ids of the `param` nodes, in declaration order (the SDG formal-in nodes). */
  paramIds: number[];
}

// ------------------------------------------------------------------------------------------------
// Access paths (plain data — labels every DDG edge and summary entry)
// ------------------------------------------------------------------------------------------------

export type BaseKind = "local" | "param" | "this" | "captured" | "module";

export interface PathRef {
  /** Unique base identity: decl-position for locals/params/captured, canonical path for module, "this". */
  key: string;
  /** Human label for the base (the variable name / canonical module path). */
  label: string;
  baseKind: BaseKind;
  fields: string[]; // "f" | "[*]" | "*" (trailing truncation star)
}

export function renderPath(p: PathRef): string {
  let s = p.label;
  for (const f of p.fields) s += f === "[*]" ? "[*]" : `.${f}`;
  return s;
}

/** A global (module-binding) path as carried by summaries: canonical base + fields. */
export interface GlobalPath {
  key: string; // == the canonical `<modulePrefix>.<name>` label
  fields: string[];
}

export function renderGlobal(g: GlobalPath): string {
  return renderPath({ key: g.key, label: g.key, baseKind: "module", fields: g.fields });
}

/** May two field lists overlap? "*" (truncation) matches any tail; "[*]" matches any one step. */
export function fieldsMayAlias(a: string[], b: string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x === "*" || y === "*") return true;
    if (x === "[*]" || y === "[*]") continue; // dynamic index may hit any member
    if (x !== y) return false;
  }
  return true; // one path is a prefix of the other (whole-object vs member)
}

// ------------------------------------------------------------------------------------------------
// Per-node dataflow facts (plain data)
// ------------------------------------------------------------------------------------------------

export interface DefFact {
  ref: PathRef;
  /** Strong defs kill; only whole-base writes of locals/params qualify (field writes are weak). */
  strong: boolean;
}

export interface NodeFacts {
  defs: DefFact[];
  uses: PathRef[];
}

/** Transitive global effects of a call, applied at its callsite node during the solve. */
export interface CallEffects {
  reads: GlobalPath[];
  writes: GlobalPath[];
}

// ------------------------------------------------------------------------------------------------
// The serializable per-callable projection (crosses the worker boundary)
// ------------------------------------------------------------------------------------------------

/**
 * Everything stages 5–8 and emission need, as plain data: the emitted CFG (nodes carry source
 * spans, not AST links), the CDG, the extracted per-node facts, the copy-alias pairs, and the
 * structural metadata. Producing this once per callable is the AST-bound work; every fixpoint
 * iteration after it is pure data.
 */
export interface CallableGraphData {
  signature: string;
  /** Owning module file key (project-relative POSIX path with extension). */
  path: string;
  /** Emitted-shape nodes, index == id (ENTRY first, EXIT last). */
  nodes: GraphNode[];
  edges: CfgEdge[];
  /** Control-dependence edges (stage 2), computed at extraction time. */
  cdg: PdgEdge[];
  entryId: number;
  exitId: number;
  paramIds: number[];
  hasRestParam: boolean;
  /** Extracted defs/uses per node id (pairs, for clone-safety). */
  facts: Array<[number, NodeFacts]>;
  /** Copy-alias unions discovered during extraction (`const q = p`). */
  aliasPairs: Array<[string, string]>;
  /** Nodes that produce the function's return value. */
  returnValueNodes: number[];
}

/** Successor/predecessor adjacency over serialized CFG edges. */
export function dataAdjacency(data: CallableGraphData): { succ: Map<number, number[]>; pred: Map<number, number[]> } {
  const succ = new Map<number, number[]>();
  const pred = new Map<number, number[]>();
  for (const n of data.nodes) {
    succ.set(n.id, []);
    pred.set(n.id, []);
  }
  for (const e of data.edges) {
    succ.get(e.source)?.push(e.target);
    pred.get(e.target)?.push(e.source);
  }
  return { succ, pred };
}
