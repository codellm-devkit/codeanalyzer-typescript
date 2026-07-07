import type { GraphSelector } from "../schema";

export type EmitTarget = "json" | "neo4j" | "schema";
export type CallGraphProviderName = "union" | "tsc" | "jelly";

/** Normalized analysis options (produced by the CLI layer, consumed by core). */
export interface AnalysisOptions {
  /** Project root to analyze (absolute). */
  input: string;
  /** Output directory; null ⇒ print compact JSON to stdout (json emit only). */
  output: string | null;
  /** Output target: json (analysis.json, default) or neo4j (graph.cypher / live Bolt push). */
  emit: EmitTarget;
  /**
   * Output serialization format (`-f/--format`). Only "json" is implemented; msgpack is rejected
   * at the CLI layer (`parseArgs`), so it never reaches here — the type reflects that invariant.
   */
  format: "json";
  /** Logical application name for the graph's :Application anchor; null ⇒ derived from input. */
  appName: string | null;
  /** Bolt URI for a live Neo4j push (incremental). null ⇒ write a graph.cypher snapshot to -o. */
  neo4jUri: string | null;
  neo4jUser: string;
  neo4jPassword: string;
  neo4jDatabase: string | null;
  /**
   * Analysis depth requested by the caller (schema v2): 1 = symbol table (+ call sites);
   * 2 = + resolver call graph; 3 = + intraprocedural dataflow (cfg/cdg/ddg in the tree);
   * 4 = + interprocedural SDG (param_in/param_out/summary + synthetic vertices).
   */
  analysisLevel: 1 | 2 | 3 | 4;
  /** Which level-3 graph sections to emit (`--graphs`); only consulted at level 3. */
  graphs: GraphSelector[];
  /** k-limit for access-path depth in the level-3 dataflow (`--graph-field-depth`, default 3). */
  graphFieldDepth: number;
  /**
   * Worker parallelism for the level-3 pipeline (`-j/--jobs`). 0 = auto (currently sequential:
   * each extraction worker must materialize its own whole-program ts-morph project, which
   * measurably dominates the parallelizable graph math on small/mid repos); an explicit N ≥ 2
   * opts in for large codebases; 1 = fully sequential (the debug mode and differential oracle —
   * `--jobs N` output is byte-identical).
   */
  jobs: number;
  /** Restrict analysis to these files (project-relative or absolute). null ⇒ whole project. */
  targetFiles: string[] | null;
  /** Skip test trees (default true). */
  skipTests: boolean;
  /** Force a clean rebuild instead of reusing the cache. */
  eager: boolean;
  /** Skip dependency materialization (use a prepared node_modules). */
  noBuild: boolean;
  /** Emit phantom (external) nodes/edges for imported/required library call targets. Default on. */
  phantoms: boolean;
  /** Call-graph backend: union of tsc+jelly (default), tsc resolver only (--tsc-only), or jelly. */
  callGraphProvider: CallGraphProviderName;
  /** Where caches/intermediate state live; null ⇒ <input>/.codeanalyzer. */
  cacheDir: string | null;
  /** Verbosity (repeatable -v). */
  verbosity: number;
}
