import * as path from "node:path";
import { Command } from "commander";
import type { AnalysisOptions, OutputFormat } from "./options";

/** Parse argv (without node/script prefix) into normalized AnalysisOptions. See cli-contract.md. */
export function parseArgs(argv: string[]): AnalysisOptions {
  const program = new Command();
  program
    .name("cants")
    .description("CLDK TypeScript analyzer — emits the canonical analysis.json (symbol table + resolver call graph).")
    .requiredOption("-i, --input <path>", "project root to analyze")
    .option("-o, --output <dir>", "output directory for analysis.json (omit ⇒ compact JSON to stdout)")
    .option("-f, --format <fmt>", "output format: json | msgpack", "json")
    .option("-a, --analysis-level <n>", "analysis depth: 1 = symbol table + tsc resolver call graph + RTA (default); 2 = call graph", "1")
    .option("-t, --target-files <paths...>", "restrict analysis to specific files (incremental)")
    .option("--skip-tests", "skip test trees (default)")
    .option("--include-tests", "include test trees")
    .option("--eager", "force a clean rebuild instead of reusing the cache")
    .option("--lazy", "reuse the cache (default)")
    .option("--no-build", "skip dependency materialization (use a prepared node_modules)")
    .option("--no-phantoms", "disable phantom (external) nodes for imported/required library calls")
    .option("-c, --cache-dir <dir>", "cache/intermediate directory")
    .option("-v, --verbose", "increase verbosity (repeatable)", (_v: string, prev: number) => prev + 1, 0)
    .allowExcessArguments(true);

  program.parse(argv, { from: "user" });
  const o = program.opts();

  const level = String(o.analysisLevel) === "2" ? 2 : 1;
  const format: OutputFormat = o.format === "msgpack" ? "msgpack" : "json";
  const targets: string[] | null =
    Array.isArray(o.targetFiles) && o.targetFiles.length ? o.targetFiles.map(String) : null;

  return {
    input: path.resolve(String(o.input)),
    output: o.output ? path.resolve(String(o.output)) : null,
    format,
    analysisLevel: level,
    targetFiles: targets,
    skipTests: o.includeTests ? false : true,
    eager: Boolean(o.eager),
    // commander maps --no-build / --no-phantoms to opts.build/phantoms === false
    noBuild: o.build === false,
    phantoms: o.phantoms !== false,
    cacheDir: o.cacheDir ? path.resolve(String(o.cacheDir)) : null,
    verbosity: typeof o.verbose === "number" ? o.verbose : 0,
  };
}
