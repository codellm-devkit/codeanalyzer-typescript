import type { GraphSelector } from "../schema";

export type EmitTarget = "json" | "neo4j" | "schema";
/** Default per-file byte cap for captured artifact text (256 KiB, python v1.3.0 parity). */

/** Normalized analysis options (produced by the CLI layer, consumed by core). */
export interface AnalysisOptions {
  /** Project root to analyze (absolute). */
  input: string;
  /** Output directory; null ⇒ print compact JSON to stdout (json emit only). */
  output: string | null;
  /** Output target: json (analysis.json, default) or neo4j (graph.cypher / live Bolt push). */
  emit: EmitTarget;
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
  /**
   * Restrict analysis to these PROGRAMS (#146) — each named by its SCOPE dir relative to
   * `input` (`<root>` for the input's own program). null ⇒ every program. Ownership is still computed against ALL discovered programs and filtered afterwards,
   * so a file owned by a deeper unselected tsconfig is excluded rather than reassigned.
   */
  programFilter: string[] | null;
  /** Print the discovered programs (one per line) and exit, for shard orchestration. */
  listPrograms?: boolean;
  /** Persist this shard's graph IR (`graphs_ir.ndjson`) so a later wave-2 stitch can read it. */
  emitIr?: boolean;
  /**
   * Skip the repository-artifact layer (artifacts/dependencies/unresolved_imports).
   *
   * Those sections are repo-scoped and level-free: they are derived from `--input`, not from the
   * analysed programs, so a `--program` shard recomputes ALL of them. On vscode that is the
   * difference between 28.75 GB and 39.16 GB for one shard, and under a full shard run it would
   * be paid 92 times over for a result that is identical every time. An orchestrator computes
   * them once and passes this on every other shard.
   */
  noRepoSections?: boolean;
  /** Skip test trees (default true). */
  skipTests: boolean;
  /** Force a clean rebuild instead of reusing the cache. */
  eager: boolean;
  /** Skip dependency materialization (use a prepared node_modules). */
  noBuild: boolean;
  /** Emit phantom (external) nodes/edges for imported/required library call targets. Default on. */
  phantoms: boolean;
  /** Where caches/intermediate state live; null ⇒ <input>/.codeanalyzer. */
  /** Opt-in: probe node_modules metadata for import→package binding (prov "installed-metadata"). */
  resolveInstalled?: boolean;
  /** Capture verbatim artifact text into `source` (default true). */
  artifactText?: boolean;
  /** Per-file byte cap for captured text; larger files store a flagged prefix. */
  artifactTextMaxBytes?: number;
  cacheDir: string | null;
  /** Verbosity (repeatable -v). */
  verbosity: number;
}
