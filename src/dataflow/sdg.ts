/**
 * Stage 7 — SDG assembly: stitch the per-function PDGs with interprocedural edges
 * (Horwitz–Reps–Binkley), all keyed by canonical `(signature, node_id)`. Operates purely on the
 * serialized CallableGraphData (no AST access).
 *
 * Call sites are collapsed onto their containing statement node (the node is both actual-in and
 * actual-out), so:
 *  - CALL:      callsite statement → callee ENTRY (node 0).
 *  - PARAM_IN:  callsite statement → callee `param` node, var "argN"; module globals the callee
 *               transitively reads ride the same mechanism targeting the callee ENTRY (where
 *               stage 3 places their initial defs), var = the global path.
 *  - PARAM_OUT: callee EXIT → callsite statement, var "return" (always: over-approximate) or the
 *               written global path.
 *  - SUMMARY:   self-edge on the callsite node, var = the input ("argN" or a global path) whose
 *               value may transitively flow to the call's result — composed from stage 6.
 *
 * External / unresolved callees have no graphs to reference (no dangling endpoints — the
 * call-graph rule), so they contribute only conservative pass-through SUMMARY self-edges.
 */
import type { SdgEdge } from "../schema";
import { renderGlobal, type CallableGraphData } from "./model";
import type { CallSiteRef, FunctionSummary } from "./summaries";

export function assembleSdg(
  datas: Map<string, CallableGraphData>,
  callSites: Map<string, CallSiteRef[]>,
  summaries: Map<string, FunctionSummary>,
): SdgEdge[] {
  const out: SdgEdge[] = [];
  const seen = new Set<string>();
  const add = (e: SdgEdge): void => {
    const k = `${e.source.signature}#${e.source.node}>${e.target.signature}#${e.target.node}>${e.type}>${e.var ?? ""}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };

  for (const caller of [...datas.keys()].sort()) {
    for (const cs of callSites.get(caller) ?? []) {
      const at = (node: number): { signature: string; node: number } => ({ signature: caller, node });
      const callee = cs.callee ? datas.get(cs.callee) : undefined;

      if (!callee || !cs.callee) {
        // External / unresolved: conservative pass-through — every argument may flow to the result.
        for (let i = 0; i < cs.argCount; i++) {
          add({ source: at(cs.nodeId), target: at(cs.nodeId), type: "SUMMARY", var: `arg${i}` });
        }
        continue;
      }

      const calleeSig = cs.callee;
      add({ source: at(cs.nodeId), target: { signature: calleeSig, node: callee.entryId }, type: "CALL" });

      // Positional PARAM_IN edges; extra arguments bind to a trailing rest parameter if there is one.
      for (let i = 0; i < cs.argCount; i++) {
        let pIdx = i;
        if (pIdx >= callee.paramIds.length) {
          if (!callee.hasRestParam || callee.paramIds.length === 0) continue;
          pIdx = callee.paramIds.length - 1;
        }
        add({
          source: at(cs.nodeId),
          target: { signature: calleeSig, node: callee.paramIds[pIdx] as number },
          type: "PARAM_IN",
          var: `arg${i}`,
        });
      }
      add({
        source: { signature: calleeSig, node: callee.exitId },
        target: at(cs.nodeId),
        type: "PARAM_OUT",
        var: "return",
      });

      const sum = summaries.get(calleeSig);
      if (sum) {
        for (const g of sum.global_reads) {
          add({
            source: at(cs.nodeId),
            target: { signature: calleeSig, node: callee.entryId },
            type: "PARAM_IN",
            var: renderGlobal(g),
          });
        }
        for (const g of sum.global_writes) {
          add({
            source: { signature: calleeSig, node: callee.exitId },
            target: at(cs.nodeId),
            type: "PARAM_OUT",
            var: renderGlobal(g),
          });
        }
        for (const i of sum.param_flows) {
          if (i < cs.argCount) add({ source: at(cs.nodeId), target: at(cs.nodeId), type: "SUMMARY", var: `arg${i}` });
        }
        for (const g of sum.globals_to_return) {
          add({ source: at(cs.nodeId), target: at(cs.nodeId), type: "SUMMARY", var: g });
        }
      }
    }
  }

  return out.sort(
    (a, b) =>
      a.source.signature.localeCompare(b.source.signature) ||
      a.source.node - b.source.node ||
      a.target.signature.localeCompare(b.target.signature) ||
      a.target.node - b.target.node ||
      a.type.localeCompare(b.type) ||
      (a.var ?? "").localeCompare(b.var ?? ""),
  );
}
