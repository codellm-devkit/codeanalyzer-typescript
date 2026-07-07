/**
 * Level 3 — the program-graphs pipeline (stages 1–7 of the dataflow contract), run only at
 * `-a 3` after the symbol table exists, structured for the contract's parallel execution model:
 *
 *   startExtraction (stages 1–4)   — embarrassingly parallel per callable: fanned out over a
 *                                    Bun worker pool, partitioned by file. Kicked off BEFORE the
 *                                    call-graph solve on the main thread (core.ts), so the two
 *                                    run concurrently and join before summaries.
 *   buildProgramGraphs (stages 5–7) — joins the extraction, maps call sites onto nodes (needs
 *                                    the provider-backfilled callee signatures), then composes
 *                                    summaries as a Kahn-style ready-queue WAVEFRONT over the
 *                                    Tarjan SCC condensation DAG: an SCC dispatches the moment
 *                                    its callee SCCs are done; the SCC (its internal fixpoint)
 *                                    is the atomic unit, one worker each. SDG assembly and
 *                                    emission close it out.
 *
 * `--jobs 1` is the fully sequential debug mode (no workers, main-thread project reused, SCCs
 * processed in Tarjan order) and the differential oracle: `--jobs N` must emit byte-identical
 * output, which holds because ids are span-ordered (never discovery-ordered), every edge list is
 * collect-then-sorted, and sccFixpoint is a pure function of its inputs. Worker failure at any
 * point degrades to the sequential path — parallelism is an optimization, not a dependency.
 *
 * Summaries (with their callee dependency edges and the owning module's content hash) are
 * persisted to `<cache_dir>/graphs_summaries.json` — recorded from day one so incremental
 * re-analysis can later consume them; nothing reads them yet.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Project } from "ts-morph";
import type { AnalysisOptions } from "../options";
import {
  PROGRAM_GRAPHS_SCHEMA_VERSION,
  fileKeyOf,
  type FunctionGraphs,
  type GraphNode,
  type PdgEdge,
  type ProgramGraphs,
  type TSCallable,
  type TSCallsite,
  type TSClass,
  type TSModule,
  type TSNamespace,
} from "../schema";
import type { Logger } from "../utils";
import { extractCallableData, indexCallableDecls } from "./extract";
import type { CallableGraphData } from "./model";
import { WorkerPool } from "./pool";
import { assembleSdg } from "./sdg";
import {
  callAdjacency,
  sccFixpoint,
  tarjanSccs,
  type CallSiteRef,
  type FunctionSummary,
} from "./summaries";
import type { ExtractTask, SolveTask, SolveTaskResult } from "./worker";

export { backwardSlice, type SliceCriterion } from "./slice";

// ------------------------------------------------------------------------------------------------
// Stage 1–4 extraction (started early so it overlaps the call-graph solve)
// ------------------------------------------------------------------------------------------------

export interface ExtractionHandle {
  promise: Promise<Map<string, CallableGraphData>>;
  pool: WorkerPool | null;
}

export function startExtraction(
  project: Project,
  symbol_table: Record<string, TSModule>,
  tsConfigFilePath: string | null,
  opts: AnalysisOptions,
  log: Logger,
): ExtractionHandle {
  const callables = collectCallables(symbol_table);

  // Partition callables by owning file (round-robin over the sorted file list) so each worker
  // deeply visits only its share of the program. TSCallable.path is the declaration's ABSOLUTE
  // file path; the graph data carries the project-relative file key.
  const byFile = new Map<string, Array<{ signature: string; path: string; absPath: string }>>();
  for (const [sig, c] of [...callables.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const absPath = c.path;
    const arr = byFile.get(absPath) ?? [];
    arr.push({ signature: sig, path: fileKeyOf(absPath, opts.input).fileKey, absPath });
    byFile.set(absPath, arr);
  }
  const files = [...byFile.keys()].sort();

  // Auto (0) resolves to sequential: each extraction worker must materialize its own
  // whole-program ts-morph project (ASTs can't cross the clone boundary), and measurement shows
  // that project load dominates the parallelizable graph math well past mid-sized repos —
  // e.g. self-analysis (36 files, 211 callables) runs 2.5× SLOWER at -j 14. An explicit -j N is
  // therefore an opt-in for large codebases (and how the differential test forces the worker
  // path); correctness is guarded either way by the byte-identical N-vs-1 gate.
  const jobs = opts.jobs === 0 ? 1 : opts.jobs;

  if (jobs <= 1) {
    return { promise: Promise.resolve(extractSequential(project, callables, opts)), pool: null };
  }
  const workerCount = Math.max(1, Math.min(jobs, files.length));

  let pool: WorkerPool;
  try {
    pool = new WorkerPool(workerCount);
  } catch (e) {
    log.warn(`graph workers unavailable (${(e as Error).message}); extracting sequentially`);
    return { promise: Promise.resolve(extractSequential(project, callables, opts)), pool: null };
  }

  const partitions: Array<Array<{ signature: string; path: string; absPath: string }>> = Array.from(
    { length: workerCount },
    () => [],
  );
  files.forEach((f, i) => partitions[i % workerCount]?.push(...(byFile.get(f) ?? [])));

  const handle: ExtractionHandle = { promise: Promise.resolve(new Map()), pool };
  handle.promise = Promise.all(
    partitions
      .filter((p) => p.length)
      .map((sigs) => {
        const task: ExtractTask = {
          type: "extract",
          root: opts.input,
          tsConfigFilePath,
          skipTests: opts.skipTests,
          k: opts.graphFieldDepth,
          sigs,
        };
        return pool.exec<CallableGraphData[]>(task);
      }),
  )
    .then((chunks) => {
      const out = new Map<string, CallableGraphData>();
      for (const chunk of chunks) for (const d of chunk) out.set(d.signature, d);
      if (out.size === 0 && callables.size > 0) {
        // Workers "succeeding" with nothing means their view of the project diverged from the
        // main thread's — treat it as a failure, never as an empty program.
        throw new Error("workers returned no callables");
      }
      return out;
    })
    .catch((e: Error) => {
      // Degrade, never fail: retire the pool (so the wavefront goes sequential too — a pool
      // that failed extraction must not be trusted with, or dangle, further tasks) and
      // recompute on the main-thread project.
      log.warn(`graph extraction workers failed (${e.message}); falling back to sequential`);
      handle.pool?.close();
      handle.pool = null;
      return extractSequential(project, callables, opts);
    });

  return handle;
}

function extractSequential(
  project: Project,
  callables: Map<string, TSCallable>,
  opts: AnalysisOptions,
): Map<string, CallableGraphData> {
  const astIndex = indexCallableDecls(project, opts.input);
  const out = new Map<string, CallableGraphData>();
  for (const [sig, c] of [...callables.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const fn = astIndex.get(sig);
    if (!fn) continue; // bodiless (interface/abstract/ambient/implicit) or unmatchable
    const data = extractCallableData(sig, fn, fileKeyOf(c.path, opts.input).fileKey, opts.input, opts.graphFieldDepth);
    if (data) out.set(sig, data);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Stages 5–7 + emission
// ------------------------------------------------------------------------------------------------

export async function buildProgramGraphs(
  extraction: ExtractionHandle,
  symbol_table: Record<string, TSModule>,
  opts: AnalysisOptions,
  log: Logger,
): Promise<ProgramGraphs> {
  try {
    const datas = await extraction.promise;
    const callables = collectCallables(symbol_table);
    log.info(
      `program graphs: ${datas.size} callables (of ${callables.size} in the symbol table), ` +
        `workers=${extraction.pool ? extraction.pool.size : 1}`,
    );

    // Map recorded call sites onto CFG statement nodes (pure span containment — no AST). The
    // callee signatures were backfilled by the call-graph provider while extraction ran.
    const callSites = new Map<string, CallSiteRef[]>();
    for (const [sig, data] of datas) {
      const refs: CallSiteRef[] = [];
      for (const site of (callables.get(sig) as TSCallable).call_sites) {
        const nodeId = containingNode(data, site);
        if (nodeId === null) continue;
        refs.push({ nodeId, callee: site.callee_signature, argCount: site.argument_types.length });
      }
      refs.sort((a, b) => a.nodeId - b.nodeId || (a.callee ?? "").localeCompare(b.callee ?? ""));
      callSites.set(sig, refs);
    }

    // Stages 5–6: SCC condensation + the summary wavefront.
    const { summaries, ddg, sccCount, largest } = await composeWavefront(datas, callSites, extraction.pool, log);
    log.debug(`program graphs: ${sccCount} SCCs, largest ${largest}`);

    // Emission per --graphs selector.
    const wantCfg = opts.graphs.includes("cfg");
    const wantPdg = opts.graphs.includes("pdg");
    const wantDfg = opts.graphs.includes("dfg");
    const wantSdg = opts.graphs.includes("sdg");

    const functions: Record<string, FunctionGraphs> = {};
    for (const [sig, data] of [...datas.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const fg: FunctionGraphs = {};
      if (wantCfg) fg.cfg = { nodes: data.nodes, edges: data.edges };
      if (wantPdg || wantDfg) {
        const edges: PdgEdge[] = [];
        if (wantPdg) edges.push(...data.cdg);
        edges.push(...(ddg.get(sig) ?? []));
        fg.pdg = {
          edges: edges.sort(
            (a, b) =>
              a.source - b.source ||
              a.target - b.target ||
              a.type.localeCompare(b.type) ||
              (a.var ?? "").localeCompare(b.var ?? ""),
          ),
        };
      }
      functions[sig] = fg;
    }

    const sdg_edges = wantSdg ? assembleSdg(datas, callSites, summaries) : [];

    persistSummaries(opts, symbol_table, callables, summaries, log);

    return { schema_version: PROGRAM_GRAPHS_SCHEMA_VERSION, k_limit: opts.graphFieldDepth, functions, sdg_edges };
  } finally {
    extraction.pool?.close();
  }
}

// ------------------------------------------------------------------------------------------------
// The summary wavefront: Kahn-style ready queue over the SCC condensation DAG
// ------------------------------------------------------------------------------------------------

async function composeWavefront(
  datas: Map<string, CallableGraphData>,
  callSites: Map<string, CallSiteRef[]>,
  pool: WorkerPool | null,
  log: Logger,
): Promise<{ summaries: Map<string, FunctionSummary>; ddg: Map<string, PdgEdge[]>; sccCount: number; largest: number }> {
  const sigs = [...datas.keys()].sort();
  const adj = callAdjacency(sigs, callSites, (s) => datas.has(s));
  const sccs = tarjanSccs(sigs, adj); // emitted callees-first
  const largest = Math.max(0, ...sccs.map((s) => s.length));

  const summaries = new Map<string, FunctionSummary>();
  const ddg = new Map<string, PdgEdge[]>();

  const solveInline = (members: string[]): void => {
    const res = sccFixpoint(
      members.map((m) => datas.get(m) as CallableGraphData),
      callSites,
      summaries,
    );
    for (const [k, v] of res.summaries) summaries.set(k, v);
    for (const [k, v] of res.ddg) ddg.set(k, v);
  };

  if (!pool) {
    // Sequential debug mode: Tarjan order IS a valid wavefront linearization.
    for (const scc of sccs) solveInline(scc);
    return { summaries, ddg, sccCount: sccs.length, largest };
  }

  // Condensation DAG: per-SCC dependency counters (callee SCCs must finish first) + reverse
  // index (callee SCC → dependent caller SCCs) so completions decrement exactly their waiters.
  const sccOf = new Map<string, number>();
  sccs.forEach((scc, i) => scc.forEach((sig) => sccOf.set(sig, i)));
  const pendingDeps: number[] = sccs.map(() => 0);
  const dependents: number[][] = sccs.map(() => []);
  sccs.forEach((scc, i) => {
    const calleeSccs = new Set<number>();
    for (const sig of scc) {
      for (const callee of adj.get(sig) ?? []) {
        const j = sccOf.get(callee);
        if (j !== undefined && j !== i) calleeSccs.add(j);
      }
    }
    pendingDeps[i] = calleeSccs.size;
    for (const j of calleeSccs) dependents[j]?.push(i);
  });

  const ready: number[] = [];
  sccs.forEach((_, i) => {
    if (pendingDeps[i] === 0) ready.push(i);
  });

  const dispatch = (i: number): Promise<{ i: number; res: SolveTaskResult }> => {
    const members = sccs[i] as string[];
    // Ship only what the SCC needs: its members' data/call sites + its callees' summaries.
    const calleeSummaries: Array<[string, FunctionSummary]> = [];
    for (const sig of members) {
      for (const callee of adj.get(sig) ?? []) {
        const s = summaries.get(callee);
        if (s) calleeSummaries.push([callee, s]);
      }
    }
    const task: SolveTask = {
      type: "solve",
      members: members.map((m) => datas.get(m) as CallableGraphData),
      callSites: members.map((m) => [m, callSites.get(m) ?? []]),
      calleeSummaries,
    };
    return pool.exec<SolveTaskResult>(task).then((res) => ({ i, res }));
  };

  try {
    const inflight = new Map<number, Promise<{ i: number; res: SolveTaskResult }>>();
    while (ready.length || inflight.size) {
      while (ready.length && inflight.size < pool.size) {
        const i = ready.shift() as number;
        inflight.set(i, dispatch(i));
      }
      const { i, res } = await Promise.race(inflight.values());
      inflight.delete(i);
      for (const [k, v] of res.summaries) summaries.set(k, v);
      for (const [k, v] of res.ddg) ddg.set(k, v);
      for (const dep of dependents[i] ?? []) {
        pendingDeps[dep] = (pendingDeps[dep] as number) - 1;
        if (pendingDeps[dep] === 0) ready.push(dep);
      }
    }
  } catch (e) {
    // Degrade, never fail: redo the whole composition sequentially (pure functions — cheap-ish).
    log.warn(`summary wavefront workers failed (${(e as Error).message}); recomposing sequentially`);
    summaries.clear();
    ddg.clear();
    for (const scc of sccs) solveInline(scc);
  }

  return { summaries, ddg, sccCount: sccs.length, largest };
}

// ------------------------------------------------------------------------------------------------
// Call-site → CFG-node mapping (span containment on serialized nodes)
// ------------------------------------------------------------------------------------------------

/** The innermost non-synthetic CFG node whose span contains the recorded call site, or null. */
function containingNode(data: CallableGraphData, site: TSCallsite): number | null {
  let best: { id: number; span: number } | null = null;
  for (const n of data.nodes) {
    if (n.kind === "entry" || n.kind === "exit") continue;
    if (!containsPos(n, site.start_line, site.start_column)) continue;
    const span = spanSize(n);
    if (!best || span < best.span) best = { id: n.id, span };
  }
  return best?.id ?? null;
}

function containsPos(n: GraphNode, line: number, column: number): boolean {
  if (line < n.start_line || line > n.end_line) return false;
  if (line === n.start_line && column < n.start_column) return false;
  if (line === n.end_line && column >= n.end_column) return false;
  return true;
}

function spanSize(n: GraphNode): number {
  return (n.end_line - n.start_line) * 10_000 + (n.end_column - n.start_column);
}

// ------------------------------------------------------------------------------------------------
// Summary persistence (dependency-recorded, for later incrementality; write-only today)
// ------------------------------------------------------------------------------------------------

function persistSummaries(
  opts: AnalysisOptions,
  symbol_table: Record<string, TSModule>,
  callables: Map<string, TSCallable>,
  summaries: Map<string, FunctionSummary>,
  log: Logger,
): void {
  try {
    const cacheDir = opts.cacheDir ?? path.join(opts.input, ".codeanalyzer");
    fs.mkdirSync(cacheDir, { recursive: true });
    const entries: Record<string, unknown> = {};
    for (const sig of [...summaries.keys()].sort()) {
      const c = callables.get(sig);
      // TSCallable.path is absolute; the symbol table is keyed by the project-relative file key.
      const fileKey = c ? fileKeyOf(c.path, opts.input).fileKey : null;
      entries[sig] = {
        ...summaries.get(sig),
        content_hash: (fileKey && symbol_table[fileKey]?.content_hash) ?? null,
      };
    }
    const payload = { schema_version: PROGRAM_GRAPHS_SCHEMA_VERSION, k_limit: opts.graphFieldDepth, summaries: entries };
    fs.writeFileSync(path.join(cacheDir, "graphs_summaries.json"), JSON.stringify(payload, null, 2));
  } catch (e) {
    log.warn(`could not persist graph summaries: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------------------------------------------
// Symbol-table collection (signature → callable), recursing through every container kind
// ------------------------------------------------------------------------------------------------

function collectCallables(symbol_table: Record<string, TSModule>): Map<string, TSCallable> {
  const out = new Map<string, TSCallable>();
  for (const mod of Object.values(symbol_table)) collectModule(mod, out);
  return out;
}

function collectModule(mod: TSModule, out: Map<string, TSCallable>): void {
  for (const f of Object.values(mod.functions)) collectCallable(f, out);
  for (const c of Object.values(mod.classes)) collectClass(c, out);
  for (const ns of Object.values(mod.namespaces)) collectNamespace(ns, out);
}

function collectNamespace(ns: TSNamespace, out: Map<string, TSCallable>): void {
  for (const f of Object.values(ns.functions)) collectCallable(f, out);
  for (const c of Object.values(ns.classes)) collectClass(c, out);
  for (const n of Object.values(ns.namespaces)) collectNamespace(n, out);
}

function collectClass(c: TSClass, out: Map<string, TSCallable>): void {
  for (const m of Object.values(c.methods)) collectCallable(m, out);
  for (const ic of Object.values(c.inner_classes)) collectClass(ic, out);
}

function collectCallable(c: TSCallable, out: Map<string, TSCallable>): void {
  out.set(c.signature, c);
  for (const ic of Object.values(c.inner_callables)) collectCallable(ic, out);
  for (const cl of Object.values(c.inner_classes)) collectClass(cl, out);
}
