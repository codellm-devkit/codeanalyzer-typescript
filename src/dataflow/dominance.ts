/**
 * Stage 2 — post-dominators and control dependence.
 *
 * Post-dominators via the Cooper–Harper–Kennedy iterative algorithm run on the REVERSE CFG
 * rooted at EXIT. Control dependence via Ferrante–Ottenstein–Warren: for each CFG edge (a, b)
 * where b does not post-dominate a, every node from b up the post-dominator tree to (exclusive)
 * ipdom(a) is control-dependent on a.
 *
 * The CFG is augmented with the standard ENTRY → EXIT edge for this computation only, so
 * straight-line statements come out control-dependent on ENTRY (the function's outermost
 * control region). The augmented edge is never emitted.
 *
 * Infinite loops need no special-casing here: stage 1 always emits the loop-exit `false` edge
 * (even when the condition is literally `true`), which keeps EXIT the unique post-dominance root.
 */
import type { PdgEdge } from "../schema";
import type { FunctionCfgBuild } from "./model";

/** Immediate post-dominator per node id (EXIT maps to itself). */
export function postDominators(build: FunctionCfgBuild): Map<number, number> {
  const { exitId } = build;
  const edges = augmentedEdges(build);
  // Reverse-CFG adjacency: from EXIT we walk against the CFG edges.
  const predOfReverse = new Map<number, number[]>(); // reverse-graph successors = CFG predecessors
  for (const n of build.nodes) predOfReverse.set(n.id, []);
  for (const [a, b] of edges) predOfReverse.get(b)?.push(a); // in the reverse graph, b → a

  // Postorder of the reverse graph from EXIT (iterative DFS).
  const postorder: number[] = [];
  const poNum = new Map<number, number>();
  const visited = new Set<number>([exitId]);
  const stack: Array<{ node: number; next: number }> = [{ node: exitId, next: 0 }];
  while (stack.length) {
    const top = stack[stack.length - 1] as { node: number; next: number };
    const kids = predOfReverse.get(top.node) as number[];
    if (top.next < kids.length) {
      const k = kids[top.next++] as number;
      if (!visited.has(k)) {
        visited.add(k);
        stack.push({ node: k, next: 0 });
      }
    } else {
      poNum.set(top.node, postorder.length);
      postorder.push(top.node);
      stack.pop();
    }
  }

  const ipdom = new Map<number, number>();
  ipdom.set(exitId, exitId);
  const intersect = (u: number, v: number): number => {
    let a = u;
    let b = v;
    while (a !== b) {
      while ((poNum.get(a) as number) < (poNum.get(b) as number)) a = ipdom.get(a) as number;
      while ((poNum.get(b) as number) < (poNum.get(a) as number)) b = ipdom.get(b) as number;
    }
    return a;
  };

  // Successor adjacency (CFG direction), for the intersect step.
  const cfgSucc = new Map<number, number[]>();
  for (const n of build.nodes) cfgSucc.set(n.id, []);
  for (const [a, b] of edges) cfgSucc.get(a)?.push(b);

  // Iterate to fixpoint in reverse postorder (of the reverse graph).
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = postorder.length - 1; i >= 0; i--) {
      const n = postorder[i] as number;
      if (n === exitId) continue;
      // "Predecessors" in the reverse graph = CFG successors that already have an ipdom.
      let candidate = -1;
      for (const s of cfgSucc.get(n) ?? []) {
        if (!ipdom.has(s) || !poNum.has(s)) continue;
        candidate = candidate === -1 ? s : intersect(candidate, s);
      }
      if (candidate !== -1 && ipdom.get(n) !== candidate) {
        ipdom.set(n, candidate);
        changed = true;
      }
    }
  }
  return ipdom;
}

/** Does `b` strictly post-dominate `a`? (walks a's ipdom chain) */
function strictlyPostDominates(b: number, a: number, ipdom: Map<number, number>, exitId: number): boolean {
  if (a === b) return false;
  let cur = ipdom.get(a);
  const seen = new Set<number>();
  while (cur !== undefined && !seen.has(cur)) {
    if (cur === b) return true;
    if (cur === exitId) return b === exitId;
    seen.add(cur);
    cur = ipdom.get(cur);
  }
  return false;
}

/** Ferrante–Ottenstein–Warren control-dependence edges (branch node → dependent node). */
export function controlDependence(build: FunctionCfgBuild, ipdom: Map<number, number>): PdgEdge[] {
  const out: PdgEdge[] = [];
  const seen = new Set<string>();
  for (const [a, b] of augmentedEdges(build)) {
    const ia = ipdom.get(a);
    if (ia === undefined || !ipdom.has(b)) continue; // node can't reach EXIT — skip (gate-checked)
    if (b === ia || strictlyPostDominates(b, a, ipdom, build.exitId)) continue;
    let runner = b;
    let guard = build.nodes.length + 1;
    while (runner !== ia && guard-- > 0) {
      const k = `${a}>${runner}`;
      if (!seen.has(k) && a !== runner) {
        seen.add(k);
        out.push({ source: a, target: runner, type: "CDG" });
      }
      runner = ipdom.get(runner) as number;
    }
  }
  return out;
}

// --- helpers ---

/** CFG edges as (source, target) pairs, deduped, plus the augmented ENTRY → EXIT edge. */
function augmentedEdges(build: FunctionCfgBuild): Array<[number, number]> {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  const push = (a: number, b: number): void => {
    const k = `${a}>${b}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push([a, b]);
  };
  for (const e of build.edges) push(e.source, e.target);
  push(build.entryId, build.exitId);
  return out;
}

