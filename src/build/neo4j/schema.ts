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
 * relationship. At 2.0.0 (issue #66) the vocabulary is namespaced for TypeScript: every specific
 * node label is `TS`-prefixed (`TSModule`, `TSCallable`, ...; the shared MERGE labels `CanNode` and
 * `Application` stay bare) and every relationship type is `TS_`-prefixed (`TS_CALLS`, ...) — this
 * lets a shared multi-language database attribute TS-origin graph elements (epic #64) without a
 * transitional dual-labeling step.
 *
 * SCHEMA_VERSION: MAJOR on a breaking change (renamed/removed label, relationship or key), MINOR
 * on additive. v2 is a MAJOR bump from v1 (keys moved signature→can:// id; labels reshaped).
 */
export const SCHEMA_VERSION = "2.2.0";

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
export const MARKER_LABELS = [] as const;

/** The namespace prefix every specific node label and relationship type carries at 2.0.0 (#66). */
export const TS_PREFIX = "TS";

/** The shared MERGE label for every can://-id-keyed node (one constraint; uniform edge endpoints). */
const CAN = "CanNode";
const SPAN = { start_line: "integer", end_line: "integer" } as const;
/** Every can://-keyed node carries these. */
const COMMON = { id: "string", kind: "string", _module: "string" } as const;

export const NODE_LABELS: NodeLabel[] = [
  {
    label: "TSApplication",
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
  // Repository-artifact layer (#101, contract 2.2.0, python PR #160 parity): language-NEUTRAL
  // labels — the deliberate exception to TS-prefixing, so sibling analyzers MERGE onto the same
  // :Artifact/:Package nodes. Edges that stay this analyzer's own claim keep the TS_ prefix.
  {
    label: "Artifact",
    mergeLabel: "Artifact",
    key: "id",
    properties: {
      id: "string", kind: "string", path: "string", format: "string", roles: "string[]",
      size_bytes: "integer", sha256: "string", extraction: "string",
    },
  },
  {
    label: "Package",
    mergeLabel: "Package",
    key: "id",
    properties: { id: "string", ecosystem: "string", name: "string" },
  },
  {
    label: "TSModule",
    mergeLabel: CAN,
    key: "id",
    properties: { ...COMMON, name: "string", is_tsx: "boolean", is_declaration_file: "boolean", content_hash: "string", ...SPAN },
  },
  {
    label: "TSClass",
    mergeLabel: CAN,
    key: "id",
    properties: {
      ...COMMON, signature: "string", name: "string", base_classes: "string[]", implements_types: "string[]",
      is_abstract: "boolean", is_exported: "boolean", is_ambient: "boolean", ...SPAN,
    },
  },
  {
    label: "TSInterface",
    mergeLabel: CAN,
    key: "id",
    properties: { ...COMMON, signature: "string", name: "string", base_classes: "string[]", is_exported: "boolean", is_ambient: "boolean", ...SPAN },
  },
  {
    label: "TSEnum",
    mergeLabel: CAN,
    key: "id",
    properties: { ...COMMON, signature: "string", name: "string", is_const: "boolean", is_exported: "boolean", is_ambient: "boolean", ...SPAN },
  },
  {
    label: "TSTypeAlias",
    mergeLabel: CAN,
    key: "id",
    properties: { ...COMMON, signature: "string", name: "string", aliased_type: "string", is_exported: "boolean", is_ambient: "boolean", ...SPAN },
  },
  {
    label: "TSNamespace",
    mergeLabel: CAN,
    key: "id",
    properties: { ...COMMON, signature: "string", name: "string", is_exported: "boolean", is_ambient: "boolean", ...SPAN },
  },
  {
    label: "TSCallable",
    mergeLabel: CAN,
    key: "id",
    properties: {
      ...COMMON, signature: "string", name: "string", return_type: "string", cyclomatic_complexity: "integer",
      accessibility: "string", accessor_kind: "string", is_static: "boolean", is_abstract: "boolean",
      is_async: "boolean", is_generator: "boolean", is_exported: "boolean", is_ambient: "boolean", is_implicit: "boolean",
      ...SPAN,
    },
  },
  { label: "TSField", mergeLabel: CAN, key: "id", properties: { ...COMMON, name: "string", type: "string", ...SPAN } },
  {
    // A statement / synthetic vertex inside a callable body (kind = statement|call|entry|exit|
    // formal_in|formal_out|actual_in|actual_out). `callee` on call nodes; `of`/`parent` on synthetics.
    label: "TSBodyNode",
    mergeLabel: CAN,
    key: "id",
    properties: { ...COMMON, of: "string", parent: "string", callee: "string", ...SPAN },
  },
  { label: "TSExternal", mergeLabel: CAN, key: "id", properties: { ...COMMON, name: "string", module: "string" } },
  {
    // 2.1.0: a marker label carried *alongside* :TSCallable by an unnamed arrow / function
    // expression, which is now a real tree node reached by TS_DECLARES from its enclosing
    // callable. It is no longer a node kind of its own — the property set is TSCallable's — but
    // the label is retained so existing MATCH (:TSAnonymousCallable) queries keep resolving.
    label: "TSAnonymousCallable",
    mergeLabel: CAN,
    key: "id",
    properties: {
      ...COMMON, signature: "string", name: "string", return_type: "string", cyclomatic_complexity: "integer",
      accessibility: "string", accessor_kind: "string", is_static: "boolean", is_abstract: "boolean",
      is_async: "boolean", is_generator: "boolean", is_exported: "boolean", is_ambient: "boolean", is_implicit: "boolean",
      path: "string", start_column: "integer",
      ...SPAN,
    },
  },
];

export const REL_TYPES: RelType[] = [
  { type: "TS_HAS_MODULE", from: ["TSApplication"], to: ["TSModule"], properties: {} },
  // Repository-artifact layer (#101, contract 2.2.0, python PR #160 vocabulary)
  { type: "HAS_ARTIFACT", from: ["TSApplication"], to: ["Artifact"], properties: {} },
  {
    type: "DECLARES_DEPENDENCY",
    from: ["Artifact"],
    to: ["Package"],
    properties: { spec: "string", kind: "string", extras: "string[]", prov: "string[]" },
  },
  { type: "LOCKS", from: ["Artifact"], to: ["Package"], properties: { version: "string" } },
  { type: "TS_PROVIDES", from: ["Package"], to: ["TSExternal"], properties: {} },
  { type: "TS_UNRESOLVED_IMPORT", from: ["TSApplication"], to: ["TSExternal"], properties: { prov: "string[]" } },
  {
    type: "TS_DECLARES",
    from: ["TSModule", "TSNamespace", "TSCallable"],
    to: ["TSClass", "TSInterface", "TSEnum", "TSTypeAlias", "TSNamespace", "TSCallable"],
    properties: {},
  },
  { type: "TS_HAS_METHOD", from: ["TSClass", "TSInterface"], to: ["TSCallable"], properties: {} },
  { type: "TS_HAS_FIELD", from: ["TSModule", "TSClass", "TSInterface", "TSEnum", "TSNamespace"], to: ["TSField"], properties: {} },
  { type: "TS_HAS_BODY_NODE", from: ["TSCallable", "TSAnonymousCallable"], to: ["TSBodyNode"], properties: {} },
  { type: "TS_RESOLVES_TO", from: ["TSBodyNode"], to: ["TSCallable", "TSExternal", "TSAnonymousCallable"], properties: {} },
  {
    type: "TS_CALLS",
    from: ["TSCallable", "TSAnonymousCallable"],
    to: ["TSCallable", "TSExternal", "TSAnonymousCallable"],
    properties: { weight: "integer", prov: "string[]" },
  },
  // `_k` is the relationship-identity discriminant (internal): TS_CFG_NEXT merges per `kind`
  // (a conditional's true/false pair), TS_DDG per `(var, prov)` (one dependence per variable, plus
  // the prov split) — a plain endpoint-pair MERGE would collapse legitimately-distinct edges
  // (issue #70).
  { type: "TS_CFG_NEXT", from: ["TSBodyNode"], to: ["TSBodyNode"], properties: { kind: "string", _k: "string" } },
  { type: "TS_CDG", from: ["TSBodyNode"], to: ["TSBodyNode"], properties: {} },
  { type: "TS_DDG", from: ["TSBodyNode"], to: ["TSBodyNode"], properties: { var: "string", prov: "string[]", _k: "string" } },
  { type: "TS_SUMMARY", from: ["TSBodyNode"], to: ["TSBodyNode"], properties: { var: "string" } },
  { type: "TS_PARAM_IN", from: ["TSBodyNode"], to: ["TSBodyNode"], properties: { var: "string" } },
  { type: "TS_PARAM_OUT", from: ["TSBodyNode"], to: ["TSBodyNode"], properties: { var: "string" } },
  // Inheritance, projected from the `extends_ids`/`implements_ids` node props (the heritage pass, schema/heritage.ts) —
  // resolved-only: an unresolved (external/library) supertype never reaches here. A `to` of `TSClass`
  // covers TS's `implements SomeClass` (structural, not just interfaces); an interface may itself
  // `extends` a class's instance type, hence `TS_EXTENDS` also allows a `TSInterface` source.
  { type: "TS_EXTENDS", from: ["TSClass", "TSInterface"], to: ["TSClass", "TSInterface"], properties: {} },
  { type: "TS_IMPLEMENTS", from: ["TSClass"], to: ["TSInterface", "TSClass"], properties: {} },
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
  "CREATE INDEX callable_name IF NOT EXISTS FOR (c:TSCallable) ON (c.name)",
  "CREATE INDEX cannode_kind IF NOT EXISTS FOR (n:CanNode) ON (n.kind)",
  // Backs the bolt writer's per-module edge-delete + vanished-decl sweep, which anchor on
  // `(:CanNode {_module})` — without this they would scan the whole node store.
  "CREATE INDEX cannode_module IF NOT EXISTS FOR (n:CanNode) ON (n._module)",
];

export interface SchemaDocument {
  schema_version: string;
  generator: string;
  marker_labels: readonly string[];
  node_labels: NodeLabel[];
  relationship_types: RelType[];
  constraints: readonly string[];
  indexes: readonly string[];
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
  };
}
