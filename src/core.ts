import * as path from "node:path";
import { buildProgramGraphs, startExtraction } from "./dataflow";
import { type LinkerResolutions, mergeCallGraphs, runDefuseLinker, tscProvider } from "./semantic_analysis";
import { loadCache, saveCache } from "./utils";
import { materialize } from "./build";
import { inventoryArtifacts } from "./artifacts";
import type { AnalysisOptions } from "./options";
import type { AnalysisInternal } from "./schema";
import { type AnalysisResult, finalizeAnalysis } from "./schema/emit";
import { buildSymbolTable } from "./syntactic_analysis";
import { Logger } from "./utils";
import { checkerFailures, resetCheckerFailures } from "./schema/checker";

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
  resetCheckerFailures();
  const cacheDir = opts.cacheDir ?? path.join(opts.input, ".codeanalyzer");

  const mat = materialize(opts, log);
  for (const note of mat.notes) log.debug(note);

  const cached = opts.eager ? null : loadCache(cacheDir);
  const { project, symbol_table, programs } = buildSymbolTable(opts, mat, cached?.symbol_table ?? null, log);

  // Level 3: post stage-1–4 graph extraction to the worker pool BEFORE the call-graph solve —
  // extraction doesn't need callee resolution, so the two run concurrently (the contract's
  // "points-to solve runs concurrently with stages 1–4") and join in buildProgramGraphs.
  //
  // Multi-program: extraction resolves each callable under the tsconfig that OWNS its file, the
  // same assignment the symbol table and the L2 call graph use (#111). It used to index the whole
  // repo against the root program alone, which silently skipped every callable a deeper program
  // owned.

  // Call graph: the tsc resolver, per program (each with its own Project + its slice of callables
  // via `only`), merged across programs. Only worth running at level >= 2: finalizeAnalysis
  // discards call_graph/external_symbols/synthesized_callables at -a 1 (homeExternals/
  // homeSynthesized in src/schema/emit.ts are gated to `level >= 2`), so running the solve at
  // -a 1 would compute a result that's thrown away. Levels 3/4 need it for callee resolution and
  // are always >= 2, so this gate is safe. Signature gating uses the full merged symbol_table
  // (passed to every program), so a cross-program in-project call resolves.
  let cg: ReturnType<typeof tscProvider.build> = { edges: [], external_symbols: {}, synthesized_callables: {} };
  const resolutions: LinkerResolutions = new Map();
  if (opts.analysisLevel >= 2) {
    for (const prog of programs) {
      const ctx = {
        project: prog.project,
        symbol_table,
        root: opts.input,
        log,
        phantoms: opts.phantoms,
        only: prog.fileKeys,
      };
      cg = mergeCallGraphs(cg, tscProvider.build(ctx));
      // The defuse linker overlays the tsc base: it reads the callee_signature backfill the tsc
      // leg just wrote, resolves what remains (tiers T1–T5, defuseLinker.ts), and returns its
      // body-node resolutions out-of-band (never persisted — cache provenance rule).
      const linked = runDefuseLinker(ctx);
      cg = mergeCallGraphs(cg, linked.result);
      for (const [caller, m] of linked.resolutions) {
        const ex = resolutions.get(caller);
        if (!ex) resolutions.set(caller, m);
        else for (const [k, v] of m) if (!ex.has(k)) ex.set(k, v);
      }
    }
  }
  // Extraction runs AFTER the solve, not concurrently with it (#112). The two only ever
  // overlapped under `-j N > 1` -- at the default `-j 1` startExtraction evaluates
  // extractSequential eagerly, so they were already serial. Ordering them explicitly lets
  // extraction be the LAST reader of each program's Project, which is what makes disposal safe:
  // on a repo with many programs, holding all of them materialised is what exhausted the heap.
  const extraction =
    opts.analysisLevel >= 3 ? startExtraction(programs, symbol_table, opts, log, project) : null;

  const call_graph = cg.edges;

  // Repository-artifact layer (#101, python PR #160 parity): level-free, identical at every -a.
  const layer = inventoryArtifacts(opts.input, opts, symbol_table);
  log.info(
    `artifacts: ${Object.keys(layer.artifacts).length} files, ${layer.dependencies.length} dependency records, ` +
      `${layer.unresolved_imports.length} unresolved imports`,
  );

  const app: AnalysisInternal = {
    symbol_table,
    call_graph,
    external_symbols: cg.external_symbols,
    synthesized_callables: cg.synthesized_callables,
    artifacts: layer.artifacts,
    dependencies: layer.dependencies,
    unresolved_imports: layer.unresolved_imports,
  };

  // Level 3 join: stages 5–7 (summary wavefront + SDG) consume the extraction AND the
  // provider-backfilled callee signatures. Strictly flag-gated so -a 1/-a 2 cost nothing.
  const pg = extraction ? await buildProgramGraphs(extraction, symbol_table, opts, log) : null;

  // Cache the id-free base (ids/body/heritage are per-run layers stamped by finalizeAnalysis;
  // the cached tree must stay --app-name-free).
  saveCache(cacheDir, { symbol_table });
  // Never let "some edges are missing" look like "there were no edges": a node the checker could
  // not resolve is skipped (see schema/checker.ts), and the count is said out loud.
  const skipped = checkerFailures();
  if (skipped) log.warn(`${skipped} symbol resolution(s) skipped — the TypeScript checker could not resolve them; affected call edges are absent`);
  return finalizeAnalysis(app, pg, opts, resolutions, project);
}
