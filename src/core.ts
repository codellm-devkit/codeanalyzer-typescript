import * as path from "node:path";
import { buildProgramGraphs, startExtraction } from "./dataflow";
import { selectProvider } from "./semantic_analysis";
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
export async function analyze(opts: AnalysisOptions): Promise<TSApplication> {
  const log = new Logger(opts.verbosity);
  log.info(`analyzing ${opts.input} (level ${opts.analysisLevel})`);
  const cacheDir = opts.cacheDir ?? path.join(opts.input, ".codeanalyzer");

  const mat = materialize(opts, log);
  for (const note of mat.notes) log.debug(note);

  const cached = opts.eager ? null : loadCache(cacheDir);
  const { project, symbol_table } = buildSymbolTable(opts, mat, cached?.symbol_table ?? null, log);

  // Level 3: post stage-1–4 graph extraction to the worker pool BEFORE the call-graph solve —
  // extraction doesn't need callee resolution, so the two run concurrently (the contract's
  // "points-to solve runs concurrently with stages 1–4") and join in buildProgramGraphs.
  const extraction = opts.analysisLevel >= 3 ? startExtraction(project, symbol_table, mat.tsConfigFilePath, opts, log) : null;

  // Call graph via the selected provider (union of tsc+jelly by default; --tsc-only / jelly opt-in).
  const provider = selectProvider(opts.callGraphProvider);
  log.info(`call graph provider: ${provider.name}`);
  const cg = provider.build({ project, symbol_table, root: opts.input, log, phantoms: opts.phantoms });
  const call_graph = cg.edges;

  const app: TSApplication = {
    symbol_table,
    call_graph,
    external_symbols: cg.external_symbols,
    synthesized_callables: cg.synthesized_callables,
  };

  // Level 3 join: stages 5–7 (summary wavefront + SDG) consume the extraction AND the
  // provider-backfilled callee signatures. Strictly flag-gated so -a 1/-a 2 cost nothing.
  if (extraction) {
    app.program_graphs = await buildProgramGraphs(extraction, symbol_table, opts, log);
  }

  saveCache(cacheDir, { symbol_table, call_graph });
  return app;
}
