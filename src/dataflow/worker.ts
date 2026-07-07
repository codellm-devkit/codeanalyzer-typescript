/**
 * Level-3 worker entry — runs on a Bun Worker thread. Two task kinds:
 *
 *  - "extract": stages 1–4 for a partition of the project's files. ts-morph ASTs cannot cross
 *    the structured-clone boundary, so each worker materializes its own whole-program Project
 *    (the checker needs every file for cross-file resolution; only the partition's files are
 *    deeply visited) and returns plain CallableGraphData.
 *  - "solve": one SCC's summary fixpoint (the wavefront's atomic unit) — pure data in, pure
 *    data out, via the same sccFixpoint the sequential path uses.
 *
 * The pool treats any failure here as "fall back to sequential", so this file must never be a
 * correctness dependency.
 */
import { Project } from "ts-morph";
import type { PdgEdge } from "../schema";
import { defaultCompilerOptions, discoverSourceFiles } from "../syntactic_analysis";
import { extractCallableData, indexCallableDecls } from "./extract";
import type { CallableGraphData } from "./model";
import { sccFixpoint, type CallSiteRef, type FunctionSummary } from "./summaries";

export interface ExtractTask {
  type: "extract";
  root: string;
  tsConfigFilePath: string | null;
  skipTests: boolean;
  k: number;
  /** The callables this worker owns: signature + module file key + absolute file path. */
  sigs: Array<{ signature: string; path: string; absPath: string }>;
}

export interface SolveTask {
  type: "solve";
  members: CallableGraphData[];
  callSites: Array<[string, CallSiteRef[]]>;
  calleeSummaries: Array<[string, FunctionSummary]>;
}

export interface SolveTaskResult {
  summaries: Array<[string, FunctionSummary]>;
  ddg: Array<[string, PdgEdge[]]>;
}

export type WorkerTask = ExtractTask | SolveTask;

// One Project per worker lifetime (keyed in case tasks ever mix targets).
const projects = new Map<string, Project>();

function projectFor(root: string, tsConfigFilePath: string | null, skipTests: boolean): Project {
  const key = `${root}|${tsConfigFilePath ?? ""}|${skipTests}`;
  let project = projects.get(key);
  if (project) return project;
  project = tsConfigFilePath
    ? new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: true })
    : new Project({ compilerOptions: defaultCompilerOptions() });
  for (const f of discoverSourceFiles(root, skipTests)) {
    try {
      project.addSourceFileAtPath(f.absPath);
    } catch {
      // Same tolerance as the symbol-table builder: an unloadable file degrades, never crashes.
    }
  }
  projects.set(key, project);
  return project;
}

function runExtract(task: ExtractTask): CallableGraphData[] {
  const project = projectFor(task.root, task.tsConfigFilePath, task.skipTests);
  const onlyFiles = new Set(task.sigs.map((s) => s.absPath));
  const idx = indexCallableDecls(project, task.root, onlyFiles);
  const out: CallableGraphData[] = [];
  for (const s of task.sigs) {
    const fn = idx.get(s.signature);
    if (!fn) continue;
    const data = extractCallableData(s.signature, fn, s.path, task.root, task.k);
    if (data) out.push(data);
  }
  return out;
}

function runSolve(task: SolveTask): SolveTaskResult {
  const res = sccFixpoint(task.members, new Map(task.callSites), new Map(task.calleeSummaries));
  return { summaries: [...res.summaries.entries()], ddg: [...res.ddg.entries()] };
}

declare var self: Worker;

self.onmessage = (ev: MessageEvent) => {
  const task = ev.data as WorkerTask;
  try {
    const result = task.type === "extract" ? runExtract(task) : runSolve(task);
    self.postMessage({ ok: true, result });
  } catch (e) {
    const err = e as Error;
    self.postMessage({ ok: false, error: err.stack ?? err.message });
  }
};
