/**
 * project() — the pure projection from the schema-v2 additive-CPG tree (`TSAnalysis`) to graph
 * rows. It walks the uniform tree (module → types/functions/fields → callables → body) emitting one
 * graph node per tree/body node keyed on its `can://` id, containment as HAS_x / DECLARES edges, and
 * every typed overlay (call_graph, cfg/cdg/ddg/summary, param_in/param_out) as a typed relationship.
 * No I/O: the writers (cypher snapshot / bolt incremental) consume the returned `GraphRows`.
 *
 * The graph is a second projection of the SAME v2 envelope the JSON path emits (finalizeAnalysis),
 * so JSON and graph never diverge. Every project-owned node carries `_module` (its owning file key,
 * for the incremental writer's per-module isolation); shared nodes (External) carry none.
 */

import type { TSAnalysis, TSApplication, TSBodyNode, TSCallable, TSDecorator, TSField, TSModule, TSType } from "../../schema";
import { purlNpm } from "../../schema/ids";
import { SCHEMA_VERSION } from "./schema";
import { type GraphRows, type NodeRef, type Props, RowBuilder, prune } from "./rows";

/** The shared MERGE label + key every can://-id-keyed node is addressed by. */
const CAN = "CanNode";
const ref = (id: string): NodeRef => ({ label: CAN, keyProp: "id", value: id });

/** Fully-qualify a callable-local body key (mirrors dataflow.ts § fq — the SDK-shared rule). */
function fq(callableId: string, localKey: string): string {
  return localKey.startsWith("@") ? `${callableId}${localKey}` : `${callableId}@${localKey}`;
}

const KIND_LABEL: Record<string, string> = {
  module: "TSModule",
  class: "TSClass",
  interface: "TSInterface",
  enum: "TSEnum",
  type_alias: "TSTypeAlias",
  namespace: "TSNamespace",
  field: "TSField",
  external: "TSExternal",
  function: "TSCallable",
  method: "TSCallable",
  constructor: "TSCallable",
  getter: "TSCallable",
  setter: "TSCallable",
  arrow: "TSCallable",
  function_expression: "TSCallable",
};

export function project(app: TSAnalysis, _appName?: string): GraphRows {
  const b = new RowBuilder();
  const root: TSApplication = app.application;

  const appRef = b.node(["Application", "TSApplication"], "id", root.id, prune({
    id: root.id,
    schema_version: SCHEMA_VERSION,
    language: app.language,
    max_level: app.max_level,
    k_limit: app.k_limit ?? null,
    // Same analyzer{name,version} the JSON envelope carries (emit.ts) — the two co-primary
    // projections must never diverge on analyzer identity (issue #43). Namespaced as
    // analyzer_name/analyzer_version (not bare name/version) to avoid colliding with the
    // app-name param (project()'s _appName) and every other CanNode's bare `name`.
    analyzer_name: app.analyzer.name,
    analyzer_version: app.analyzer.version,
  }));

  for (const mod of Object.values(root.symbol_table)) {
    const fileKey = moduleKeyOf(mod);
    const modRef = b.node([CAN, "TSModule"], "id", mod.id, moduleProps(mod, fileKey));
    b.edge("TS_HAS_MODULE", appRef, modRef);
    projectScope(b, mod, modRef, fileKey, mod.source ?? "");
  }

  // Repository-artifact layer (#101, python PR #160 parity): language-NEUTRAL :Artifact and
  // :Package (purl id) nodes — the deliberate exception to TS-prefixing, so sibling analyzers
  // MERGE onto the same nodes — plus this analyzer's own claims (TS_PROVIDES /
  // TS_UNRESOLVED_IMPORT) joining packages into the existing :TSExternal ghost id space.
  // `source` text stays off the graph (hash + size dereference to it).
  const importGhost = (name: string): NodeRef =>
    b.node([CAN, "TSExternal"], "id", `${root.id}/@external/${name}`, prune({
      id: `${root.id}/@external/${name}`, kind: "external", module: name,
    }));
  for (const art of Object.values(root.artifacts ?? {})) {
    const aRef = b.node(["Artifact"], "id", art.id, prune({
      id: art.id, kind: "artifact", path: art.path, format: art.format,
      roles: art.roles.length ? art.roles : null, size_bytes: art.size_bytes,
      sha256: art.sha256, extraction: art.extraction,
      // `source` belongs on the graph: python has carried it on :Artifact since it shipped the
      // layer, and a consumer reading the same neutral :Artifact node from two analyzers must not
      // get the text from one and nothing from the other. `--no-artifact-text` still empties it.
      source: art.source,
    }));
    b.edge("HAS_ARTIFACT", appRef, aRef);
    for (const ck of art.config_keys) {
      const kRef = b.node(["ConfigKey"], "id", ck.id, prune({
        id: ck.id, key: ck.key, namespace: ck.namespace,
        value: ck.value !== undefined ? String(ck.value) : null,
        references: ck.references.length ? ck.references : null,
      }));
      b.edge("DEFINES_CONFIG", aRef, kRef);
    }
  }
  {
    const lockIds = Object.values(root.artifacts ?? {})
      .filter((a) => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|bun\.lock|yarn\.lock|pnpm-lock\.yaml)$/.test(a.path))
      .map((a) => a.id)
      .sort();
    const seen = new Set<string>();
    for (const d of root.dependencies ?? []) {
      const pkgId = purlNpm(d.name);
      const pkgRef = b.node(["Package"], "id", pkgId, prune({ id: pkgId, ecosystem: "npm", name: d.name }));
      b.edge("DECLARES_DEPENDENCY", { label: "Artifact", keyProp: "id", value: d.declared_in }, pkgRef, prune({
        spec: d.spec || null, kind: d.kind, direct: d.direct, extras: d.extras.length ? d.extras : null,
        prov: d.prov.length ? d.prov : null,
      }), d.kind);
      if (d.locked_version) {
        for (const lockId of lockIds) {
          const k = `LOCKS\0${lockId}\0${pkgId}`;
          if (seen.has(k)) continue;
          seen.add(k);
          b.edge("LOCKS", { label: "Artifact", keyProp: "id", value: lockId }, pkgRef, prune({ version: d.locked_version }));
        }
      }
      for (const top of d.provides_imports) {
        const k = `PROV\0${pkgId}\0${top}`;
        if (seen.has(k)) continue;
        seen.add(k);
        b.edge("TS_PROVIDES", pkgRef, importGhost(top));
      }
    }
    for (const u of root.unresolved_imports ?? []) {
      b.edge("TS_UNRESOLVED_IMPORT", appRef, importGhost(u.module), prune({ prov: u.prov.length ? u.prov : null }));
    }
  }
  // config_use literal/dataflow tier (#101 unit C2/C3): src is a body-node ordinal id already
  // projected as a :CanNode above; dst is a :ConfigKey id, already projected in the artifact
  // loop. config_reads stay JSON-only — they record absence, not an edge.
  for (const u of root.config_uses ?? []) {
    b.edge("TS_USES_CONFIG", ref(u.src), { label: "ConfigKey", keyProp: "id", value: u.dst }, prune({ prov: u.prov }));
  }

  // External library targets (shared nodes — no _module).
  for (const ext of Object.values(root.external_symbols ?? {})) {
    b.node([CAN, "TSExternal"], "id", ext.id, prune({ id: ext.id, kind: "external", name: ext.name, module: ext.module }));
  }
  // 2.1.0: `synthesized_callables` is mostly a compatibility index (old id → tree id) whose targets
  // are already projected as tree nodes. Only the residual fallback entries — a signature no
  // provider could name, recognisable because the map key IS the entry's own id — still need a
  // standalone node, so call-graph edges pointing at them do not dangle.
  for (const [key, sc] of Object.entries(root.synthesized_callables ?? {})) {
    if (key !== sc.id) continue;
    b.node([CAN, "TSAnonymousCallable"], "id", sc.id, prune({
      id: sc.id, kind: "callable", name: sc.name ?? null, path: sc.path ?? null,
      start_line: sc.span?.start?.[0] ?? null, start_column: sc.span?.start?.[1] ?? null,
      _module: sc.path ?? null,
    }));
  }

  // Overlay edges (application scope): the call graph + interprocedural param flow.
  for (const e of root.call_graph) b.edge("TS_CALLS", ref(e.src), ref(e.dst), prune({ weight: e.weight, prov: e.prov }));
  for (const e of root.param_in) b.edge("TS_PARAM_IN", ref(idOf(e.src)), ref(idOf(e.dst)), prune({ var: e.var ?? null }));
  for (const e of root.param_out) b.edge("TS_PARAM_OUT", ref(idOf(e.src)), ref(idOf(e.dst)), prune({ var: e.var ?? null }));

  return b.finish();
}

// ----------------------------------------------------------------------------------------------
// tree walk
// ----------------------------------------------------------------------------------------------

/** Walk a scope's child maps (module OR namespace: types + functions + fields). */
function projectScope(b: RowBuilder, scope: TSModule | TSType, parent: NodeRef, fileKey: string, source: string): void {
  for (const t of Object.values(scope.types ?? {})) projectType(b, t, parent, fileKey, source);
  for (const c of Object.values(scope.functions ?? {})) projectCallable(b, c, parent, "TS_DECLARES", fileKey, source);
  for (const f of Object.values(scope.fields ?? {})) projectField(b, f, parent, fileKey);
}

function projectType(b: RowBuilder, t: TSType, parent: NodeRef, fileKey: string, source: string): void {
  const label = KIND_LABEL[t.kind] ?? "TSClass";
  const node = b.node([CAN, label], "id", t.id, typeProps(t, fileKey, source));
  b.edge("TS_DECLARES", parent, node);
  for (const d of t.decorators ?? []) projectDecorator(b, node, d);
  // Inheritance overlay — resolved-only (emit.ts already dropped unresolved/external supertypes);
  // the deferred gate is defense-in-depth against a resolved id that never materialized as a node.
  for (const eid of t.extends_ids ?? []) b.edgeToSymbol("TS_EXTENDS", node, eid);
  for (const iid of t.implements_ids ?? []) b.edgeToSymbol("TS_IMPLEMENTS", node, iid);
  if (t.kind === "namespace") {
    projectScope(b, t, node, fileKey, source); // a namespace nests types/functions/fields
    return;
  }
  for (const c of Object.values(t.callables ?? {})) projectCallable(b, c, node, "TS_HAS_METHOD", fileKey, source);
  for (const f of Object.values(t.fields ?? {})) projectField(b, f, node, fileKey);
}

/** An unnamed callable's signature ends with the positional segment `contributorName` gives it. */
const ANON_SIG = /\.<anon@\d+:\d+>$/;

function projectCallable(b: RowBuilder, c: TSCallable, owner: NodeRef, ownerRel: string, fileKey: string, source: string): void {
  // An unnamed callable carries :TSAnonymousCallable alongside :TSCallable — one node, two labels,
  // reached by ordinary containment. That is what keeps pre-2.1.0 MATCH (:TSAnonymousCallable)
  // queries working and puts these nodes on the snapshot wipe's containment walk (issue #75).
  const labels = ANON_SIG.test(c.signature) ? [CAN, "TSCallable", "TSAnonymousCallable"] : [CAN, "TSCallable"];
  const node = b.node(labels, "id", c.id, callableProps(c, fileKey, source));
  b.edge(ownerRel, owner, node);
  for (const d of c.decorators ?? []) projectDecorator(b, node, d);

  // Body nodes (L1: call sites; L3+: statements + synthetic vertices) + their overlays.
  for (const [localKey, bn] of Object.entries(c.body ?? {})) {
    const bid = fq(c.id, localKey);
    const bref = b.node([CAN, "TSBodyNode"], "id", bid, bodyProps(bn, bid, fileKey));
    b.edge("TS_HAS_BODY_NODE", node, bref);
    if (typeof bn.callee === "string") b.edge("TS_RESOLVES_TO", bref, ref(bn.callee));
  }
  // kind-discriminated: a conditional's true/false pair between one endpoint pair must stay
  // two relationships, not one MERGE (issue #70).
  for (const e of edges(c.cfg)) b.edge("TS_CFG_NEXT", ref(fq(c.id, e.src)), ref(fq(c.id, e.dst)), prune({ kind: e.kind ?? null }), e.kind ?? "");
  for (const e of edges(c.cdg)) b.edge("TS_CDG", ref(fq(c.id, e.src)), ref(fq(c.id, e.dst)));
  // (var, prov)-discriminated: the DDG legitimately carries several edges between one statement
  // pair (one per variable, and the prov split) — a plain endpoint-pair MERGE collapses them and
  // silently drops dependences (issue #70).
  for (const e of edges(c.ddg))
    b.edge("TS_DDG", ref(fq(c.id, e.src)), ref(fq(c.id, e.dst)), prune({ var: e.var ?? null, prov: e.prov ?? null }), `${e.var ?? ""}|${(e.prov ?? []).join(",")}`);
  for (const e of edges(c.summary)) b.edge("TS_SUMMARY", ref(fq(c.id, e.src)), ref(fq(c.id, e.dst)), prune({ var: e.var ?? null }));

  // Nested callables (closures) + local classes.
  for (const cc of Object.values(c.callables ?? {})) projectCallable(b, cc, node, "TS_DECLARES", fileKey, source);
  for (const t of Object.values(c.types ?? {})) projectType(b, t, node, fileKey, source);
}

/**
 * One decorator application (#82, mirrors python's `_project_decorator`).
 *
 * The merge key is the checker-resolved `qualified_name` when there is one, so `@Get` and
 * `@Get(':id')` collapse to a single node rather than two spellings of the same decorator. The
 * arguments are per-application and therefore ride on the relationship: `:TSDecorator` is shared
 * across modules and never pruned, so anything application-specific stored on it would accumulate.
 */
function projectDecorator(b: RowBuilder, on: NodeRef, d: TSDecorator): void {
  const key = d.qualified_name || d.name;
  const dec = b.node(["TSDecorator"], "name", key, { name: key, qualified_name: d.qualified_name ?? "" });
  b.edge("TS_DECORATED_BY", on, dec, {
    positional_arguments: [...(d.positional_arguments ?? [])],
    // Neo4j has no map property type; python encodes the same field as a sorted-key JSON string.
    keyword_arguments_json: JSON.stringify(sortedKeys(d.keyword_arguments ?? {})),
  });
}

/** Key-sorted shallow copy, so the encoded JSON is stable across runs (python sorts too). */
function sortedKeys(o: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k] as string;
  return out;
}

function projectField(b: RowBuilder, f: TSField, owner: NodeRef, fileKey: string): void {
  const node = b.node([CAN, "TSField"], "id", f.id, prune({
    id: f.id, kind: "field", name: f.name, type: f.type ?? null, ...span(f), _module: fileKey,
  }));
  b.edge("TS_HAS_FIELD", owner, node);
  for (const d of f.decorators ?? []) projectDecorator(b, node, d);
}

// ----------------------------------------------------------------------------------------------
// property flattening (v2 node attrs → Neo4j-legal scalars/arrays)
// ----------------------------------------------------------------------------------------------

/**
 * A declaration's text: the owning module's `source` sliced by the node's UTF-8 BYTE span.
 *
 * Schema v2 stores source once per module and every node carries `span.bytes`, so `code` is derived
 * here at projection time rather than duplicated into the tree — the same thing codeanalyzer-python
 * does (`neo4j/project.py::_span_code`), which is why its graph has `code` on :PyClass/:PyCallable
 * while its JSON does not. Ours declared neither, leaving TypeScript source unreachable from the
 * graph: no `code` on the node AND no `source` on :TSModule to slice from.
 *
 * Byte offsets, so this must slice a Buffer. String slicing would cut multi-byte UTF-8 mid-character.
 */
function spanCode(source: string, sp: { bytes?: [number, number] } | undefined): string | null {
  const bytes = sp?.bytes;
  if (!source || !bytes) return null;
  const [lo, hi] = bytes;
  if (hi <= lo) return null;
  return Buffer.from(source, "utf8").subarray(lo, hi).toString("utf8");
}

function moduleProps(mod: TSModule, fileKey: string): Props {
  // `name` is the file key. `content_hash` is what the incremental push diffs against on the next
  // run (bolt.ts) -- schema.ts has always declared it on :TSModule, but nothing wrote it (#118).
  return prune({
    id: mod.id, kind: "module", name: fileKey, content_hash: mod.content_hash ?? null,
    is_tsx: mod.is_tsx, is_declaration_file: mod.is_declaration_file,
    ...span(mod), _module: fileKey,
  });
}

function typeProps(t: TSType, fileKey: string, source: string): Props {
  return prune({
    id: t.id, kind: t.kind, signature: t.signature, name: t.name,
    base_classes: strArr(t.base_classes), implements_types: strArr(t.implements_types),
    aliased_type: t.aliased_type ?? null,
    is_abstract: t.is_abstract ?? null, is_const: t.is_const ?? null,
    is_exported: t.is_exported, is_ambient: t.is_ambient,
    code: spanCode(source, t.span), ...span(t),
  });
}

function callableProps(c: TSCallable, fileKey: string, source: string): Props {
  return prune({
    id: c.id, kind: c.kind, signature: c.signature, name: c.name,
    return_type: c.return_type ?? null, cyclomatic_complexity: c.cyclomatic_complexity,
    accessibility: c.accessibility ?? null, accessor_kind: c.accessor_kind ?? null,
    is_static: c.is_static, is_abstract: c.is_abstract,
    is_async: c.is_async, is_generator: c.is_generator,
    is_exported: c.is_exported, is_ambient: c.is_ambient,
    is_implicit: c.is_implicit, code: spanCode(source, c.span), ...span(c), _module: fileKey,
  });
}

function bodyProps(bn: TSBodyNode, id: string, fileKey: string): Props {
  return prune({
    id, kind: bn.kind, of: bn.of ?? null, parent: bn.parent ?? null,
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

/** A cross-edge endpoint is already the graph node's can:// id — pass it through unchanged. */
const idOf = (endpoint: string): string => endpoint;

function moduleKeyOf(mod: TSModule): string {
  // id = can://<lang>/<app>/<fileKey>; the fileKey is everything after the 3rd '/' past the scheme.
  const m = /^can:\/\/[^/]+\/[^/]+\/(.+)$/.exec(mod.id);
  return m ? (m[1] as string) : mod.id;
}

function span(n: { span?: { start: [number, number]; end: [number, number] } }): { start_line?: number; end_line?: number } {
  if (!n.span) return {};
  return { start_line: n.span.start?.[0], end_line: n.span.end?.[0] };
}
// A present-but-empty string list is a non-fact in the graph (matches the historical projection).
const strArr = (v: string[] | undefined): string[] | null => (v && v.length ? v : null);
