/**
 * The declarative Neo4j schema (schema v2) — the single in-repo source of truth for the graph
 * contract: node labels with their keys and typed properties, relationship types and their
 * endpoints, and the Cypher DDL (uniqueness constraints + indexes). Constraints are DERIVED from
 * the node labels (one per distinct mergeLabel/key). `--emit schema` serializes all of this to
 * schema.neo4j.json, and the conformance test (test/neo4j-schema.test.ts) asserts the emitter
 * never produces an undeclared label / relationship / property.
 *
 * Schema v2 mirrors the additive-CPG JSON (canonical-schema.md): every tree/body node is a graph
 * node keyed on its `can://` id under the shared MERGE label `CanNode` (one uniqueness constraint,
 * uniform edge endpoints), carrying a specific kind label; containment renders as HAS_x / DECLARES
 * edges and every typed overlay (call_graph, cfg/cdg/ddg/summary, param_in/param_out) as a typed
 * relationship. TypeScript uses UNPREFIXED relationship names.
 *
 * SCHEMA_VERSION: MAJOR on a breaking change (renamed/removed label, relationship or key), MINOR
 * on additive. v2 is a MAJOR bump from v1 (keys moved signature→can:// id; labels reshaped).
 */
export const SCHEMA_VERSION = "2.0.0";

export type PropType = "string" | "integer" | "float" | "boolean" | "string[]" | "integer[]";

export interface NodeLabel {
  /** The specific label (also the key in NODE_LABELS). */
  label: string;
  /** The label the uniqueness constraint / MERGE is on (`CanNode` for can://-id-keyed nodes). */
  mergeLabel: string;
  key: string;
  properties: Record<string, PropType>;
}

export interface RelType {
  type: string;
  from: string[];
  to: string[];
  properties: Record<string, PropType>;
}

/** Labels layered onto a node in addition to its primary/specific label. */
export const MARKER_LABELS = ["Entrypoint"] as const;

/**
 * Language-namespace twins (transient dual-labeling, issue #65): every specific and marker label is
 * also stamped as `TS<Label>` so a shared multi-language database can attribute TS nodes (epic #64).
 * The shared MERGE labels (`Symbol`, `CanNode`) deliberately have NO twin — MERGE targets, keys and
 * constraints are unchanged. This dual-label state is transient; the vocabulary is finalized later.
 */
export const TS_PREFIX = "TS";

/** The TS-prefixed twin of a specific or marker label. */
export const twinOf = (label: string): string => `${TS_PREFIX}${label}`;

/** Shared merge labels never get a twin — they carry the constraint; node identity is unchanged. */
const UNTWINNED = new Set(["Symbol", "CanNode"]);

/**
 * Expand a projection label set with its twins: order preserved, shared merge labels skipped,
 * idempotent. Any label already starting with `TS` is treated as a twin and never re-prefixed — so
 * no bare label may legitimately begin with `TS`.
 */
export function withTwins(labels: string[]): string[] {
  const out = [...labels];
  for (const l of labels) {
    if (UNTWINNED.has(l) || l.startsWith(TS_PREFIX)) continue;
    const t = twinOf(l);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** The shared MERGE label for every can://-id-keyed node (one constraint; uniform edge endpoints). */
const CAN = "CanNode";
const SPAN = { start_line: "integer", end_line: "integer" } as const;
const ENTRYPOINT = {
  framework: "string",
  detection_source: "string",
  route_path: "string",
  http_methods: "string[]",
  entrypoint_count: "integer",
} as const;
/** Every can://-keyed node carries these. */
const COMMON = { id: "string", kind: "string", _module: "string" } as const;

export const NODE_LABELS: NodeLabel[] = [
  {
    label: "Application",
    mergeLabel: "Application",
    key: "id",
    properties: {
      id: "string", schema_version: "string", language: "string", max_level: "integer", k_limit: "integer",
      // Analyzer identity — mirrors the JSON envelope's `analyzer{name,version}` (issue #43),
      // namespaced (not bare name/version) to avoid colliding with the app-name param / every
      // other CanNode's bare `name`.
      analyzer_name: "string", analyzer_version: "string",
    },
  },
  {
    label: "Module",
    mergeLabel: CAN,
    key: "id",
    properties: { ...COMMON, name: "string", is_tsx: "boolean", is_declaration_file: "boolean", content_hash: "string", ...SPAN },
  },
  {
    label: "Class",
    mergeLabel: CAN,
    key: "id",
    properties: {
      ...COMMON, signature: "string", name: "string", base_classes: "string[]", implements_types: "string[]",
      is_abstract: "boolean", is_exported: "boolean", is_ambient: "boolean", ...SPAN, ...ENTRYPOINT,
    },
  },
  {
    label: "Interface",
    mergeLabel: CAN,
    key: "id",
    properties: { ...COMMON, signature: "string", name: "string", base_classes: "string[]", is_exported: "boolean", is_ambient: "boolean", ...SPAN },
  },
  {
    label: "Enum",
    mergeLabel: CAN,
    key: "id",
    properties: { ...COMMON, signature: "string", name: "string", is_const: "boolean", is_exported: "boolean", is_ambient: "boolean", ...SPAN },
  },
  {
    label: "TypeAlias",
    mergeLabel: CAN,
    key: "id",
    properties: { ...COMMON, signature: "string", name: "string", aliased_type: "string", is_exported: "boolean", is_ambient: "boolean", ...SPAN },
  },
  {
    label: "Namespace",
    mergeLabel: CAN,
    key: "id",
    properties: { ...COMMON, signature: "string", name: "string", is_exported: "boolean", is_ambient: "boolean", ...SPAN },
  },
  {
    label: "Callable",
    mergeLabel: CAN,
    key: "id",
    properties: {
      ...COMMON, signature: "string", name: "string", return_type: "string", cyclomatic_complexity: "integer",
      accessibility: "string", accessor_kind: "string", is_static: "boolean", is_abstract: "boolean",
      is_async: "boolean", is_generator: "boolean", is_exported: "boolean", is_ambient: "boolean", is_implicit: "boolean",
      ...SPAN, ...ENTRYPOINT,
    },
  },
  { label: "Field", mergeLabel: CAN, key: "id", properties: { ...COMMON, name: "string", type: "string", ...SPAN } },
  {
    // A statement / synthetic vertex inside a callable body (kind = statement|call|entry|exit|
    // formal_in|formal_out|actual_in|actual_out). `callee` on call nodes; `of`/`parent` on synthetics.
    label: "BodyNode",
    mergeLabel: CAN,
    key: "id",
    properties: { ...COMMON, of: "string", parent: "string", callee: "string", ...SPAN },
  },
  { label: "External", mergeLabel: CAN, key: "id", properties: { ...COMMON, name: "string", module: "string" } },
  {
    label: "AnonymousCallable",
    mergeLabel: CAN,
    key: "id",
    properties: { ...COMMON, name: "string", path: "string", start_line: "integer", start_column: "integer" },
  },
];

export const REL_TYPES: RelType[] = [
  { type: "HAS_MODULE", from: ["Application"], to: ["Module"], properties: {} },
  {
    type: "DECLARES",
    from: ["Module", "Namespace", "Callable"],
    to: ["Class", "Interface", "Enum", "TypeAlias", "Namespace", "Callable"],
    properties: {},
  },
  { type: "HAS_METHOD", from: ["Class", "Interface"], to: ["Callable"], properties: {} },
  { type: "HAS_FIELD", from: ["Module", "Class", "Interface", "Enum", "Namespace"], to: ["Field"], properties: {} },
  { type: "HAS_BODY_NODE", from: ["Callable", "AnonymousCallable"], to: ["BodyNode"], properties: {} },
  { type: "RESOLVES_TO", from: ["BodyNode"], to: ["Callable", "External", "AnonymousCallable"], properties: {} },
  {
    type: "CALLS",
    from: ["Callable", "AnonymousCallable"],
    to: ["Callable", "External", "AnonymousCallable"],
    properties: { weight: "integer", prov: "string[]" },
  },
  // `_k` is the relationship-identity discriminant (internal): CFG_NEXT merges per `kind`
  // (a conditional's true/false pair), DDG per `(var, prov)` (one dependence per variable, plus
  // the prov split) — a plain endpoint-pair MERGE would collapse legitimately-distinct edges
  // (issue #70).
  { type: "CFG_NEXT", from: ["BodyNode"], to: ["BodyNode"], properties: { kind: "string", _k: "string" } },
  { type: "CDG", from: ["BodyNode"], to: ["BodyNode"], properties: {} },
  { type: "DDG", from: ["BodyNode"], to: ["BodyNode"], properties: { var: "string", prov: "string[]", _k: "string" } },
  { type: "SUMMARY", from: ["BodyNode"], to: ["BodyNode"], properties: { var: "string" } },
  { type: "PARAM_IN", from: ["BodyNode"], to: ["BodyNode"], properties: { var: "string" } },
  { type: "PARAM_OUT", from: ["BodyNode"], to: ["BodyNode"], properties: { var: "string" } },
  // Inheritance, projected from the `extends_ids`/`implements_ids` node props (schema/v2/emit.ts) —
  // resolved-only: an unresolved (external/library) supertype never reaches here. A `to` of `Class`
  // covers TS's `implements SomeClass` (structural, not just interfaces); an interface may itself
  // `extends` a class's instance type, hence `EXTENDS` also allows an `Interface` source.
  { type: "EXTENDS", from: ["Class", "Interface"], to: ["Class", "Interface"], properties: {} },
  { type: "IMPLEMENTS", from: ["Class"], to: ["Interface", "Class"], properties: {} },
];

// ----------------------------------------------------------------------------------------------
// Cypher DDL — run BEFORE any load so MERGE uses an index seek. Idempotent (`IF NOT EXISTS`).
// ----------------------------------------------------------------------------------------------

/** One uniqueness constraint per distinct (mergeLabel, key) in NODE_LABELS — derived, never drifts. */
function uniquenessConstraints(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of NODE_LABELS) {
    const id = `${n.mergeLabel}.${n.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(
      `CREATE CONSTRAINT ${n.mergeLabel.toLowerCase()}_${n.key} IF NOT EXISTS ` +
        `FOR (x:${n.mergeLabel}) REQUIRE x.${n.key} IS UNIQUE`,
    );
  }
  return out;
}

export const CONSTRAINTS: readonly string[] = uniquenessConstraints();

/** Curated performance indexes (not 1:1 with labels, so declared explicitly). */
export const INDEXES: readonly string[] = [
  "CREATE INDEX callable_name IF NOT EXISTS FOR (c:Callable) ON (c.name)",
  "CREATE INDEX cannode_kind IF NOT EXISTS FOR (n:CanNode) ON (n.kind)",
];

export interface SchemaDocument {
  schema_version: string;
  generator: string;
  marker_labels: readonly string[];
  node_labels: NodeLabel[];
  relationship_types: RelType[];
  constraints: readonly string[];
  indexes: readonly string[];
  /** Specific/marker label → its TS-prefixed twin (both are present on every emitted node). */
  label_twins: Record<string, string>;
}

/** One twin per specific label + per marker label — derived from the catalogs, never drifts. */
function labelTwins(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of NODE_LABELS) out[n.label] = twinOf(n.label);
  for (const m of MARKER_LABELS) out[m] = twinOf(m);
  return out;
}

/** Build the full machine-readable schema document emitted by `--emit schema`. */
export function buildSchemaDocument(): SchemaDocument {
  return {
    schema_version: SCHEMA_VERSION,
    generator: "codeanalyzer-typescript",
    marker_labels: MARKER_LABELS,
    node_labels: NODE_LABELS,
    relationship_types: REL_TYPES,
    constraints: CONSTRAINTS,
    indexes: INDEXES,
    label_twins: labelTwins(),
  };
}
