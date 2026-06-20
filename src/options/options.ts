export type EmitTarget = "json" | "neo4j" | "schema";
export type CallGraphProviderName = "tsc" | "jelly" | "both";

/** Normalized analysis options (produced by the CLI layer, consumed by core). */
export interface AnalysisOptions {
  /** Project root to analyze (absolute). */
  input: string;
  /** Output directory; null ⇒ print compact JSON to stdout (json emit only). */
  output: string | null;
  /** Output target: json (analysis.json, default) or neo4j (graph.cypher / live Bolt push). */
  emit: EmitTarget;
  /** Logical application name for the graph's :TSApplication anchor; null ⇒ derived from input. */
  appName: string | null;
  /** Bolt URI for a live Neo4j push (incremental). null ⇒ write a graph.cypher snapshot to -o. */
  neo4jUri: string | null;
  neo4jUser: string;
  neo4jPassword: string;
  neo4jDatabase: string | null;
  /** Analysis depth requested by the caller (1 = symbol table + call graph [default]; 2 = call graph). */
  analysisLevel: 1 | 2;
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
  /** Which call-graph backend to use: tsc resolver (default), jelly (cs-au-dk), or both (diff). */
  callGraphProvider: CallGraphProviderName;
  /** Where caches/intermediate state live; null ⇒ <input>/.codeanalyzer. */
  cacheDir: string | null;
  /** Verbosity (repeatable -v). */
  verbosity: number;
}
