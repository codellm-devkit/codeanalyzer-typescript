/**
 * The level-3 `program_graphs` contract — CFG / PDG (CDG+DDG) / SDG, per the cross-language
 * dataflow-graphs spec. Emitted as an optional top-level section of analysis.json, only at
 * `-a 3`, scoped by `--graphs`.
 *
 * Node identity is the invariant that makes everything joinable: every node is keyed by
 * `(signature, node_id)` where `signature` is the SAME signatureOf() key used by symbol_table
 * and call_graph, and `node_id` is the index of the owning AST node in source-span order within
 * the callable (synthetic ENTRY = 0, EXIT = last). Cross-function edges reference both endpoints
 * that way, and — as with the call graph — may never dangle.
 *
 * The node-kind / edge-kind vocabulary below is shared across the CLDK analyzers (parity
 * clause); TS-specific members (`await_resume`, `yield`) are additive and recorded in
 * .claude/SCHEMA_DECISIONS.md.
 */

// Bumped independently of the top-level schema; additive changes only.
export const PROGRAM_GRAPHS_SCHEMA_VERSION = "1.0.0";

// ----------------------------------------------------------------------------------------------
// Nodes
// ----------------------------------------------------------------------------------------------

/**
 * CFG node kinds. `entry`/`exit` are synthetic (span = the whole callable); `param` nodes are the
 * formal-in nodes of the SDG (span = the parameter declaration); everything else is `statement`.
 */
export type GraphNodeKind = "entry" | "exit" | "param" | "statement";

export interface GraphNode {
  id: number;
  kind: GraphNodeKind;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
}

// ----------------------------------------------------------------------------------------------
// Intra-function edges
// ----------------------------------------------------------------------------------------------

/** CFG_NEXT edge kinds — the shared vocabulary plus the TS-native `await_resume` / `yield`. */
export type CfgEdgeKind =
  | "fallthrough"
  | "true"
  | "false"
  | "switch_case"
  | "loop_back"
  | "exception"
  | "return"
  | "break"
  | "continue"
  | "yield"
  | "await_resume";

export interface CfgEdge {
  source: number;
  target: number;
  kind: CfgEdgeKind;
}

/** PDG edge: control dependence (CDG) or data dependence (DDG, labeled with the access path). */
export interface PdgEdge {
  source: number;
  target: number;
  type: "CDG" | "DDG";
  /** The k-limited access path the dependence carries (DDG only). */
  var?: string;
}

export interface FunctionCfg {
  nodes: GraphNode[];
  edges: CfgEdge[];
}

export interface FunctionPdg {
  edges: PdgEdge[];
}

/** The per-callable graphs, keyed by the callable's canonical signature in `functions`. */
export interface FunctionGraphs {
  cfg?: FunctionCfg;
  pdg?: FunctionPdg;
}

// ----------------------------------------------------------------------------------------------
// Cross-function (SDG) edges
// ----------------------------------------------------------------------------------------------

export interface SdgEndpoint {
  signature: string;
  node: number;
}

/**
 * SDG edge types (Horwitz–Reps–Binkley):
 *  - CALL       callsite statement → callee ENTRY.
 *  - PARAM_IN   callsite statement → callee `param` node (`var` = "argN"), or → callee ENTRY for
 *               a module/global binding the callee transitively reads (`var` = the global path).
 *  - PARAM_OUT  callee EXIT → callsite statement (`var` = "return", or the global path written).
 *  - SUMMARY    actual-in → actual-out at the same call site. Call sites are collapsed onto their
 *               containing statement node, so SUMMARY edges are self-edges on the callsite node;
 *               `var` names the input ("argN" or a global path) that transitively flows to the
 *               call's result.
 */
export type SdgEdgeType = "CALL" | "PARAM_IN" | "PARAM_OUT" | "SUMMARY";

export interface SdgEdge {
  source: SdgEndpoint;
  target: SdgEndpoint;
  type: SdgEdgeType;
  var?: string;
}

// ----------------------------------------------------------------------------------------------
// Root section
// ----------------------------------------------------------------------------------------------

export interface ProgramGraphs {
  schema_version: string;
  /** The access-path depth bound (--graph-field-depth) the graphs were built with. */
  k_limit: number;
  functions: Record<string, FunctionGraphs>;
  /** Cross-function edges only; intra-function edges live in each function's pdg. */
  sdg_edges: SdgEdge[];
}

/** The `--graphs` selector values. `dfg` = the DDG subset of the PDG (no separate section). */
export type GraphSelector = "cfg" | "dfg" | "pdg" | "sdg";
export const ALL_GRAPHS: GraphSelector[] = ["cfg", "dfg", "pdg", "sdg"];
