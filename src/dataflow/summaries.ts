/**
 * Stages 5–6 — the interprocedural half: SCC condensation of the (frozen, provenance-merged)
 * call graph, then bottom-up relational function summaries composed over the condensation DAG.
 *
 * A summary answers, per callable: which argument positions flow to the return value, which
 * module-level globals it (transitively) reads and writes, and which globals flow to its return.
 * Summaries are node-granular — dependence is tracked between CFG nodes, not sub-expressions —
 * which keeps them sound-leaning and over-approximate (the contract's precision posture).
 *
 * Everything here is pure data (CallableGraphData + prior summaries): fact extraction happened
 * once at stage 1–4 time, so an SCC's fixpoint re-runs only the reaching-defs solve. That is
 * what lets `sccFixpoint` be the atomic unit of the wavefront — dispatched to a worker or run
 * inline, byte-identically (it is a pure function of its inputs).
 *
 * Within an SCC (mutual recursion), member summaries are co-defined, iterating to a monotone
 * fixpoint. Termination: summary domains are finite — argument indices are bounded by arity and
 * global paths are k-limited — and grow monotonically.
 *
 * External / unresolved callees: conservative pass-through — every argument may flow to the
 * result (applied at SDG/SUMMARY emission); their global effects are unmodeled (documented
 * unsoundness: npm internals are not analyzed).
 */
import type { PdgEdge } from "../schema";
import { solveDefUse } from "./defuse";
import {
  renderGlobal,
  type CallEffects,
  type CallableGraphData,
  type GlobalPath,
  type NodeFacts,
} from "./model";

/** A call site inside a callable, mapped onto its CFG statement node. */
export interface CallSiteRef {
  nodeId: number;
  /** Callee signature (symbol-table / external / synthesized key), or null when unresolved. */
  callee: string | null;
  argCount: number;
}

export interface FunctionSummary {
  /** Argument indices whose value may flow to the return value. */
  param_flows: number[];
  global_reads: GlobalPath[];
  global_writes: GlobalPath[];
  /** Rendered global paths that may flow to the return value. */
  globals_to_return: string[];
  /** Callee signatures this summary was composed from (recorded for later incrementality). */
  deps: string[];
}

export interface SccResult {
  summaries: Map<string, FunctionSummary>;
  /** Each member's fixpoint DDG (already reflecting callee global effects) — what the PDG emits. */
  ddg: Map<string, PdgEdge[]>;
}

/**
 * Solve one SCC to its co-defined fixpoint, given the summaries of every callee SCC (which the
 * wavefront guarantees are complete). Pure: same inputs ⇒ same outputs, on any thread.
 */
export function sccFixpoint(
  members: CallableGraphData[],
  callSites: Map<string, CallSiteRef[]>,
  calleeSummaries: Map<string, FunctionSummary>,
): SccResult {
  const sorted = [...members].sort((a, b) => a.signature.localeCompare(b.signature));
  const memberSigs = new Set(sorted.map((m) => m.signature));
  const summaries = new Map<string, FunctionSummary>(calleeSummaries);
  const ddg = new Map<string, PdgEdge[]>();

  const selfReferential =
    sorted.length > 1 ||
    (callSites.get(sorted[0]?.signature ?? "") ?? []).some((cs) => cs.callee === sorted[0]?.signature);

  let iterations = 0;
  for (;;) {
    let changed = false;
    for (const data of sorted) {
      const effects = effectsFor(callSites.get(data.signature) ?? [], summaries);
      const solved = solveDefUse(data, effects);
      const next = summarize(data, solved.ddg, solved.effective, callSites.get(data.signature) ?? []);
      const prev = summaries.get(data.signature);
      if (!prev || !sameSummary(prev, next)) changed = true;
      summaries.set(data.signature, next);
      ddg.set(data.signature, solved.ddg);
    }
    iterations++;
    if (!changed || !selfReferential) break;
    if (iterations > 100) break; // k-limited domains make this unreachable; hard backstop anyway
  }

  // Return only this SCC's summaries (callee entries were working state).
  const own = new Map<string, FunctionSummary>();
  for (const sig of memberSigs) own.set(sig, summaries.get(sig) as FunctionSummary);
  return { summaries: own, ddg };
}

/** Project the current callee summaries onto a function's call sites as global read/write effects. */
function effectsFor(sites: CallSiteRef[], summaries: Map<string, FunctionSummary>): Map<number, CallEffects> {
  const out = new Map<number, CallEffects>();
  for (const cs of sites) {
    if (!cs.callee) continue;
    const s = summaries.get(cs.callee);
    if (!s) continue;
    const cur = out.get(cs.nodeId) ?? { reads: [], writes: [] };
    cur.reads.push(...s.global_reads);
    cur.writes.push(...s.global_writes);
    out.set(cs.nodeId, cur);
  }
  return out;
}

function summarize(
  data: CallableGraphData,
  ddg: PdgEdge[],
  effective: Map<number, NodeFacts>,
  sites: CallSiteRef[],
): FunctionSummary {
  // Forward DDG adjacency (def-node → use-node = "use-node depends on def-node").
  const fwd = new Map<number, Set<number>>();
  for (const e of ddg) {
    if (!fwd.has(e.source)) fwd.set(e.source, new Set());
    fwd.get(e.source)?.add(e.target);
  }
  const returnValueNodes = new Set(data.returnValueNodes);
  const reaches = (starts: number[]): Set<number> => {
    const seen = new Set<number>(starts);
    const stack = [...starts];
    while (stack.length) {
      const n = stack.pop() as number;
      for (const s of fwd.get(n) ?? []) {
        if (!seen.has(s)) {
          seen.add(s);
          stack.push(s);
        }
      }
    }
    return seen;
  };
  const touchesReturn = (starts: number[]): boolean => {
    for (const n of reaches(starts)) if (returnValueNodes.has(n)) return true;
    return false;
  };

  const param_flows: number[] = [];
  for (const [i, pid] of data.paramIds.entries()) {
    if (touchesReturn([pid])) param_flows.push(i);
  }

  // Global reads/writes: module-kind uses/defs anywhere in the function. Callee effects were
  // already overlaid by solveDefUse, so transitive effects fall out for free. ENTRY's synthetic
  // ambient defs are initializations, not writes — exclude them.
  const readsByKey = new Map<string, GlobalPath>();
  const writesByKey = new Map<string, GlobalPath>();
  const usedAt = new Map<string, number[]>();
  for (const [nodeId, f] of effective) {
    for (const u of f.uses) {
      if (u.baseKind !== "module") continue;
      const g: GlobalPath = { key: u.key, fields: u.fields };
      readsByKey.set(renderGlobal(g), g);
      const arr = usedAt.get(u.key) ?? [];
      arr.push(nodeId);
      usedAt.set(u.key, arr);
    }
    if (nodeId === data.entryId) continue;
    for (const d of f.defs) {
      if (d.ref.baseKind !== "module") continue;
      const g: GlobalPath = { key: d.ref.key, fields: d.ref.fields };
      writesByKey.set(renderGlobal(g), g);
    }
  }

  const globals_to_return: string[] = [];
  for (const [rendered, g] of readsByKey) {
    const nodes = usedAt.get(g.key) ?? [];
    if (nodes.length && touchesReturn(nodes)) globals_to_return.push(rendered);
  }

  const deps = new Set<string>();
  for (const cs of sites) if (cs.callee) deps.add(cs.callee);

  return {
    param_flows: param_flows.sort((a, b) => a - b),
    global_reads: sortGlobals([...readsByKey.values()]),
    global_writes: sortGlobals([...writesByKey.values()]),
    globals_to_return: globals_to_return.sort(),
    deps: [...deps].sort(),
  };
}

function sortGlobals(gs: GlobalPath[]): GlobalPath[] {
  return gs.sort((a, b) => renderGlobal(a).localeCompare(renderGlobal(b)));
}

function sameSummary(a: FunctionSummary, b: FunctionSummary): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ------------------------------------------------------------------------------------------------
// Tarjan SCC — emission order is reverse-topological (an SCC is emitted after every SCC it calls).
// ------------------------------------------------------------------------------------------------

export function tarjanSccs(nodes: string[], adj: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;

  const strongconnect = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      for (;;) {
        const w = stack.pop() as string;
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      out.push(scc);
    }
  };

  for (const v of nodes) if (!index.has(v)) strongconnect(v);
  return out;
}

/** Internal-call adjacency (caller → callees with graphs), the condensation input. */
export function callAdjacency(
  sigs: string[],
  callSites: Map<string, CallSiteRef[]>,
  hasGraph: (sig: string) => boolean,
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const s of sigs) {
    const targets = new Set<string>();
    for (const cs of callSites.get(s) ?? []) {
      if (cs.callee && hasGraph(cs.callee) && cs.callee !== s) targets.add(cs.callee);
    }
    adj.set(s, [...targets].sort());
  }
  return adj;
}
