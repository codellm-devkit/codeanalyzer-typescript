/**
 * project() — the pure projection from the schema-v2 additive-CPG tree (`V2Application`) to graph
 * rows. It walks the uniform tree (module → types/functions/fields → callables → body) emitting one
 * graph node per tree/body node keyed on its `can://` id, containment as HAS_x / DECLARES edges, and
 * every typed overlay (call_graph, cfg/cdg/ddg/summary, param_in/param_out) as a typed relationship.
 * No I/O: the writers (cypher snapshot / bolt incremental) consume the returned `GraphRows`.
 *
 * The graph is a second projection of the SAME v2 shape the JSON path emits (serialize.ts → toV2),
 * so JSON and graph never diverge. Every project-owned node carries `_module` (its owning file key,
 * for the incremental writer's per-module isolation); shared nodes (External) carry none.
 */

import type { V2Application, V2BodyNode, V2Callable, V2External, V2Field, V2Module, V2Node, V2Root, V2Type } from "../../schema/v2";
import { SCHEMA_VERSION } from "./schema";
import { type GraphRows, type NodeRef, type Prop, type Props, RowBuilder, prune } from "./rows";

/** The shared MERGE label + key every can://-id-keyed node is addressed by. */
const CAN = "CanNode";
const ref = (id: string): NodeRef => ({ label: CAN, keyProp: "id", value: id });

/** Fully-qualify a callable-local body key (mirrors dataflow.ts § fq — the SDK-shared rule). */
function fq(callableId: string, localKey: string): string {
  return localKey.startsWith("@") ? `${callableId}${localKey}` : `${callableId}@${localKey}`;
}

const KIND_LABEL: Record<string, string> = {
  module: "Module",
  class: "Class",
  interface: "Interface",
  enum: "Enum",
  type_alias: "TypeAlias",
  namespace: "Namespace",
  field: "Field",
  external: "External",
  function: "Callable",
  method: "Callable",
  constructor: "Callable",
  getter: "Callable",
  setter: "Callable",
  arrow: "Callable",
  function_expression: "Callable",
};

export function project(app: V2Application, _appName?: string): GraphRows {
  const b = new RowBuilder();
  const root: V2Root = app.application;

  const appRef = b.node(["Application"], "id", root.id, prune({
    id: root.id,
    schema_version: SCHEMA_VERSION,
    language: app.language,
    max_level: app.max_level,
    k_limit: app.k_limit ?? null,
  }));

  for (const mod of Object.values(root.symbol_table)) {
    const fileKey = moduleKeyOf(mod);
    const modRef = b.node([CAN, "Module"], "id", mod.id, moduleProps(mod, fileKey));
    b.edge("HAS_MODULE", appRef, modRef);
    projectScope(b, mod, modRef, fileKey);
  }

  // External library targets (shared nodes — no _module).
  for (const ext of Object.values((root.external_symbols ?? {}) as Record<string, V2External>)) {
    b.node([CAN, "External"], "id", ext.id, prune({ id: ext.id, kind: "external", name: ext.name, module: ext.module }));
  }
  // First-party anonymous callbacks (edge endpoints the tree never names).
  for (const sc of Object.values((root.synthesized_callables ?? {}) as Record<string, V2Node>)) {
    b.node([CAN, "AnonymousCallable"], "id", sc.id, prune({
      id: sc.id, kind: "callable", name: str(sc.name), path: str(sc.path),
      start_line: spanLine(sc, "start"), start_column: spanCol(sc, "start"),
      _module: str(sc.path),
    }));
  }

  // Overlay edges (application scope): the call graph + interprocedural param flow.
  for (const e of root.call_graph) b.edge("CALLS", ref(e.src), ref(e.dst), prune({ weight: e.weight, prov: e.prov }));
  for (const e of root.param_in) b.edge("PARAM_IN", ref(idOf(e.src)), ref(idOf(e.dst)), prune({ var: e.var ?? null }));
  for (const e of root.param_out) b.edge("PARAM_OUT", ref(idOf(e.src)), ref(idOf(e.dst)), prune({ var: e.var ?? null }));

  return b.finish();
}

// ----------------------------------------------------------------------------------------------
// tree walk
// ----------------------------------------------------------------------------------------------

/** Walk a scope's child maps (module OR namespace: types + functions + fields). */
function projectScope(b: RowBuilder, scope: V2Module | V2Type, parent: NodeRef, fileKey: string): void {
  for (const t of Object.values(scope.types ?? {})) projectType(b, t, parent, fileKey);
  for (const c of Object.values(scope.functions ?? {})) projectCallable(b, c, parent, "DECLARES", fileKey);
  for (const f of Object.values(scope.fields ?? {})) projectField(b, f, parent, fileKey);
}

function projectType(b: RowBuilder, t: V2Type, parent: NodeRef, fileKey: string): void {
  const label = KIND_LABEL[t.kind] ?? "Class";
  const node = b.node([CAN, label], "id", t.id, typeProps(t, fileKey));
  b.edge("DECLARES", parent, node);
  // Inheritance overlay — resolved-only (emit.ts already dropped unresolved/external supertypes);
  // the deferred gate is defense-in-depth against a resolved id that never materialized as a node.
  for (const eid of t.extends_ids ?? []) b.edgeToSymbol("EXTENDS", node, eid);
  for (const iid of t.implements_ids ?? []) b.edgeToSymbol("IMPLEMENTS", node, iid);
  if (t.kind === "namespace") {
    projectScope(b, t, node, fileKey); // a namespace nests types/functions/fields
    return;
  }
  for (const c of Object.values(t.callables ?? {})) projectCallable(b, c, node, "HAS_METHOD", fileKey);
  for (const f of Object.values(t.fields ?? {})) projectField(b, f, node, fileKey);
}

function projectCallable(b: RowBuilder, c: V2Callable, owner: NodeRef, ownerRel: string, fileKey: string): void {
  const labels = hasEntrypoints(c) ? [CAN, "Callable", "Entrypoint"] : [CAN, "Callable"];
  const node = b.node(labels, "id", c.id, callableProps(c, fileKey));
  b.edge(ownerRel, owner, node);

  // Body nodes (L1: call sites; L3+: statements + synthetic vertices) + their overlays.
  for (const [localKey, bn] of Object.entries(c.body ?? {})) {
    const bid = fq(c.id, localKey);
    const bref = b.node([CAN, "BodyNode"], "id", bid, bodyProps(bn, bid, fileKey));
    b.edge("HAS_BODY_NODE", node, bref);
    if (typeof bn.callee === "string") b.edge("RESOLVES_TO", bref, ref(bn.callee));
  }
  for (const e of edges(c.cfg)) b.edge("CFG_NEXT", ref(fq(c.id, e.src)), ref(fq(c.id, e.dst)), prune({ kind: e.kind ?? null }));
  for (const e of edges(c.cdg)) b.edge("CDG", ref(fq(c.id, e.src)), ref(fq(c.id, e.dst)));
  for (const e of edges(c.ddg)) b.edge("DDG", ref(fq(c.id, e.src)), ref(fq(c.id, e.dst)), prune({ var: e.var ?? null, prov: e.prov ?? null }));
  for (const e of edges(c.summary)) b.edge("SUMMARY", ref(fq(c.id, e.src)), ref(fq(c.id, e.dst)), prune({ var: e.var ?? null }));

  // Nested callables (closures) + local classes.
  for (const cc of Object.values(c.callables ?? {})) projectCallable(b, cc, node, "DECLARES", fileKey);
  for (const t of Object.values(c.types ?? {})) projectType(b, t, node, fileKey);
}

function projectField(b: RowBuilder, f: V2Field, owner: NodeRef, fileKey: string): void {
  const node = b.node([CAN, "Field"], "id", f.id, prune({
    id: f.id, kind: "field", name: str(f.name), type: str((f as V2Node).type), ...span(f), _module: fileKey,
  }));
  b.edge("HAS_FIELD", owner, node);
}

// ----------------------------------------------------------------------------------------------
// property flattening (v2 node attrs → Neo4j-legal scalars/arrays)
// ----------------------------------------------------------------------------------------------

function moduleProps(mod: V2Module, fileKey: string): Props {
  return prune({
    id: mod.id, kind: "module", name: str((mod as V2Node).module_name) ?? fileKey,
    is_tsx: bool((mod as V2Node).is_tsx), is_declaration_file: bool((mod as V2Node).is_declaration_file),
    content_hash: str((mod as V2Node).content_hash), ...span(mod), _module: fileKey,
  });
}

function typeProps(t: V2Type, fileKey: string): Props {
  return prune({
    id: t.id, kind: t.kind, signature: str(t.signature), name: str((t as V2Node).name),
    base_classes: strArr((t as V2Node).base_classes), implements_types: strArr((t as V2Node).implements_types),
    aliased_type: str((t as V2Node).aliased_type),
    is_abstract: bool((t as V2Node).is_abstract), is_const: bool((t as V2Node).is_const),
    is_exported: bool((t as V2Node).is_exported), is_ambient: bool((t as V2Node).is_ambient),
    ...span(t), ...entrypointProps(t),
  });
}

function callableProps(c: V2Callable, fileKey: string): Props {
  return prune({
    id: c.id, kind: c.kind, signature: str(c.signature), name: str((c as V2Node).name),
    return_type: str((c as V2Node).return_type), cyclomatic_complexity: num((c as V2Node).cyclomatic_complexity),
    accessibility: str((c as V2Node).accessibility), accessor_kind: str((c as V2Node).accessor_kind),
    is_static: bool((c as V2Node).is_static), is_abstract: bool((c as V2Node).is_abstract),
    is_async: bool((c as V2Node).is_async), is_generator: bool((c as V2Node).is_generator),
    is_exported: bool((c as V2Node).is_exported), is_ambient: bool((c as V2Node).is_ambient),
    is_implicit: bool((c as V2Node).is_implicit), ...span(c), ...entrypointProps(c), _module: fileKey,
  });
}

function bodyProps(bn: V2BodyNode, id: string, fileKey: string): Props {
  return prune({
    id, kind: bn.kind, of: str(bn.of), parent: str(bn.parent),
    callee: typeof bn.callee === "string" ? bn.callee : null, ...span(bn), _module: fileKey,
  });
}

// ----------------------------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------------------------

interface Edge {
  src: string;
  dst: string;
  kind?: string;
  var?: string;
  prov?: string[];
}
const edges = (x: unknown): Edge[] => (Array.isArray(x) ? (x as Edge[]) : []);

/** Strip the `@local` suffix from a fully-qualified cross-edge endpoint — it IS the graph node id. */
const idOf = (endpoint: string): string => endpoint;

function moduleKeyOf(mod: V2Module): string {
  // id = can://<lang>/<app>/<fileKey>; the fileKey is everything after the 3rd '/' past the scheme.
  const m = /^can:\/\/[^/]+\/[^/]+\/(.+)$/.exec(mod.id);
  return m ? (m[1] as string) : mod.id;
}

function span(n: { span?: { start: [number, number]; end: [number, number] } }): { start_line?: number; end_line?: number } {
  if (!n.span) return {};
  return { start_line: n.span.start?.[0], end_line: n.span.end?.[0] };
}
function spanLine(n: V2Node, which: "start" | "end"): number | undefined {
  const s = n.span as { start?: [number, number]; end?: [number, number] } | undefined;
  return s?.[which]?.[0];
}
function spanCol(n: V2Node, which: "start" | "end"): number | undefined {
  const s = n.span as { start?: [number, number]; end?: [number, number] } | undefined;
  return s?.[which]?.[1];
}

function hasEntrypoints(n: V2Node): boolean {
  const eps = (n as Record<string, unknown>).entrypoints;
  return Array.isArray(eps) && eps.length > 0;
}

function entrypointProps(n: V2Node): Record<string, Prop> {
  const eps = (n as { entrypoints?: Array<{ framework?: string; detection_source?: string; route_path?: string; http_methods?: string[] }> }).entrypoints;
  if (!Array.isArray(eps) || !eps.length) return {};
  const first = eps[0] ?? {};
  const http = [...new Set(eps.flatMap((e) => (Array.isArray(e.http_methods) ? e.http_methods : [])))];
  return prune({
    framework: str(first.framework), detection_source: str(first.detection_source),
    route_path: str(first.route_path), http_methods: http.length ? http : null, entrypoint_count: eps.length,
  });
}

// value coercion (v2 attrs are `unknown`; Neo4j props must be scalars / homogeneous arrays)
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const strArr = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length ? (v as string[]) : null);
