/**
 * L2 refinement passes — python's `l2_callees.py` + `call_graph_ids.py`:
 *
 *  - `backfillCallees`: fill each L1 `call` body node's `callee` (null → id) from the call
 *    site's resolver-backfilled `callee_signature`. A declared target becomes its can:// id via
 *    `idBySig` (which, run after the homing pass, also names external and synthesized targets);
 *    an unresolved call site keeps the sanctioned `callee: null`.
 *  - `reidentifyCallGraph`: rewrite the provider edge list onto can:// endpoints in the wire
 *    shape ({src, dst, prov, weight}); endpoints with no id home are collected as `dangling`
 *    (the L2 no-dangling gate; should be empty) and their edges dropped.
 */

import type { AnalysisInternal, TSCallEdge, TSCallGraphEdge, TSModule } from "./schema";
import { forEachCallable } from "./schema";
import { callBodyKeys } from "./l1Body";

export function backfillCallees(
  app: AnalysisInternal,
  idBySig: Map<string, string>,
  resolutions?: Map<string, Map<string, string>>,
): void {
  for (const mod of Object.values(app.symbol_table) as TSModule[]) {
    forEachCallable(mod, (c) => {
      const linked = resolutions?.get(c.signature);
      for (const [key, cs] of callBodyKeys(c.call_sites)) {
        // The resolver's in-place backfill wins; the linker's returned map fills the gaps. Linker
        // resolutions are deliberately NOT persisted into callee_signature (cache provenance rule
        // — see defuseLinker.ts header).
        const sig = cs.callee_signature ?? linked?.get(key);
        if (!sig) continue;
        const node = c.body[key];
        if (!node || node.kind !== "call") continue;
        node.callee = idBySig.get(sig) ?? null;
      }
    });
  }
}

export function reidentifyCallGraph(
  edges: TSCallEdge[],
  idBySig: Map<string, string>,
  dangling: string[],
): TSCallGraphEdge[] {
  const out: TSCallGraphEdge[] = [];
  for (const e of edges) {
    const src = idBySig.get(e.source);
    const dst = idBySig.get(e.target);
    if (!src) dangling.push(e.source);
    if (!dst) dangling.push(e.target);
    if (src && dst) out.push({ src, dst, prov: e.provenance, weight: e.weight });
  }
  return out;
}
