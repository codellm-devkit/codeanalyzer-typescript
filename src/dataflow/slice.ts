/**
 * Stage 8 client — context-sensitive backward slicing as a query over the emitted SDG
 * (the two-phase Horwitz–Reps–Binkley traversal).
 *
 * Phase 1 ("up"): from the criterion, reverse-traverse intra-function dependence (CDG, DDG),
 * SUMMARY edges, and the ascending interprocedural edges (PARAM_IN, CALL) — but never PARAM_OUT,
 * so the walk does not descend into callees (their transitive effects are covered by SUMMARY).
 * Phase 2 ("down"): from everything phase 1 reached, additionally reverse-traverse PARAM_OUT
 * (descending into callees), but no longer PARAM_IN/CALL (no re-ascending — that is what keeps
 * the slice context-sensitive). The slice is the union.
 */
import type { ProgramGraphs } from "../schema";

export interface SliceCriterion {
  signature: string;
  node: number;
}

const keyOf = (sig: string, node: number): string => `${sig}#${node}`;

interface ReverseEdges {
  intra: Map<string, string[]>; // CDG ∪ DDG ∪ SUMMARY, reversed
  ascend: Map<string, string[]>; // PARAM_IN ∪ CALL, reversed
  descend: Map<string, string[]>; // PARAM_OUT, reversed
}

function reverseEdges(pg: ProgramGraphs): ReverseEdges {
  const intra = new Map<string, string[]>();
  const ascend = new Map<string, string[]>();
  const descend = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, from: string, to: string): void => {
    const arr = m.get(from) ?? [];
    arr.push(to);
    m.set(from, arr);
  };
  for (const [sig, g] of Object.entries(pg.functions)) {
    for (const e of g.pdg?.edges ?? []) push(intra, keyOf(sig, e.target), keyOf(sig, e.source));
  }
  for (const e of pg.sdg_edges) {
    const from = keyOf(e.target.signature, e.target.node);
    const to = keyOf(e.source.signature, e.source.node);
    if (e.type === "SUMMARY") push(intra, from, to);
    else if (e.type === "PARAM_IN" || e.type === "CALL") push(ascend, from, to);
    else push(descend, from, to);
  }
  return { intra, ascend, descend };
}

export function backwardSlice(pg: ProgramGraphs, criterion: SliceCriterion): Set<string> {
  const rev = reverseEdges(pg);
  const walk = (starts: Iterable<string>, follow: Array<Map<string, string[]>>): Set<string> => {
    const seen = new Set<string>(starts);
    const stack = [...seen];
    while (stack.length) {
      const n = stack.pop() as string;
      for (const m of follow) {
        for (const p of m.get(n) ?? []) {
          if (!seen.has(p)) {
            seen.add(p);
            stack.push(p);
          }
        }
      }
    }
    return seen;
  };
  const phase1 = walk([keyOf(criterion.signature, criterion.node)], [rev.intra, rev.ascend]);
  return walk(phase1, [rev.intra, rev.descend]);
}
