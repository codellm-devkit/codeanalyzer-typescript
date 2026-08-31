import * as path from "node:path";
import { Command, Option } from "commander";
import type { AnalysisOptions, EmitTarget } from "./options";
import { DEFAULT_ARTIFACT_TEXT_MAX_BYTES } from "./options";
import { ALL_GRAPHS, type GraphSelector } from "./schema";

/**
 * Build the commander program. Shared by parseArgs and by the README generator
 * (scripts/update-readme.ts), which reads `program.helpInformation()` so the documented
 * `cants --help` block can never drift from the actual CLI.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("cants")
    .description("CLDK TypeScript analyzer — emits the canonical schema-v2 CPG (symbol table → call graph → dataflow → SDG) as analysis.json, or a Neo4j graph.")
    .option("-i, --input <path>", "project root to analyze (not required for --emit schema)")
    .option("-o, --output <dir>", "output directory (omit ⇒ compact output to stdout)")
    .option("--emit <target>", "output target: json (analysis.json, default) | neo4j (graph.cypher or live push) | schema (the Neo4j schema.json contract)", "json")
    .option("--app-name <name>", "logical application name for the graph :Application anchor (default: input dir name)")
    // The four Neo4j connection options also read the standard NEO4J_* environment variables when
    // the flag is omitted (an explicit flag wins). Prefer NEO4J_PASSWORD over the flag — a flag
    // value is visible in shell history / the process list. Commander renders the `(env: …)` hint.
    .addOption(
      new Option(
        "--neo4j-uri <uri>",
        "push the graph to a live Neo4j over Bolt (incremental); omit to write graph.cypher",
      ).env("NEO4J_URI"),
    )
    .addOption(new Option("--neo4j-user <user>", "Neo4j username").env("NEO4J_USERNAME").default("neo4j"))
    .addOption(
      new Option(
        "--neo4j-password <password>",
        "Neo4j password (prefer the env var; a flag is visible in shell history / process list)",
      )
        .env("NEO4J_PASSWORD")
        .default("neo4j"),
    )
    .addOption(new Option("--neo4j-database <db>", "Neo4j database name").env("NEO4J_DATABASE"))
    .option(
      "-a, --analysis-level <n>",
      "analysis depth: 1 = symbol table (default); 2 = + resolver call graph; 3 = + intraprocedural dataflow (cfg/cdg/ddg); 4 = + interprocedural SDG (param_in/param_out/summary)",
      "1",
    )
    .option(
      "--graphs <list>",
      "dataflow sections to emit, comma-separated: cfg | dfg | pdg (require -a 3) | sdg (requires -a 4); default: all rungs at or below the level",
    )
    .option("--graph-field-depth <k>", "access-path depth bound (k-limit) for level-3 dataflow", "3")
    .option(
      "-j, --jobs <n>",
      "worker parallelism for level-3 graphs (default: sequential; opt in with N ≥ 2 on large projects — each worker loads its own copy of the program)",
    )
    .option("-t, --target-files <paths...>", "restrict analysis to specific files (incremental)")
    .option("--skip-tests", "skip test trees (default)")
    .option("--include-tests", "include test trees")
    .option("--eager", "force a clean rebuild instead of reusing the cache")
    .option("--lazy", "reuse the cache (default)")
    .option("--no-build", "skip dependency materialization (use a prepared node_modules)")
    .option("--no-phantoms", "disable phantom (external) nodes for imported/required library calls")
    .option("--resolve-installed", "probe node_modules metadata for import→package binding (default: repo files only)")
    .option("--no-artifact-text", "keep the artifact inventory but drop captured raw text")
    .option(
      "--artifact-text-max-bytes <n>",
      "per-file byte cap for captured artifact text; larger files are truncated and flagged",
      String(DEFAULT_ARTIFACT_TEXT_MAX_BYTES),
    )
    .option("-c, --cache-dir <dir>", "cache/intermediate directory")
    .option("-v, --verbose", "increase verbosity (repeatable)", (_v: string, prev: number) => prev + 1, 0)
    .allowExcessArguments(true);
  return program;
}

/** Parse argv (without node/script prefix) into normalized AnalysisOptions. See cli-contract.md. */
export function parseArgs(argv: string[]): AnalysisOptions {
  const program = buildProgram();
  program.parse(argv, { from: "user" });
  const o = program.opts();

  const levelStr = String(o.analysisLevel);
  if (!["1", "2", "3", "4"].includes(levelStr)) {
    program.error(`error: invalid --analysis-level '${levelStr}' (expected 1, 2, 3, or 4)`);
  }
  let level = Number(levelStr) as 1 | 2 | 3 | 4;

  // --emit target (needed early: the graph is always full-depth, so -a/--graphs are forbidden with it).
  // Strict validation — an unrecognized value must error, never silently fall back to json.
  const emitRaw = String(o.emit ?? "json");
  if (!["json", "neo4j", "schema"].includes(emitRaw)) {
    program.error(`error: invalid --emit '${emitRaw}' (expected: json, neo4j, schema)`);
  }
  const emit = emitRaw as EmitTarget;
  if (emit === "neo4j") {
    if (levelStr !== "1") {
      program.error("error: --analysis-level does not apply to --emit neo4j; the graph is always projected at full depth");
    }
    if (o.graphs !== undefined) {
      program.error("error: --graphs does not apply to --emit neo4j; the graph is always projected at full depth");
    }
    level = 4; // force max implemented depth so the projected graph is the full CPG
  }

  // --graphs: strict validation (never a silent fallback). Default = all rungs at or below the level;
  // cfg/dfg/pdg require -a 3, sdg requires -a 4.
  let graphs: GraphSelector[] = level >= 4 ? [...ALL_GRAPHS] : level === 3 ? ["cfg", "dfg", "pdg"] : [];
  if (o.graphs !== undefined) {
    if (level < 3) program.error("error: --graphs requires --analysis-level 3 or 4");
    const requested = String(o.graphs)
      .split(",")
      .map((g) => g.trim())
      .filter((g) => g.length > 0);
    if (!requested.length) program.error("error: --graphs requires at least one of: cfg, dfg, pdg, sdg");
    for (const g of requested) {
      if (!(ALL_GRAPHS as string[]).includes(g)) {
        program.error(`error: unknown --graphs value '${g}' (expected: cfg, dfg, pdg, sdg)`);
      }
      if (g === "sdg" && level < 4) program.error("error: --graphs sdg requires --analysis-level 4");
    }
    graphs = [...new Set(requested)] as GraphSelector[];
  }

  const kStr = String(o.graphFieldDepth);
  const k = Number(kStr);
  if (!Number.isInteger(k) || k < 1) {
    program.error(`error: invalid --graph-field-depth '${kStr}' (expected a positive integer)`);
  }

  // -j/--jobs: explicit value must be a positive integer; omitted ⇒ 0 = auto, resolved against
  // the project size at extraction time (see startExtraction).
  let jobs = 0;
  if (o.jobs !== undefined) {
    const j = Number(String(o.jobs));
    if (!Number.isInteger(j) || j < 1) {
      program.error(`error: invalid --jobs '${String(o.jobs)}' (expected a positive integer)`);
    }
    jobs = j;
  }
  // --emit schema is a static artifact and needs no project; every other target requires -i.
  if (emit !== "schema" && !o.input) program.error("required option '-i, --input <path>' not specified");
  const targets: string[] | null =
    Array.isArray(o.targetFiles) && o.targetFiles.length ? o.targetFiles.map(String) : null;
  return {
    input: o.input ? path.resolve(String(o.input)) : "",
    output: o.output ? path.resolve(String(o.output)) : null,
    emit,
    appName: o.appName ? String(o.appName) : null,
    neo4jUri: o.neo4jUri ? String(o.neo4jUri) : null,
    neo4jUser: String(o.neo4jUser),
    neo4jPassword: String(o.neo4jPassword),
    neo4jDatabase: o.neo4jDatabase ? String(o.neo4jDatabase) : null,
    analysisLevel: level,
    graphs,
    graphFieldDepth: k,
    jobs,
    targetFiles: targets,
    skipTests: o.includeTests ? false : true,
    eager: Boolean(o.eager),
    // commander maps --no-build / --no-phantoms to opts.build/phantoms === false
    noBuild: o.build === false,
    phantoms: o.phantoms !== false,
    resolveInstalled: Boolean(o.resolveInstalled),
    artifactText: o.artifactText !== false,
    artifactTextMaxBytes: Number(o.artifactTextMaxBytes ?? DEFAULT_ARTIFACT_TEXT_MAX_BYTES),
    cacheDir: o.cacheDir ? path.resolve(String(o.cacheDir)) : null,
    verbosity: typeof o.verbose === "number" ? o.verbose : 0,
  };
}
