/**
 * L2 endpoint homing (TS-specific): give every off-tree call-graph endpoint an id home on the
 * application root, so the no-dangling rule holds.
 *
 *  - `homeExternals`: external library call targets → `can://…/@external/<module>/<name>` nodes.
 *  - `homeSynthesized`: the #92 anonymous-callable compatibility index (the older id → the
 *    tree id that replaced it), plus residual fallback nodes for signatures no provider could
 *    name (recognizable because the map key equals the entry's own id).
 *
 * Both register their ids into `idBySig`, which is why they run BEFORE the callee backfill and
 * the call-graph re-identification (l2Callees.ts).
 */

import type { AnalysisInternal, TSSpan } from "./schema";

/** A call target outside the project (an imported library member / builtin) — an edge endpoint, not a tree node. */
export interface TSExternalNode {
  id: string;
  kind: "external";
  module: string; // the import/require specifier, e.g. "node:fs", "express"
  name: string; // the called member, e.g. "readFileSync"
}

/** A synthesized-callable index entry: a pointer node (id + kind) or a residual fallback node. */
export interface TSSynthesizedNode {
  id: string;
  kind: string;
  name?: string;
  path?: string;
  span?: TSSpan;
}

/** External library call targets → `can://…/@external/<module>/<name>` ids on the application root. */
export function homeExternals(app: AnalysisInternal, appId: string, idBySig: Map<string, string>): Record<string, TSExternalNode> {
  const out: Record<string, TSExternalNode> = {};
  for (const [sig, ext] of Object.entries(app.external_symbols ?? {})) {
    const id = `${appId}/@external/${ext.module}/${ext.name}`;
    idBySig.set(sig, id);
    out[id] = { id, kind: "external", module: ext.module, name: ext.name };
  }
  return out;
}

/**
 * The compatibility index for anonymous callables (#92).
 *
 * Anonymous callables are real nodes in the containment tree, signed positionally
 * (`<enclosing-sig>.<anon@line:col>`) and reachable by containment. This map is not a node
 * registry: it maps the **older id** of each anonymous callable — `<enclosing-can-id>@<line>:<col>`,
 * derived from the old `<enclosing-sig>:<line:col>` signature — onto the tree id that replaced it,
 * so a consumer holding an old id can still resolve it.
 *
 * The old host was the nearest enclosing callable the old rules could name, which is recovered by
 * stripping the trailing `<anon@…>` chain. An anonymous callable directly under a module had no
 * resolvable old id (the old emitter fell back to an opaque `@synthetic/` key that encoded the
 * ambiguous `<module>:<line:col>` signature, which was not unique across files) — those are
 * skipped rather than reproduced.
 *
 * Any signature the call-graph provider still could not name is homed here too, unchanged, so the
 * no-dangling rule holds even if a provider reports a function-like node the tree missed.
 */
export function homeSynthesized(app: AnalysisInternal, appId: string, idBySig: Map<string, string>): Record<string, TSSynthesizedNode> {
  const out: Record<string, TSSynthesizedNode> = {};
  for (const [sig, id] of [...idBySig.entries()]) {
    const m = /^(.*?)((?:\.<anon@\d+:\d+>)+)$/.exec(sig);
    if (!m) continue;
    const host = idBySig.get(m[1] as string);
    if (!host) continue; // module-level anonymous callable — no resolvable older id
    const last = /<anon@(\d+):(\d+)>$/.exec(sig) as RegExpExecArray;
    out[`${host}@${last[1]}:${last[2]}`] = { id, kind: "callable" };
  }
  for (const [sig, sc] of Object.entries(app.synthesized_callables ?? {})) {
    if (idBySig.has(sig)) continue; // the tree names it now
    const m = /^(.*):<?(\d+):(\d+)>?$/.exec(sig);
    const enclosing = m ? idBySig.get(m[1] as string) : undefined;
    const id = m && enclosing ? `${enclosing}@${m[2]}:${m[3]}` : `${appId}/@synthetic/${encodeURIComponent(sig)}`;
    idBySig.set(sig, id);
    out[id] = {
      id,
      kind: "callable",
      name: sc.name,
      path: sc.path,
      span: { start: [sc.start_line, sc.start_column], end: [sc.start_line, sc.start_column], bytes: [0, 0] },
    };
  }
  return out;
}
