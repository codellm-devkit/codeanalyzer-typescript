import * as path from "node:path";
import { buildCallGraph } from "./semantic_analysis";
import { loadCache, saveCache } from "./utils";
import { materialize } from "./build";
import type { AnalysisOptions } from "./options";
import type { TSApplication } from "./schema";
import { buildSymbolTable } from "./syntactic_analysis";
import { Logger } from "./utils";

/**
 * The orchestrator. Order mirrors the reference analyzers: materialize deps → build the symbol
 * table → build the resolver call graph → cache the base → return the Application.
 */
export function analyze(opts: AnalysisOptions): TSApplication {
  const log = new Logger(opts.verbosity);
  log.info(`analyzing ${opts.input} (level ${opts.analysisLevel})`);
  const cacheDir = opts.cacheDir ?? path.join(opts.input, ".codeanalyzer");

  const mat = materialize(opts, log);
  for (const note of mat.notes) log.debug(note);

  const cached = opts.eager ? null : loadCache(cacheDir);
  const { project, symbol_table } = buildSymbolTable(opts, mat, cached?.symbol_table ?? null, log);

  // The tsc (ts-morph checker) resolver call graph + RTA + phantom external nodes.
  const cg = buildCallGraph(project, symbol_table, opts.input, log, opts.phantoms);
  const call_graph = cg.edges;

  const app: TSApplication = {
    symbol_table,
    call_graph,
    external_symbols: cg.external_symbols,
    entrypoints: {},
  };
  saveCache(cacheDir, { symbol_table, call_graph });
  return app;
}
