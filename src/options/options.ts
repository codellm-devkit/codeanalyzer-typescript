export type OutputFormat = "json" | "msgpack";

/** Normalized analysis options (produced by the CLI layer, consumed by core). */
export interface AnalysisOptions {
  /** Project root to analyze (absolute). */
  input: string;
  /** Output directory for analysis.json; null ⇒ print compact JSON to stdout. */
  output: string | null;
  format: OutputFormat;
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
  /** Where caches/intermediate state live; null ⇒ <input>/.codeanalyzer. */
  cacheDir: string | null;
  /** Verbosity (repeatable -v). */
  verbosity: number;
}
