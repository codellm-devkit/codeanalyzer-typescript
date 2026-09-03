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
import type { Node, Project } from "ts-morph";
import type { BuiltProgram } from "../syntactic_analysis/symbolTable";
import type { AnalysisOptions } from "../options";
import { writeIr } from "./ir";
import {
  PROGRAM_GRAPHS_SCHEMA_VERSION,
  fileKeyOf,
  type FunctionGraphs,
  type GraphNode,
  type PdgEdge,
  type ProgramGraphs,
  type TSCallable,
  type TSCallsite,
  type TSModule,
  forEachCallable,
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
  programs: BuiltProgram[],
  symbol_table: Record<string, TSModule>,
  opts: AnalysisOptions,
  log: Logger,
  keepProject?: Project,
): ExtractionHandle {
  const callables = collectCallables(symbol_table);
  // Every callable is extracted under the tsconfig that OWNS its file, exactly as the symbol table
  // and the L2 call graph already resolve it (#111). Indexing the whole repo against one root
  // program silently drops every callable a deeper program owns: `indexCallableDecls` never sees
  // the declaration, and the `if (!fn) continue` below skips it. On vscode -- 92 programs, no root
  // tsconfig -- that was 1,204 of 174,767 callables extracted.
  const ownerOf = programOwnerIndex(programs, callables, opts.input);

  // Partition callables by owning file (round-robin over the sorted file list) so each worker
  // deeply visits only its share of the program. TSCallable.abs_path is the declaration's ABSOLUTE
  // file path; the graph data carries the project-relative file key.
  const byFile = new Map<string, Array<{ signature: string; path: string; absPath: string }>>();
  for (const [sig, c] of [...callables.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const absPath = c.abs_path;
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
    return { promise: Promise.resolve(extractSequential(programs, ownerOf, callables, opts, log, keepProject)), pool: null };
  }
  const workerCount = Math.max(1, Math.min(jobs, files.length));

  let pool: WorkerPool;
  try {
    pool = new WorkerPool(workerCount);
  } catch (e) {
    log.warn(`graph workers unavailable (${(e as Error).message}); extracting sequentially`);
    return { promise: Promise.resolve(extractSequential(programs, ownerOf, callables, opts, log, keepProject)), pool: null };
  }

  // Partition WITHIN each owning program: a task's files must all share one tsconfig, because the
  // worker builds a single Project per task config (#111). Round-robin inside a program keeps the
  // per-worker balance the previous global round-robin had.
  const byConfig = new Map<string, { configPath: string | null; files: string[] }>();
  for (const f of files) {
    const configPath = ownerOf.get(f) ?? null;
    const key = configPath ?? "";
    const g = byConfig.get(key) ?? { configPath, files: [] };
    g.files.push(f);
    byConfig.set(key, g);
  }
  const partitions: Array<{ configPath: string | null; sigs: Array<{ signature: string; path: string; absPath: string }> }> = [];
  for (const key of [...byConfig.keys()].sort()) {
    const g = byConfig.get(key)!;
    const slots: Array<Array<{ signature: string; path: string; absPath: string }>> = Array.from(
      { length: Math.max(1, Math.min(workerCount, g.files.length)) },
      () => [],
    );
    g.files.forEach((f, i) => slots[i % slots.length]?.push(...(byFile.get(f) ?? [])));
    for (const s of slots) if (s.length) partitions.push({ configPath: g.configPath, sigs: s });
  }

  const handle: ExtractionHandle = { promise: Promise.resolve(new Map()), pool };
  handle.promise = Promise.all(
    partitions.map(({ configPath, sigs }) => {
      const task: ExtractTask = {
        type: "extract",
        root: opts.input,
        tsConfigFilePath: configPath,
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
      reportCoverage(out.size, callables.size, log);
      return out;
    })
    .catch((e: Error) => {
      // Degrade, never fail: retire the pool (so the wavefront goes sequential too — a pool
      // that failed extraction must not be trusted with, or dangle, further tasks) and
      // recompute on the main-thread project.
      log.warn(`graph extraction workers failed (${e.message}); falling back to sequential`);
      handle.pool?.close();
      handle.pool = null;
      return extractSequential(programs, ownerOf, callables, opts, log, keepProject);
    });

  return handle;
}

/**
 * absolute file path -> the tsconfig that OWNS it, taken from the same program assignment the
 * symbol table used (`BuiltProgram.fileKeys`, deepest scope wins). A file no program claims maps
 * to null, the default-options program.
 */
function programOwnerIndex(
  programs: BuiltProgram[],
  callables: Map<string, TSCallable>,
  root: string,
): Map<string, string | null> {
  const byFileKey = new Map<string, string | null>();
  for (const p of programs) for (const k of p.fileKeys) if (!byFileKey.has(k)) byFileKey.set(k, p.configPath);
  const out = new Map<string, string | null>();
  for (const c of callables.values()) {
    if (out.has(c.abs_path)) continue;
    out.set(c.abs_path, byFileKey.get(fileKeyOf(c.abs_path, root).fileKey) ?? null);
  }
  return out;
}

function extractSequential(
  programs: BuiltProgram[],
  ownerOf: Map<string, string | null>,
  callables: Map<string, TSCallable>,
  opts: AnalysisOptions,
  log: Logger,
  keepProject?: Project,
): Map<string, CallableGraphData> {
  // Group first, then index ONE program at a time. Building all of them up front holds every
  // program's declaration nodes live at once: on vscode (92 programs) that peaked at 26.9GB and
  // the process was killed. Only one index is resident here, so the memory profile matches the
  // single-root version while the lookup is per-owning-program (#111).
  const byConfig = new Map<string, Array<[string, TSCallable]>>();
  for (const [sig, c] of [...callables.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const key = ownerOf.get(c.abs_path) ?? "";
    const group = byConfig.get(key);
    if (group) group.push([sig, c]);
    else byConfig.set(key, [[sig, c]]);
  }

  const out = new Map<string, CallableGraphData>();
  for (const p of programs) {
    const group = byConfig.get(p.configPath ?? "");
    if (!group?.length) continue;
    const idx = indexCallableDecls(p.project, opts.input);
    for (const [sig, c] of group) {
      const fn = idx.get(sig);
      if (!fn) continue; // bodiless (interface/abstract/ambient/implicit) or unmatchable
      const data = extractCallableData(sig, fn, fileKeyOf(c.abs_path, opts.input).fileKey, opts.input, opts.graphFieldDepth);
      if (data) out.set(sig, data);
    }
    // Release this program's ASTs now that nothing else will read them (#112). Indexing a
    // project forces tsc to parse and bind every file in it, so on a repo with many programs the
    // materialised set is the dominant cost -- vscode has 92. `keepProject` is the root program,
    // which finalizeAnalysis still needs for the config-use dataflow tier, so it is spared.
    if (p.project !== keepProject) {
      for (const sf of p.project.getSourceFiles()) p.project.removeSourceFile(sf);
    }
  }
  reportCoverage(out.size, callables.size, log);
  return out;
}

/**
 * Say how much flow was actually extracted. A near-empty L3 used to be indistinguishable from a
 * successful one -- #111 shipped precisely because nothing reported that 0.7% of callables had
 * been populated.
 */
function reportCoverage(extracted: number, collected: number, log: Logger): void {
  if (!collected) return;
  const pct = (100 * extracted) / collected;
  const msg = `dataflow: extracted ${extracted.toLocaleString()} of ${collected.toLocaleString()} callables (${pct.toFixed(1)}%)`;
  if (pct < 50) log.warn(`${msg} — most callables produced no control/data flow`);
  else log.info(msg);
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
        refs.push({ nodeId, callee: site.callee_signature ?? null, argCount: site.argument_types.length });
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
    // Wave-1 shard IR (#112 step 4): everything the cross-shard stitch needs and nothing tsc owns.
    if (opts.emitIr) writeIr(opts, opts.programFilter ?? ["<all>"], datas, callSites, summaries, log);

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
      // TSCallable.abs_path is absolute; the symbol table is keyed by the project-relative file key.
      const fileKey = c ? fileKeyOf(c.abs_path, opts.input).fileKey : null;
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
// Symbol-table collection (signature → callable) — the shared containment walk (schema.ts)
// ------------------------------------------------------------------------------------------------

function collectCallables(symbol_table: Record<string, TSModule>): Map<string, TSCallable> {
  const out = new Map<string, TSCallable>();
  for (const mod of Object.values(symbol_table)) forEachCallable(mod, (c) => out.set(c.signature, c));
  return out;
}
