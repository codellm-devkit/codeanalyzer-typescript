import * as path from "node:path";
import { buildProgramGraphs, startExtraction } from "./dataflow";
import { mergeCallGraphs, tscProvider } from "./semantic_analysis";
import { loadCache, saveCache } from "./utils";
import { materialize } from "./build";
import type { AnalysisOptions } from "./options";
import type { AnalysisInternal } from "./schema";
import { type AnalysisResult, finalizeAnalysis } from "./schema/emit";
import { buildSymbolTable } from "./syntactic_analysis";
import { Logger } from "./utils";

export type { AnalysisResult } from "./schema/emit";

/**
 * The orchestrator. Order mirrors the reference analyzers (python core.py): materialize deps →
 * build the symbol table → call-graph providers → program graphs → cache the id-free base →
 * run the per-run pass spine (ids / body / heritage / homing / callees / attach) and assemble
 * the wire envelope. Returns BOTH views: the wire `application` and the live `internal` tree.
 */
export async function analyze(opts: AnalysisOptions): Promise<AnalysisResult> {
  const log = new Logger(opts.verbosity);
  log.info(`analyzing ${opts.input} (level ${opts.analysisLevel})`);
  const cacheDir = opts.cacheDir ?? path.join(opts.input, ".codeanalyzer");

  const mat = materialize(opts, log);
  for (const note of mat.notes) log.debug(note);

  const cached = opts.eager ? null : loadCache(cacheDir);
  const { project, symbol_table, programs } = buildSymbolTable(opts, mat, cached?.symbol_table ?? null, log);

  // Level 3: post stage-1–4 graph extraction to the worker pool BEFORE the call-graph solve —
  // extraction doesn't need callee resolution, so the two run concurrently (the contract's
  // "points-to solve runs concurrently with stages 1–4") and join in buildProgramGraphs.
  //
  // Multi-program (#56) NOTE: each BuiltProgram carries its owning tsconfig (`configPath`), so the
  // file→program config map exists here. Threading it per-file into the dataflow workers (each
  // builds its own Project from ONE tsconfig, src/dataflow/worker.ts) is deferred: extraction still
  // uses the root program's config, so at L3 files in a NESTED program are analyzed with the root
  // options. Documented limitation — L2 call-graph resolution (the #56 gate) is fully per-program.
  if (opts.analysisLevel >= 3 && programs.length > 1) {
    log.warn(`L3 dataflow uses the root tsconfig for all ${programs.length} programs; nested-program files may under-resolve (see #56)`);
  }
  const extraction = opts.analysisLevel >= 3 ? startExtraction(project, symbol_table, mat.tsConfigFilePath, opts, log) : null;

  // Call graph: the tsc resolver, per program (each with its own Project + its slice of callables
  // via `only`), merged across programs. Only worth running at level >= 2: finalizeAnalysis
  // discards call_graph/external_symbols/synthesized_callables at -a 1 (homeExternals/
  // homeSynthesized in src/schema/emit.ts are gated to `level >= 2`), so running the solve at
  // -a 1 would compute a result that's thrown away. Levels 3/4 need it for callee resolution and
  // are always >= 2, so this gate is safe. Signature gating uses the full merged symbol_table
  // (passed to every program), so a cross-program in-project call resolves.
  let cg: ReturnType<typeof tscProvider.build> = { edges: [], external_symbols: {}, synthesized_callables: {} };
  if (opts.analysisLevel >= 2) {
    for (const prog of programs) {
      const pcg = tscProvider.build({
        project: prog.project,
        symbol_table,
        root: opts.input,
        log,
        phantoms: opts.phantoms,
        only: prog.fileKeys,
      });
      cg = mergeCallGraphs(cg, pcg);
    }
  }
  const call_graph = cg.edges;

  const app: AnalysisInternal = {
    symbol_table,
    call_graph,
    external_symbols: cg.external_symbols,
    synthesized_callables: cg.synthesized_callables,
  };

  // Level 3 join: stages 5–7 (summary wavefront + SDG) consume the extraction AND the
  // provider-backfilled callee signatures. Strictly flag-gated so -a 1/-a 2 cost nothing.
  const pg = extraction ? await buildProgramGraphs(extraction, symbol_table, opts, log) : null;

  // Cache the id-free base (ids/body/heritage are per-run layers stamped by finalizeAnalysis;
  // the cached tree must stay --app-name-free).
  saveCache(cacheDir, { symbol_table });
  return finalizeAnalysis(app, pg, opts);
}
