import * as path from "node:path";
import { Command } from "commander";
import type { AnalysisOptions, CallGraphProviderName, EmitTarget } from "./options";

/**
 * Build the commander program. Shared by parseArgs and by the README generator
 * (scripts/update-readme.ts), which reads `program.helpInformation()` so the documented
 * `cants --help` block can never drift from the actual CLI.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("cants")
    .description("CLDK TypeScript analyzer — emits the canonical analysis.json (symbol table + resolver call graph), or a Neo4j graph.")
    .option("-i, --input <path>", "project root to analyze (not required for --emit schema)")
    .option("-o, --output <dir>", "output directory (omit ⇒ compact output to stdout)")
    .option("--emit <target>", "output target: json (analysis.json, default) | neo4j (graph.cypher or live push) | schema (the Neo4j schema.json contract)", "json")
    .option("--app-name <name>", "logical application name for the graph :Application anchor (default: input dir name)")
    .option("--neo4j-uri <uri>", "push the graph to a live Neo4j over Bolt (incremental); omit to write graph.cypher")
    .option("--neo4j-user <user>", "Neo4j username", "neo4j")
    .option("--neo4j-password <password>", "Neo4j password", "neo4j")
    .option("--neo4j-database <db>", "Neo4j database name (default: server default)")
    .option("-a, --analysis-level <n>", "analysis depth: 1 = symbol table + tsc resolver call graph + RTA (default); 2 = call graph", "1")
    .option("-t, --target-files <paths...>", "restrict analysis to specific files (incremental)")
    .option("--skip-tests", "skip test trees (default)")
    .option("--include-tests", "include test trees")
    .option("--eager", "force a clean rebuild instead of reusing the cache")
    .option("--lazy", "reuse the cache (default)")
    .option("--no-build", "skip dependency materialization (use a prepared node_modules)")
    .option("--no-phantoms", "disable phantom (external) nodes for imported/required library calls")
    .option("--call-graph-provider <name>", "call-graph backend: tsc (default) | jelly | both", "tsc")
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

  const level = String(o.analysisLevel) === "2" ? 2 : 1;
  const emit: EmitTarget = o.emit === "neo4j" ? "neo4j" : o.emit === "schema" ? "schema" : "json";
  // --emit schema is a static artifact and needs no project; every other target requires -i.
  if (emit !== "schema" && !o.input) program.error("required option '-i, --input <path>' not specified");
  const targets: string[] | null =
    Array.isArray(o.targetFiles) && o.targetFiles.length ? o.targetFiles.map(String) : null;
  const cgProvider: CallGraphProviderName =
    o.callGraphProvider === "jelly" ? "jelly" : o.callGraphProvider === "both" ? "both" : "tsc";

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
    targetFiles: targets,
    skipTests: o.includeTests ? false : true,
    eager: Boolean(o.eager),
    // commander maps --no-build / --no-phantoms to opts.build/phantoms === false
    noBuild: o.build === false,
    phantoms: o.phantoms !== false,
    callGraphProvider: cgProvider,
    cacheDir: o.cacheDir ? path.resolve(String(o.cacheDir)) : null,
    verbosity: typeof o.verbose === "number" ? o.verbose : 0,
  };
}
