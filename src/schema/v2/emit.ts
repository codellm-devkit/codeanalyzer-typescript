/**
 * v1 in-memory model → schema-v2 `analysis.json`. A pure transform: it reshapes the tree,
 * assigns `can://` ids, and renames edge fields — it never re-parses. The parsing/resolution
 * guts (buildSymbolTable, call graph, dataflow) are untouched; only this serialization is new.
 *
 * Level scope: this emits **L1** — the containment tree (modules → types/functions/fields →
 * callables → `body` call nodes) with `can://` ids, precise spans, and per-module `source`.
 * `call_graph`/`param_in`/`param_out` are emitted empty here and populated by later levels
 * (`call_graph` at L2). The `idBySig` map built during the walk is what L2 will use to rewrite
 * edges, and doubles as the L1 id-uniqueness gate.
 */

import * as path from "node:path";
import type { AnalysisOptions } from "../../options";
import { ANALYZER_VERSION } from "../../utils/version";
import type {
  TSApplication,
  TSCallable,
  TSClass,
  TSClassAttribute,
  TSEnum,
  TSInterface,
  TSModule,
  TSNamespace,
  TSSpan,
  TSTypeAlias,
  TSVariableDeclaration,
} from "../schema";
import { applyDataflow } from "./dataflow";
import type { V2Application, V2BodyNode, V2CallEdge, V2Callable, V2External, V2Field, V2Module, V2Node, V2Root, V2Type } from "./model";

const LANGUAGE = "typescript";
const SCHEMA_VERSION = "2.0.0";
const ANALYZER_NAME = "codeanalyzer-typescript";
/** Highest analysis level this emitter populates today (L1 tree, L2 call graph, L3/L4 dataflow). */
const MAX_IMPLEMENTED = 4;

/** Structural / replaced / cache-metadata keys stripped before carrying language-native attrs. */
const DROP = new Set<string>([
  "code",
  "span",
  "path",
  "file_path",
  "module_name",
  "start_line",
  "end_line",
  "start_column",
  "end_column",
  "code_start_line",
  "bytes",
  "methods",
  "attributes",
  "members",
  "properties",
  "classes",
  "interfaces",
  "enums",
  "type_aliases",
  "namespaces",
  "functions",
  "variables",
  "call_sites",
  "inner_callables",
  "inner_classes",
  "local_variables",
  "content_hash",
  "last_modified",
  "file_size",
  "callee_signature",
]);

/**
 * Recursively drop `null`/`undefined` — the canonical convention is "a fact is present or absent;
 * there is no null" (the one exception, a call node's `callee: null`, is set explicitly outside
 * carry()). Nested nulls (e.g. a parameter's `default_value`, an import's `alias`) go too.
 */
function pruneNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(pruneNulls);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === null || val === undefined) continue;
      out[k] = pruneNulls(val);
    }
    return out;
  }
  return v;
}

/** Copy a v1 node's language-native attributes (everything not structural/replaced), null-pruned. */
function carry(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP.has(k) || v === null || v === undefined) continue;
    out[k] = pruneNulls(v);
  }
  return out;
}

/** The containment-path id of a descendant, derived from its dotted signature. */
function idFromSig(moduleId: string, modulePrefix: string, sig: string): string {
  const tail = sig.startsWith(`${modulePrefix}.`) ? sig.slice(modulePrefix.length + 1) : sig;
  return `${moduleId}/${tail.split(".").join("/")}`;
}

/** The map key for a callable/type within its parent: the last signature segment (+ accessor tag). */
function memberKey(sig: string, accessorKind?: string | null): string {
  const seg = sig.split(".").pop() ?? sig;
  if (accessorKind === "getter") return `${seg}#get`;
  if (accessorKind === "setter") return `${seg}#set`;
  return seg;
}

/** A type's heritage signatures, resolved to `can://` ids once the whole tree walk registers them. */
interface PendingHeritage {
  node: V2Type;
  extendsSigs: string[]; // class: the extended base class; interface: extended interface(s)
  implementsSigs: string[]; // class only: implemented interfaces
}

/** State shared across the whole tree walk (edge-rewriting + gating). */
interface SharedState {
  idBySig: Map<string, string>;
  collisions: string[];
  pendingCallees: Array<{ node: V2BodyNode; calleeSig: string | null }>; // backfilled at L2
  pendingHeritage: PendingHeritage[]; // resolved sig→id once the whole tree walk completes
  callableBySig: Map<string, V2Callable>; // locates each callable's node for the L3/L4 dataflow pass
  level: number;
}

interface Ctx extends SharedState {
  moduleId: string;
  modulePrefix: string;
}

function register(ctx: Ctx, sig: string, id: string): void {
  if (ctx.idBySig.has(sig) && ctx.idBySig.get(sig) !== id) ctx.collisions.push(sig);
  ctx.idBySig.set(sig, id);
}

// ----------------------------------------------------------------------------------------------
// body (L1: call sites → `call` nodes keyed by line:col)
// ----------------------------------------------------------------------------------------------

function toBody(c: TSCallable, ctx: Ctx): Record<string, V2BodyNode> {
  const body: Record<string, V2BodyNode> = {};
  for (const cs of c.call_sites ?? []) {
    const span: TSSpan = {
      start: [cs.start_line, cs.start_column],
      end: [cs.end_line, cs.end_column],
      bytes: cs.bytes ?? [0, 0],
    };
    let key = `${cs.start_line}:${cs.start_column}`;
    for (let k = 2; key in body; k++) key = `${cs.start_line}:${cs.start_column}/${k}`; // chained calls share a start
    const node: V2BodyNode = { ...carry(cs as unknown as Record<string, unknown>), kind: "call", span, callee: null };
    body[key] = node;
    // callee stays null at L1; backfilled to a can:// id at L2 once external/synth ids are homed.
    ctx.pendingCallees.push({ node, calleeSig: cs.callee_signature ?? null });
  }
  return body;
}

// ----------------------------------------------------------------------------------------------
// callable
// ----------------------------------------------------------------------------------------------

function toCallable(c: TSCallable, ctx: Ctx): V2Callable {
  const id = idFromSig(ctx.moduleId, ctx.modulePrefix, c.signature);
  register(ctx, c.signature, id);
  const node: V2Callable = {
    ...carry(c as unknown as Record<string, unknown>),
    id,
    kind: c.kind,
    signature: c.signature,
    span: c.span,
    body: toBody(c, ctx),
  };
  ctx.callableBySig.set(c.signature, node); // for the L3/L4 dataflow pass
  const nestedCallables = c.inner_callables ?? {};
  if (Object.keys(nestedCallables).length) {
    node.callables = {};
    for (const inner of Object.values(nestedCallables)) node.callables[memberKey(inner.signature, inner.accessor_kind)] = toCallable(inner, ctx);
  }
  const nestedClasses = c.inner_classes ?? {};
  if (Object.keys(nestedClasses).length) {
    node.types = {};
    for (const cls of Object.values(nestedClasses)) node.types[memberKey(cls.signature)] = toClass(cls, ctx);
  }
  return node;
}

// ----------------------------------------------------------------------------------------------
// fields (module vars, class attributes, interface properties, enum members)
// ----------------------------------------------------------------------------------------------

function fieldNode(parentId: string, name: string, span: TSSpan | undefined, src: Record<string, unknown>): V2Field {
  return { ...carry(src), id: `${parentId}/${name}`, kind: "field", span };
}

// ----------------------------------------------------------------------------------------------
// type kinds
// ----------------------------------------------------------------------------------------------

function toClass(c: TSClass, ctx: Ctx): V2Type {
  const id = idFromSig(ctx.moduleId, ctx.modulePrefix, c.signature);
  register(ctx, c.signature, id);
  const callables: Record<string, V2Callable> = {};
  for (const m of Object.values(c.methods ?? {})) callables[memberKey(m.signature, m.accessor_kind)] = toCallable(m, ctx);
  const fields: Record<string, V2Field> = {};
  for (const [name, a] of Object.entries(c.attributes ?? {}))
    fields[name] = fieldNode(id, name, (a as TSClassAttribute).span, a as unknown as Record<string, unknown>);
  const node: V2Type = { ...carry(c as unknown as Record<string, unknown>), id, kind: "class", signature: c.signature, span: c.span, callables, fields };
  // `base_classes` is the union of extends + implements (schema.ts:231); subtract implements_types
  // to recover just the extended base class (0 or 1 — TS classes extend at most one class).
  if (c.base_classes.length) {
    const extendsSigs = c.base_classes.filter((s) => !c.implements_types.includes(s));
    ctx.pendingHeritage.push({ node, extendsSigs, implementsSigs: c.implements_types });
  }
  return node;
}

function toInterface(i: TSInterface, ctx: Ctx): V2Type {
  const id = idFromSig(ctx.moduleId, ctx.modulePrefix, i.signature);
  register(ctx, i.signature, id);
  const callables: Record<string, V2Callable> = {};
  for (const m of Object.values(i.methods ?? {})) callables[memberKey(m.signature, m.accessor_kind)] = toCallable(m, ctx);
  const fields: Record<string, V2Field> = {};
  for (const [name, p] of Object.entries(i.properties ?? {}))
    fields[name] = fieldNode(id, name, (p as TSClassAttribute).span, p as unknown as Record<string, unknown>);
  const node: V2Type = { ...carry(i as unknown as Record<string, unknown>), id, kind: "interface", signature: i.signature, span: i.span, callables, fields };
  // Interface heritage is extends-only (schema.ts:255) — an interface can extend other interfaces
  // (or, rarely, a class's instance type), but never "implements".
  if (i.base_classes.length) ctx.pendingHeritage.push({ node, extendsSigs: i.base_classes, implementsSigs: [] });
  return node;
}

function toEnum(e: TSEnum, ctx: Ctx): V2Type {
  const id = idFromSig(ctx.moduleId, ctx.modulePrefix, e.signature);
  register(ctx, e.signature, id);
  const fields: Record<string, V2Field> = {};
  for (const m of e.members ?? []) fields[m.name] = fieldNode(id, m.name, m.span, m as unknown as Record<string, unknown>);
  return { ...carry(e as unknown as Record<string, unknown>), id, kind: "enum", signature: e.signature, span: e.span, fields };
}

function toTypeAlias(t: TSTypeAlias, ctx: Ctx): V2Type {
  const id = idFromSig(ctx.moduleId, ctx.modulePrefix, t.signature);
  register(ctx, t.signature, id);
  return { ...carry(t as unknown as Record<string, unknown>), id, kind: "type_alias", signature: t.signature, span: t.span };
}

/** Gap A: a namespace is a nested *scope* — same buckets as a module (types/functions/fields). */
function toNamespace(ns: TSNamespace, ctx: Ctx): V2Type {
  const id = idFromSig(ctx.moduleId, ctx.modulePrefix, ns.signature);
  register(ctx, ns.signature, id);
  const types = collectTypes(ns, ctx);
  const functions: Record<string, V2Callable> = {};
  for (const fn of Object.values(ns.functions ?? {})) functions[memberKey(fn.signature, fn.accessor_kind)] = toCallable(fn, ctx);
  const fields: Record<string, V2Field> = {};
  for (const v of ns.variables ?? []) fields[v.name] = fieldNode(id, v.name, v.span, v as unknown as Record<string, unknown>);
  return { ...carry(ns as unknown as Record<string, unknown>), id, kind: "namespace", signature: ns.signature, span: ns.span, types, functions, fields };
}

/** Merge a scope's class/interface/enum/type-alias/namespace buckets into one `types{}` map. */
function collectTypes(scope: { classes?: Record<string, TSClass>; interfaces?: Record<string, TSInterface>; enums?: Record<string, TSEnum>; type_aliases?: Record<string, TSTypeAlias>; namespaces?: Record<string, TSNamespace> }, ctx: Ctx): Record<string, V2Type> {
  const types: Record<string, V2Type> = {};
  for (const c of Object.values(scope.classes ?? {})) types[memberKey(c.signature)] = toClass(c, ctx);
  for (const i of Object.values(scope.interfaces ?? {})) types[memberKey(i.signature)] = toInterface(i, ctx);
  for (const e of Object.values(scope.enums ?? {})) types[memberKey(e.signature)] = toEnum(e, ctx);
  for (const t of Object.values(scope.type_aliases ?? {})) types[memberKey(t.signature)] = toTypeAlias(t, ctx);
  for (const ns of Object.values(scope.namespaces ?? {})) types[memberKey(ns.signature)] = toNamespace(ns, ctx);
  return types;
}

// ----------------------------------------------------------------------------------------------
// module
// ----------------------------------------------------------------------------------------------

function toModule(m: TSModule, moduleId: string, shared: SharedState): V2Module {
  const ctx: Ctx = { moduleId, modulePrefix: m.module_name, ...shared };
  const types = collectTypes(m, ctx);
  const functions: Record<string, V2Callable> = {};
  for (const fn of Object.values(m.functions ?? {})) functions[memberKey(fn.signature, fn.accessor_kind)] = toCallable(fn, ctx);
  const fields: Record<string, V2Field> = {};
  for (const v of m.variables ?? []) fields[(v as TSVariableDeclaration).name] = fieldNode(moduleId, v.name, v.span, v as unknown as Record<string, unknown>);
  return {
    ...carry(m as unknown as Record<string, unknown>),
    id: moduleId,
    kind: "module",
    source: m.source ?? "",
    span: m.span,
    types,
    functions,
    fields,
  };
}

// ----------------------------------------------------------------------------------------------
// L2 — edge-endpoint id homes (external library targets + first-party anonymous callbacks)
// ----------------------------------------------------------------------------------------------

/** External library call targets → `can://…/@external/<module>/<name>` ids on the application root. */
function homeExternals(app: TSApplication, appId: string, idBySig: Map<string, string>): Record<string, V2External> {
  const out: Record<string, V2External> = {};
  for (const [sig, ext] of Object.entries(app.external_symbols ?? {})) {
    const id = `${appId}/@external/${ext.module}/${ext.name}`;
    idBySig.set(sig, id);
    out[id] = { id, kind: "external", module: ext.module, name: ext.name };
  }
  return out;
}

/**
 * First-party anonymous callbacks (Jelly resolves them as endpoints; the symbol table never names
 * them). Their v1 signature is `<enclosing-sig>:<line:col>`, so they are addressed *ordinally* under
 * the enclosing callable: `<enclosing-can-id>@<line>:<col>` (the two-tier identity rule below the
 * callable line).
 */
function homeSynthesized(app: TSApplication, appId: string, idBySig: Map<string, string>): Record<string, V2Node> {
  const out: Record<string, V2Node> = {};
  for (const [sig, sc] of Object.entries(app.synthesized_callables ?? {})) {
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

// ----------------------------------------------------------------------------------------------
// entry point
// ----------------------------------------------------------------------------------------------

export interface ToV2Result {
  application: V2Application;
  idBySig: Map<string, string>; // signature → can:// id (real callables + externals + synthesized)
  collisions: string[]; // signatures that mapped to two distinct ids (L1 id-uniqueness gate)
  dangling: string[]; // call-graph endpoints with no id home (L2 no-dangling gate; should be empty)
}

export function toV2Detailed(app: TSApplication, opts: AnalysisOptions): ToV2Result {
  const level = opts.analysisLevel;
  const appName = (opts.appName ?? (opts.input ? path.basename(opts.input) : "") ?? "").trim() || "app";
  const appId = `can://${LANGUAGE}/${appName}`;
  const idBySig = new Map<string, string>();
  const collisions: string[] = [];
  const pendingCallees: Array<{ node: V2BodyNode; calleeSig: string | null }> = [];
  const pendingHeritage: PendingHeritage[] = [];
  const callableBySig = new Map<string, V2Callable>();
  const shared: SharedState = { idBySig, collisions, pendingCallees, pendingHeritage, callableBySig, level };

  // L1 — the containment tree (registers every real callable/type id in idBySig).
  const symbol_table: Record<string, V2Module> = {};
  for (const [fileKey, m] of Object.entries(app.symbol_table)) {
    symbol_table[fileKey] = toModule(m, `${appId}/${fileKey}`, shared);
  }
  const root: V2Root = { id: appId, kind: "application", symbol_table, call_graph: [], param_in: [], param_out: [] };

  // Resolve heritage sig → can:// id now that every first-party type is registered in idBySig
  // (independent of level: types are homed during the unconditional L1 walk above). Unresolved
  // (external/library) supertypes are dropped, never nulled — the "resolved-only" rule.
  for (const { node, extendsSigs, implementsSigs } of pendingHeritage) {
    const extendsIds = extendsSigs.map((s) => idBySig.get(s)).filter((x): x is string => x !== undefined);
    const implementsIds = implementsSigs.map((s) => idBySig.get(s)).filter((x): x is string => x !== undefined);
    if (extendsIds.length) node.extends_ids = extendsIds;
    if (implementsIds.length) node.implements_ids = implementsIds;
  }

  // L2 — home the off-tree edge endpoints, backfill `callee`, rewrite the call graph.
  const dangling: string[] = [];
  if (level >= 2) {
    root.external_symbols = homeExternals(app, appId, idBySig);
    root.synthesized_callables = homeSynthesized(app, appId, idBySig);
    for (const { node, calleeSig } of pendingCallees) {
      if (calleeSig) node.callee = idBySig.get(calleeSig) ?? null;
    }
    root.call_graph = (app.call_graph ?? [])
      .map((e): V2CallEdge | null => {
        const src = idBySig.get(e.source);
        const dst = idBySig.get(e.target);
        if (!src) dangling.push(e.source);
        if (!dst) dangling.push(e.target);
        return src && dst ? { src, dst, prov: e.provenance, weight: e.weight } : null;
      })
      .filter((e): e is V2CallEdge => e !== null);
  }

  // L3/L4 — grow body{} + cfg/cdg/ddg/summary on callables and param_in/param_out on the app.
  let k_limit: number | undefined;
  if (level >= 3 && app.program_graphs) {
    applyDataflow(root, app, idBySig, callableBySig, level);
    k_limit = app.program_graphs.k_limit;
  }

  const application: V2Application = {
    schema_version: SCHEMA_VERSION,
    language: LANGUAGE,
    max_level: Math.min(level, MAX_IMPLEMENTED),
    ...(k_limit !== undefined ? { k_limit } : {}),
    analyzer: { name: ANALYZER_NAME, version: ANALYZER_VERSION },
    application: root,
  };
  return { application, idBySig, collisions, dangling };
}

/** The default L1 emitter surface: v1 app + options → schema-v2 Application. */
export function toV2(app: TSApplication, opts: AnalysisOptions): V2Application {
  return toV2Detailed(app, opts).application;
}
