/**
 * L3/L4 dataflow → the v2 tree (the ATTACH step): the stage that computes the program graphs also
 * writes them onto the tree (python parity). Transforms the internal `program_graphs` compute IR
 * (CFG / PDG[=CDG+DDG] / SDG, keyed by (signature, integer node_id)) into the additive-CPG
 * placement:
 *
 *   L3 (-a 3): grow each callable's `body{}` with statement nodes (+ `@entry`/`@exit`), and hang
 *              the intra-callable edge lists `cfg`/`cdg`/`ddg` (bare local ids) on the callable.
 *   L4 (-a 4): add the synthetic `@formal_in:N`/`@formal_out`/`<L>/actual_in:N`/`<L>/actual_out`
 *              body vertices, the intra-caller `summary` list, and the application-scope
 *              cross-callable `param_in`/`param_out` lists (fully-qualified `canId@local` ids).
 *
 * A pure relabel of what the analyzer already computed — no re-analysis. See
 * .claude/SCHEMA_DECISIONS.md § "Schema v2 migration" and dataflow-graphs.md.
 * Node-kind mapping (grounded in the compute IR, schema/graphs.ts):
 *   entry→'@entry', exit→'@exit' (also '@formal_out' as a PARAM_OUT/formal-out anchor),
 *   param→contracted out of the L3 CFG; '@formal_in:N' at L4, statement→'line:col'.
 */

import type { CfgEdge, GraphNode, GraphSelector, PdgEdge, ProgramGraphs } from "../schema/graphs";
import type { TSApplication, TSCallable, TSParamEdge } from "../schema";

interface LocalIds {
  canId: string;
  callable: TSCallable;
  stmtLocal: Map<number, string>; // entry/exit/statement node id → body local id
  paramN: Map<number, number>; // param node id → declaration index N
  paramName: Map<number, string>; // param node id → the `of` name
  exitId: number;
}

/** Build the per-callable node_id→local-id maps (single source-of-truth for every edge rewrite). */
function buildLocalIds(canId: string, callable: TSCallable, nodes: GraphNode[]): LocalIds {
  const stmtLocal = new Map<number, string>();
  const paramN = new Map<number, number>();
  const paramName = new Map<number, string>();
  const used = new Set<string>();
  const params = (callable as unknown as { parameters?: Array<{ name: string }> }).parameters ?? [];
  let exitId = -1;
  let pIdx = 0;
  for (const n of nodes) {
    if (n.kind === "entry") stmtLocal.set(n.id, "@entry");
    else if (n.kind === "exit") {
      exitId = n.id;
      stmtLocal.set(n.id, "@exit");
    } else if (n.kind === "param") {
      paramN.set(n.id, pIdx);
      paramName.set(n.id, params[pIdx]?.name ?? `arg${pIdx}`);
      pIdx++;
    } else {
      let key = `${n.start_line}:${n.start_column}`;
      if (used.has(key)) key = `${key}#${n.id}`; // line:col collision → deterministic disambiguation
      used.add(key);
      stmtLocal.set(n.id, key);
    }
  }
  return { canId, callable, stmtLocal, paramN, paramName, exitId };
}

/** L3/CDG/DDG node resolution: a param folds onto `@entry` (params are defined at entry at L3). */
function l3(li: LocalIds, nodeId: number): string {
  return li.paramN.has(nodeId) ? "@entry" : (li.stmtLocal.get(nodeId) ?? `@n${nodeId}`);
}

/**
 * Fully-qualify a callable-local body key into a cross-callable id (`<callable-id>@<local>`).
 * Synthetic keys (`@entry`/`@formal_in:N`/`@formal_out`) already carry the `@`; positional keys
 * (`line:col`, `line:col/actual_*`) get the `@` separator prepended. A resolver strips the callable
 * id, then matches the remainder OR the remainder without its leading `@`.
 */
function fq(callableId: string, bodyKey: string): string {
  return bodyKey.startsWith("@") ? `${callableId}${bodyKey}` : `${callableId}@${bodyKey}`;
}

function spanOf(n: GraphNode): { start: [number, number]; end: [number, number]; bytes: [number, number] } {
  return { start: [n.start_line, n.start_column], end: [n.end_line, n.end_column], bytes: [n.start_offset, n.end_offset] };
}

// ----------------------------------------------------------------------------------------------
// L3 — body statements + cfg/cdg/ddg on the callable (bare local ids)
// ----------------------------------------------------------------------------------------------

function emitL3(
  li: LocalIds,
  nodes: GraphNode[],
  cfgEdges: CfgEdge[] | undefined,
  pdgEdges: PdgEdge[] | undefined,
  emitCdg: boolean,
  emitDdg: boolean,
): void {
  const c = li.callable;
  // Grow body with entry/exit + statement nodes (params are contracted out; call nodes from L1 win).
  for (const n of nodes) {
    if (n.kind === "param") continue;
    const key = li.stmtLocal.get(n.id) as string;
    if (key in c.body) continue; // keep the richer L1 `call` node on a position collision
    c.body[key] = n.kind === "statement" ? { kind: "statement", span: spanOf(n) } : { kind: n.kind, span: spanOf(n) };
  }

  if (cfgEdges) {
    const cfg: Array<{ src: string; dst: string; kind: string }> = [];
    for (const e of cfgEdges) {
      if (li.paramN.has(e.target)) continue; // entry→param / param→param: contracted away
      const src = li.paramN.has(e.source) ? "@entry" : (li.stmtLocal.get(e.source) as string);
      const dst = li.stmtLocal.get(e.target) as string;
      cfg.push({ src, dst, kind: e.kind });
    }
    c.cfg = dedupe(cfg, (e) => `${e.src}\0${e.dst}\0${e.kind}`).sort(cmp3);
  }

  if (pdgEdges) {
    const cdg: Array<{ src: string; dst: string }> = [];
    const ddg: Array<{ src: string; dst: string; var?: string; prov: string[] }> = [];
    for (const e of pdgEdges) {
      if (e.type === "CDG" && emitCdg) {
        const src = l3(li, e.source);
        const dst = l3(li, e.target);
        if (src !== dst) cdg.push({ src, dst });
      } else if (e.type === "DDG" && emitDdg) {
        if (e.target === li.exitId) continue; // formal-out routing → deferred to L4 (→ @formal_out)
        // prov = the def-use METHOD: `solveDefUse` computes forward may-reaching-definitions over
        // k-limited access paths with a flow-insensitive copy/field-alias substrate (defuse.ts). It
        // is NOT SSA and NOT points-to-oracle-backed — so we tag it "reaching-defs", not "ssa".
        // A real points-to layer (PR F) would emit additional edges tagged "points-to".
        // "reaching-defs" is a SANCTIONED ADDITIVE prov token — a deliberate, documented deviation
        // from the shared cross-analyzer vocabulary's canonical "ssa" tag for the L3 syntactic DDG.
        // Recorded in `.claude/SCHEMA_DECISIONS.md` (issue #32); JSON, Neo4j (`ddg.prov: string[]`,
        // not an enum), and the SDK model must all accept it alongside "ssa"/"points-to".
        ddg.push({ src: l3(li, e.source), dst: l3(li, e.target), var: e.var, prov: ["reaching-defs"] });
      }
    }
    if (emitCdg) c.cdg = dedupe(cdg, (e) => `${e.src}\0${e.dst}`).sort(cmp2);
    if (emitDdg) c.ddg = dedupe(ddg, (e) => `${e.src}\0${e.dst}\0${e.var ?? ""}`).sort(cmpDdg);
  }
}

// ----------------------------------------------------------------------------------------------
// L4 — synthetic vertices + summary (callable) + param_in/param_out (application)
// ----------------------------------------------------------------------------------------------

function emitL4(root: TSApplication, pg: ProgramGraphs, info: Map<string, LocalIds>, emitDdg: boolean): void {
  // Formal vertices + the deferred formal-out-routing DDG edges, per callable.
  for (const [sig, fg] of Object.entries(pg.functions)) {
    const li = info.get(sig);
    if (!li) continue;
    const c = li.callable;
    for (const [nodeId, n] of li.paramN) c.body[`@formal_in:${n}`] = { kind: "formal_in", of: li.paramName.get(nodeId) };
    if (li.exitId >= 0) c.body["@formal_out"] = { kind: "formal_out", of: "$ret" };
    if (!c.summary) c.summary = [];
    // Return/global → EXIT DDG edges re-target @formal_out (syntactic routing; L4-placed vertex).
    if (emitDdg) {
      for (const e of fg.pdg?.edges ?? []) {
        if (e.type === "DDG" && e.target === li.exitId) {
          c.ddg?.push({
            src: l3(li, e.source),
            dst: "@formal_out",
            var: e.var,
            prov: ["reaching-defs"],
          });
        }
      }
      c.ddg?.sort(cmpDdg);
    }
  }

  // Cross-function SDG edges → param_in/param_out (app) + summary (callable) + actual vertices.
  for (const e of pg.sdg_edges) {
    if (e.type === "CALL") continue; // subsumed by L2 call_graph + body-node callee
    const arg = /^arg(\d+)$/.exec(e.var ?? "");
    if (e.type === "PARAM_IN") {
      const caller = info.get(e.source.signature);
      if (!caller) continue;
      const L = caller.stmtLocal.get(e.source.node);
      if (!L) continue;
      const callee = info.get(e.target.signature);
      if (arg && callee) {
        const i = Number(arg[1]);
        const ain = `${L}/actual_in:${i}`;
        caller.callable.body[ain] = { kind: "actual_in", of: `arg${i}`, parent: L };
        const n = callee.paramN.get(e.target.node);
        if (n === undefined) continue;
        root.param_in.push({ src: fq(caller.canId, ain), dst: fq(callee.canId, `@formal_in:${n}`) });
      } else if (callee) {
        // global read: rides in at the callee entry, carrying the global path.
        root.param_in.push({ src: fq(caller.canId, L), dst: fq(callee.canId, "@entry"), var: e.var });
      }
    } else if (e.type === "PARAM_OUT") {
      const callee = info.get(e.source.signature);
      const caller = info.get(e.target.signature);
      if (!callee || !caller) continue;
      const L = caller.stmtLocal.get(e.target.node);
      if (!L) continue;
      if ((e.var ?? "") === "return") {
        const aout = `${L}/actual_out`;
        caller.callable.body[aout] = { kind: "actual_out", of: "$ret", parent: L };
        root.param_out.push({ src: fq(callee.canId, "@formal_out"), dst: fq(caller.canId, aout) });
      } else {
        // global write: flows back from the callee formal-out to the caller's callsite.
        root.param_out.push({ src: fq(callee.canId, "@formal_out"), dst: fq(caller.canId, L), var: e.var });
      }
    } else if (e.type === "SUMMARY") {
      const caller = info.get(e.source.signature);
      if (!caller) continue;
      const L = caller.stmtLocal.get(e.source.node);
      if (!L) continue;
      const summary = caller.callable.summary as Array<{ src: string; dst: string; var?: string }>;
      if (arg) {
        const i = Number(arg[1]);
        const ain = `${L}/actual_in:${i}`;
        const aout = `${L}/actual_out`;
        if (!(ain in caller.callable.body)) caller.callable.body[ain] = { kind: "actual_in", of: `arg${i}`, parent: L };
        if (!(aout in caller.callable.body)) caller.callable.body[aout] = { kind: "actual_out", of: "$ret", parent: L };
        summary.push({ src: ain, dst: aout });
      } else {
        // global transitive flow: a self-edge on the callsite statement, carrying the global path.
        summary.push({ src: L, dst: L, var: e.var });
      }
    }
  }

  // Determinism: sort the application-scope lists + each callable's summary.
  root.param_in.sort(cmpEdgeVar);
  root.param_out.sort(cmpEdgeVar);
  for (const li of info.values()) {
    const s = li.callable.summary as Array<{ src: string; dst: string; var?: string }> | undefined;
    if (s) s.sort(cmpEdgeVar);
  }
}

// ----------------------------------------------------------------------------------------------
// entry point
// ----------------------------------------------------------------------------------------------

/**
 * Apply dataflow (L3, and L4 when `level >= 4`) onto the already-built v2 tree, in place.
 * `callableBySig` locates each callable's v2 node (populated during the L1 walk).
 */
export function applyDataflow(
  root: TSApplication,
  pg: ProgramGraphs,
  idBySig: Map<string, string>,
  callableBySig: Map<string, TSCallable>,
  level: number,
  selectors: readonly GraphSelector[],
): void {
  if (level < 3 || selectors.length === 0) return;

  const info = new Map<string, LocalIds>();
  for (const [sig, fg] of Object.entries(pg.functions)) {
    const callable = callableBySig.get(sig);
    const canId = idBySig.get(sig);
    if (!callable || !canId || !fg.cfg) continue;
    info.set(sig, buildLocalIds(canId, callable, fg.cfg.nodes));
  }

  const wantCfg = selectors.includes("cfg");
  const wantCdg = selectors.includes("pdg");
  const wantDdg = wantCdg || selectors.includes("dfg");
  for (const [sig, fg] of Object.entries(pg.functions)) {
    const li = info.get(sig);
    if (!li) continue;
    emitL3(li, fg.cfg?.nodes ?? [], wantCfg ? fg.cfg?.edges : undefined, fg.pdg?.edges, wantCdg, wantDdg);
  }

  if (level >= 4 && selectors.includes("sdg")) emitL4(root, pg, info, wantDdg);
}

// ----------------------------------------------------------------------------------------------
// small helpers
// ----------------------------------------------------------------------------------------------

function dedupe<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) {
    const k = key(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function cmp2(a: { src: string; dst: string }, b: { src: string; dst: string }): number {
  return a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst);
}
function cmp3(a: { src: string; dst: string; kind: string }, b: { src: string; dst: string; kind: string }): number {
  return cmp2(a, b) || a.kind.localeCompare(b.kind);
}
function cmpDdg(a: { src: string; dst: string; var?: string }, b: { src: string; dst: string; var?: string }): number {
  return cmp2(a, b) || (a.var ?? "").localeCompare(b.var ?? "");
}
function cmpEdgeVar(a: TSParamEdge, b: TSParamEdge): number {
  return a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst) || (a.var ?? "").localeCompare(b.var ?? "");
}
