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

import type { CfgEdge, FunctionGraphs, GraphNode, PdgEdge, ProgramGraphs } from "../schema/graphs";
import { type TSApplication, type TSCallable, type TSModule, type TSParamEdge, forEachCallable } from "../schema";
import { globalOrdinal, stampBodyIds } from "../schema/ids";
import type { OffsetMap } from "../schema/offsets";

import { offsetMapFor } from "../schema/offsets";
interface LocalIds {
  canId: string;
  callable: TSCallable;
  stmtLocal: Map<number, string>; // entry/exit/statement node id → body local id
  paramN: Map<number, number>; // param node id → declaration index N
  paramName: Map<number, string>; // param node id → the `of` name
  exitId: number;
  offsets: OffsetMap; // the owning module's char→byte map: IR offsets are chars, `span.bytes` are bytes (#179)
}

/** Build the per-callable node_id→local-id maps (single source-of-truth for every edge rewrite). */
function buildLocalIds(canId: string, callable: TSCallable, nodes: GraphNode[], offsets: OffsetMap): LocalIds {
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
  return { canId, callable, stmtLocal, paramN, paramName, exitId, offsets };
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
  return globalOrdinal(callableId, bodyKey); // single definition lives in schema/ids.ts (#164)
}

/** The IR's char offsets become the wire's UTF-8 byte offsets here (#179). */
function spanOf(n: GraphNode, offsets: OffsetMap): { start: [number, number]; end: [number, number]; bytes: [number, number] } {
  return { start: [n.start_line, n.start_column], end: [n.end_line, n.end_column], bytes: [offsets.toByte(n.start_offset), offsets.toByte(n.end_offset)] };
}

// ----------------------------------------------------------------------------------------------
// L3 — body statements + cfg/cdg/ddg on the callable (bare local ids)
// ----------------------------------------------------------------------------------------------

function emitL3(li: LocalIds, nodes: GraphNode[], cfgEdges: CfgEdge[] | undefined, pdgEdges: PdgEdge[] | undefined): void {
  const c = li.callable;
  // Grow body with entry/exit + statement nodes (params are contracted out; call nodes from L1 win).
  for (const n of nodes) {
    if (n.kind === "param") continue;
    const key = li.stmtLocal.get(n.id) as string;
    if (key in c.body) continue; // keep the richer L1 `call` node on a position collision
    c.body[key] = n.kind === "statement" ? { kind: "statement", span: spanOf(n, li.offsets) } : { kind: n.kind, span: spanOf(n, li.offsets) };
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
      if (e.type === "CDG") {
        const src = l3(li, e.source);
        const dst = l3(li, e.target);
        if (src !== dst) cdg.push({ src, dst });
      } else if (e.type === "DDG") {
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
    c.cdg = dedupe(cdg, (e) => `${e.src}\0${e.dst}`).sort(cmp2);
    c.ddg = dedupe(ddg, (e) => `${e.src}\0${e.dst}\0${e.var ?? ""}`).sort(cmpDdg);
  }
}

// ----------------------------------------------------------------------------------------------
// L4 — synthetic vertices + summary (callable) + param_in/param_out (application)
// ----------------------------------------------------------------------------------------------

function emitL4(root: TSApplication, pg: ProgramGraphs, info: Map<string, LocalIds>): void {
  // Formal vertices + the deferred formal-out-routing ddg edges, per callable.
  for (const [sig, fg] of Object.entries(pg.functions)) {
    const li = info.get(sig);
    if (!li) continue;
    const c = li.callable;
    for (const [nodeId, n] of li.paramN) c.body[`@formal_in:${n}`] = { kind: "formal_in", of: li.paramName.get(nodeId) };
    if (li.exitId >= 0) c.body["@formal_out"] = { kind: "formal_out", of: "$ret" };
    if (!c.summary) c.summary = [];
    const ddg = c.ddg as Array<{ src: string; dst: string; var?: string; prov: string[] }>;
    for (const e of fg.pdg?.edges ?? []) {
      if (e.type !== "DDG") continue;
      // return/global → EXIT ddg edges re-target @formal_out (syntactic routing; L4-placed vertex).
      if (e.target === li.exitId) ddg.push({ src: l3(li, e.source), dst: "@formal_out", var: e.var, prov: ["reaching-defs"] });
      // #81 (python #115 parity): `formal_in:n → first-use` — the same dependence L3 carries as
      // `@entry → stmt` (a param folds onto @entry below L4), re-sourced from the port so a walk that
      // enters through param_in does not dead-end at formal_in. Both edges stay: L3 keeps @entry.
      const n = li.paramN.get(e.source);
      if (n !== undefined && e.target !== li.exitId) ddg.push({ src: `@formal_in:${n}`, dst: l3(li, e.target), var: e.var, prov: ["reaching-defs"] });
    }
    ddg.sort(cmpDdg);
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
        bindDefsToActualIn(caller, pg.functions[e.source.signature], e.source.node, L, i);
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
        // #81: `actual_out → callsite` — the return value flows into the statement that made the
        // call; the caller's existing `L → use` edges carry it onward. Python's class exactly.
        pushDdg(caller.callable, { src: aout, dst: L, var: "$ret", prov: ["reaching-defs"] });
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

  // Determinism: sort the application-scope lists + each callable's summary and ddg (deduped:
  // the binding classes above can be reached from more than one sdg edge).
  root.param_in.sort(cmpEdgeVar);
  root.param_out.sort(cmpEdgeVar);
  for (const li of info.values()) {
    const s = li.callable.summary as Array<{ src: string; dst: string; var?: string }> | undefined;
    if (s) s.sort(cmpEdgeVar);
    const d = li.callable.ddg as Array<{ src: string; dst: string; var?: string; prov?: string[] }> | undefined;
    if (d) {
      const uniq = dedupe(d, (e) => `${e.src}\0${e.dst}\0${e.var ?? ""}\0${(e.prov ?? []).join(",")}`);
      d.length = 0;
      d.push(...uniq.sort(cmpDdg));
    }
  }
}

type DdgRow = { src: string; dst: string; var?: string; prov: string[] };
function pushDdg(c: TSCallable, row: DdgRow): void {
  ((c.ddg ??= []) as DdgRow[]).push(row);
}

/**
 * #81: `def stmt → actual_in:k` — argument binding at the call site. The intra-callable ddg says
 * which variables reach the call statement L (`X → L`, var v); the call site's own argument text
 * says which of them feeds argument k. Bound when v's head identifier appears as a whole word in
 * `arguments[k]`. A param reaching L binds from its port (`@formal_in:n`), the way l3() would fold
 * it onto @entry. Text matching is the ceiling here (no per-argument AST at this stage): a name
 * that is both a local and a property (`f(o.v)` with a local `v`) over-binds; a value threaded only
 * through a helper call inside the argument still binds, which is the reaching-defs reading.
 */
function bindDefsToActualIn(caller: LocalIds, fg: FunctionGraphs | undefined, callNode: number, L: string, k: number): void {
  const args = argumentTextsAt(caller, fg, callNode);
  const text = args?.[k];
  if (text === undefined) return;
  for (const e of fg?.pdg?.edges ?? []) {
    if (e.type !== "DDG" || e.target !== callNode || !e.var) continue;
    const head = /^[A-Za-z_$][\w$]*/.exec(e.var)?.[0];
    if (!head || !new RegExp(`(^|[^\\w$])${head.replace(/\$/g, "\\$")}(?![\\w$])`).test(text)) continue;
    const n = caller.paramN.get(e.source);
    const src = n !== undefined ? `@formal_in:${n}` : caller.stmtLocal.get(e.source);
    if (!src) continue;
    pushDdg(caller.callable, { src, dst: `${L}/actual_in:${k}`, var: e.var, prov: ["reaching-defs"] });
  }
}

/** The recorded call site (INTERNAL `call_sites`, still on the callable during this pass) that sits inside CFG node `callNode`. */
function argumentTextsAt(caller: LocalIds, fg: FunctionGraphs | undefined, callNode: number): string[] | undefined {
  const node = fg?.cfg?.nodes.find((x) => x.id === callNode);
  const sites = (caller.callable as unknown as { call_sites?: Array<{ start_line: number; start_column: number; end_line: number; end_column: number; arguments: string[] }> }).call_sites ?? [];
  if (!node) return undefined;
  const inside = sites.filter((s) =>
    (s.start_line > node.start_line || (s.start_line === node.start_line && s.start_column >= node.start_column)) &&
    (s.end_line < node.end_line || (s.end_line === node.end_line && s.end_column <= node.end_column)));
  // several calls in one statement (`f(g(x))`): the OUTERMOST is the one whose arguments PARAM_IN
  // describes for this statement; pick the earliest start, longest span.
  inside.sort((a, b) => a.start_line - b.start_line || a.start_column - b.start_column || (b.end_line - a.end_line) || (b.end_column - a.end_column));
  return inside[0]?.arguments;
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
): void {
  if (level < 3) return;

  // Each callable's owning module, for the char→byte map its body-node spans need (#179).
  const moduleOf = new Map<TSCallable, TSModule>();
  for (const mod of Object.values(root.symbol_table)) forEachCallable(mod, (c) => moduleOf.set(c, mod));

  const info = new Map<string, LocalIds>();
  for (const [sig, fg] of Object.entries(pg.functions)) {
    const callable = callableBySig.get(sig);
    const canId = idBySig.get(sig);
    const mod = callable && moduleOf.get(callable);
    if (!callable || !canId || !fg.cfg || !mod) continue;
    info.set(sig, buildLocalIds(canId, callable, fg.cfg.nodes, offsetMapFor(mod, mod.source)));
  }

  for (const [sig, fg] of Object.entries(pg.functions)) {
    const li = info.get(sig);
    if (!li) continue;
    emitL3(li, fg.cfg?.nodes ?? [], fg.cfg?.edges, fg.pdg?.edges);
  }

  if (level >= 4) emitL4(root, pg, info);
  // #164: every emitter above wrote body nodes (L3 statements; L4 formal/actual vertices, some into
  // CALLER bodies) — stamp once over every callable, idempotently, so `id` is present on all of them.
  for (const c of callableBySig.values()) stampBodyIds(c);
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
