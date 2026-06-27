/**
 * The declarative Neo4j schema — the single in-repo source of truth for the graph contract: node
 * labels with their keys and typed properties, relationship types and their endpoints, and the
 * Cypher DDL (uniqueness constraints + indexes). The constraints are DERIVED from the node labels
 * (one per distinct mergeLabel/key) so a new label brings its own constraint — there is no second
 * list to keep in sync. `--emit schema` serializes all of this to a machine-readable schema.json,
 * and the conformance test (test/neo4j-schema.test.ts) asserts the real emitter never produces a
 * label / relationship / property that isn't declared here — so this file cannot silently drift
 * from project.ts.
 *
 * SCHEMA_VERSION is the contract version: bump MAJOR on a breaking change (renamed/removed label,
 * relationship or key), MINOR on an additive change (new label/rel/property). It is stamped onto
 * the :Application node of every emitted graph so any consumer can detect a producer/consumer
 * mismatch at runtime.
 */
export const SCHEMA_VERSION = "1.0.0";

export type PropType = "string" | "integer" | "float" | "boolean" | "string[]" | "integer[]";

export interface NodeLabel {
  /** The specific label (also the key in NODE_LABELS). */
  label: string;
  /** The label the uniqueness constraint / MERGE is on (`Symbol` for signature-keyed nodes). */
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

const SPAN = { start_line: "integer", end_line: "integer" } as const;
const ENTRYPOINT = {
  framework: "string",
  detection_source: "string",
  route_path: "string",
  http_methods: "string[]",
  entrypoint_count: "integer",
} as const;

export const NODE_LABELS: NodeLabel[] = [
  {
    label: "Application",
    mergeLabel: "Application",
    key: "name",
    properties: { name: "string", schema_version: "string" },
  },
  {
    label: "Module",
    mergeLabel: "Module",
    key: "file_key",
    properties: {
      file_key: "string",
      module_name: "string",
      is_tsx: "boolean",
      is_declaration_file: "boolean",
      content_hash: "string",
      last_modified: "integer",
      file_size: "integer",
      _module: "string",
    },
  },
  {
    label: "Class",
    mergeLabel: "Symbol",
    key: "signature",
    properties: {
      signature: "string",
      name: "string",
      code: "string",
      base_classes: "string[]",
      implements_types: "string[]",
      type_parameter_names: "string[]",
      docstring: "string",
      is_abstract: "boolean",
      is_exported: "boolean",
      is_ambient: "boolean",
      ...SPAN,
      ...ENTRYPOINT,
      _module: "string",
    },
  },
  {
    label: "Interface",
    mergeLabel: "Symbol",
    key: "signature",
    properties: {
      signature: "string",
      name: "string",
      code: "string",
      base_classes: "string[]",
      type_parameter_names: "string[]",
      call_signatures: "string[]",
      index_signatures: "string[]",
      docstring: "string",
      is_exported: "boolean",
      is_ambient: "boolean",
      ...SPAN,
      _module: "string",
    },
  },
  {
    label: "Enum",
    mergeLabel: "Symbol",
    key: "signature",
    properties: {
      signature: "string",
      name: "string",
      code: "string",
      member_names: "string[]",
      member_values: "string[]",
      docstring: "string",
      is_const: "boolean",
      is_exported: "boolean",
      is_ambient: "boolean",
      ...SPAN,
      _module: "string",
    },
  },
  {
    label: "TypeAlias",
    mergeLabel: "Symbol",
    key: "signature",
    properties: {
      signature: "string",
      name: "string",
      code: "string",
      aliased_type: "string",
      type_parameter_names: "string[]",
      docstring: "string",
      is_exported: "boolean",
      is_ambient: "boolean",
      ...SPAN,
      _module: "string",
    },
  },
  {
    label: "Namespace",
    mergeLabel: "Symbol",
    key: "signature",
    properties: {
      signature: "string",
      name: "string",
      docstring: "string",
      is_exported: "boolean",
      is_ambient: "boolean",
      ...SPAN,
      _module: "string",
    },
  },
  {
    label: "Callable",
    mergeLabel: "Symbol",
    key: "signature",
    properties: {
      signature: "string",
      name: "string",
      path: "string",
      kind: "string",
      return_type: "string",
      cyclomatic_complexity: "integer",
      code: "string",
      code_start_line: "integer",
      ...SPAN,
      accessibility: "string",
      accessor_kind: "string",
      docstring: "string",
      type_parameter_names: "string[]",
      parameters_json: "string",
      accessed_symbols_json: "string",
      is_static: "boolean",
      is_abstract: "boolean",
      is_async: "boolean",
      is_generator: "boolean",
      is_optional: "boolean",
      is_readonly: "boolean",
      is_exported: "boolean",
      is_ambient: "boolean",
      is_implicit: "boolean",
      ...ENTRYPOINT,
      _module: "string",
    },
  },
  {
    label: "External",
    mergeLabel: "Symbol",
    key: "signature",
    properties: { signature: "string", name: "string", module: "string" },
  },
  {
    // A first-party anonymous callback Jelly resolves as a call endpoint but the symbol table never
    // names. Thin (no code/params) — the signature carries identity; DECLARES links it to its host.
    label: "AnonymousCallable",
    mergeLabel: "Symbol",
    key: "signature",
    properties: {
      signature: "string",
      name: "string",
      path: "string",
      start_line: "integer",
      start_column: "integer",
      _module: "string",
    },
  },
  { label: "Package", mergeLabel: "Package", key: "name", properties: { name: "string" } },
  {
    label: "Decorator",
    mergeLabel: "Decorator",
    key: "qualified_name",
    properties: { qualified_name: "string", name: "string" },
  },
  {
    label: "CallSite",
    mergeLabel: "CallSite",
    key: "id",
    properties: {
      id: "string",
      method_name: "string",
      receiver_expr: "string",
      receiver_type: "string",
      argument_types: "string[]",
      type_arguments: "string[]",
      return_type: "string",
      callee_signature: "string",
      is_constructor_call: "boolean",
      is_optional_chain: "boolean",
      start_line: "integer",
      start_column: "integer",
      end_line: "integer",
      end_column: "integer",
      _module: "string",
    },
  },
  {
    label: "Attribute",
    mergeLabel: "Attribute",
    key: "id",
    properties: {
      id: "string",
      name: "string",
      type: "string",
      initializer: "string",
      accessibility: "string",
      docstring: "string",
      is_static: "boolean",
      is_readonly: "boolean",
      is_optional: "boolean",
      is_abstract: "boolean",
      ...SPAN,
      _module: "string",
    },
  },
  {
    label: "Variable",
    mergeLabel: "Variable",
    key: "id",
    properties: {
      id: "string",
      name: "string",
      type: "string",
      initializer: "string",
      scope: "string",
      declaration_kind: "string",
      is_readonly: "boolean",
      is_exported: "boolean",
      ...SPAN,
      _module: "string",
    },
  },
];

const DECL_TARGETS = ["Class", "Interface", "Enum", "TypeAlias", "Namespace", "Callable"];

export const REL_TYPES: RelType[] = [
  { type: "HAS_MODULE", from: ["Application"], to: ["Module"], properties: {} },
  { type: "DECLARES", from: ["Module", "Namespace", "Class", "Callable"], to: DECL_TARGETS, properties: {} },
  { type: "HAS_METHOD", from: ["Class", "Interface"], to: ["Callable"], properties: {} },
  { type: "HAS_ATTRIBUTE", from: ["Class", "Interface"], to: ["Attribute"], properties: {} },
  { type: "DECLARES_VAR", from: ["Module", "Namespace", "Callable"], to: ["Variable"], properties: {} },
  { type: "HAS_CALLSITE", from: ["Callable"], to: ["CallSite"], properties: {} },
  { type: "RESOLVES_TO", from: ["CallSite"], to: ["Callable", "External"], properties: {} },
  {
    type: "CALLS",
    from: ["Callable"],
    to: ["Callable", "External"],
    properties: { weight: "integer", provenance: "string[]", dispatch: "string", external: "boolean", module: "string" },
  },
  { type: "EXTENDS", from: ["Class", "Interface"], to: ["Class", "Interface"], properties: {} },
  { type: "IMPLEMENTS", from: ["Class"], to: ["Interface"], properties: {} },
  {
    type: "IMPORTS",
    from: ["Module"],
    to: ["Module", "Package"],
    properties: { imported_names: "string[]", import_kinds: "string[]", is_type_only: "boolean" },
  },
  { type: "RE_EXPORTS", from: ["Module"], to: ["Module", "Package"], properties: {} },
  { type: "MEMBER_OF", from: ["External"], to: ["Package"], properties: {} },
  {
    type: "DECORATED_BY",
    from: ["Class", "Callable", "Attribute"],
    to: ["Decorator"],
    properties: { positional_arguments: "string[]", keyword_arguments_json: "string", start_line: "integer", end_line: "integer" },
  },
];

// ----------------------------------------------------------------------------------------------
// Cypher DDL — shared by both writers, run BEFORE any load so MERGE uses an index seek (not a label
// scan) and the identity invariant is enforced by the database. Every statement is idempotent
// (`IF NOT EXISTS`, which Neo4j matches on schema+type, so renames never duplicate a constraint).
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
  "CREATE INDEX decorator_name IF NOT EXISTS FOR (d:Decorator) ON (d.name)",
  "CREATE FULLTEXT INDEX code_fts IF NOT EXISTS FOR (c:Callable) ON EACH [c.code, c.docstring]",
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
