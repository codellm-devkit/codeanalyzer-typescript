/**
 * The declarative Neo4j schema catalog — the single in-repo source of truth for the graph
 * contract (node labels, their keys and typed properties, relationship types and their endpoints).
 * `--emit schema` serializes this (with the DDL from ./schema) to a machine-readable schema.json,
 * and the conformance test (test/neo4j-schema.test.ts) asserts the real emitter never produces a
 * label / relationship / property that isn't declared here — so this file cannot silently drift
 * from project.ts.
 *
 * SCHEMA_VERSION is the contract version: bump MAJOR on a breaking change (renamed/removed label,
 * relationship or key), MINOR on an additive change (new label/rel/property). It is stamped onto
 * the :TSApplication node of every emitted graph so any consumer can detect a producer/consumer
 * mismatch at runtime.
 */
import { CONSTRAINTS, INDEXES } from "./schema";

export const SCHEMA_VERSION = "2.0.0";

export type PropType = "string" | "integer" | "float" | "boolean" | "string[]" | "integer[]";

export interface NodeLabel {
  /** The specific label (also the catalog key). */
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
export const MARKER_LABELS = ["TSEntrypoint"] as const;

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
    label: "TSApplication",
    mergeLabel: "TSApplication",
    key: "name",
    properties: { name: "string", schema_version: "string" },
  },
  {
    label: "TSModule",
    mergeLabel: "TSModule",
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
    label: "TSClass",
    mergeLabel: "TSSymbol",
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
    label: "TSInterface",
    mergeLabel: "TSSymbol",
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
    label: "TSEnum",
    mergeLabel: "TSSymbol",
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
    label: "TSTypeAlias",
    mergeLabel: "TSSymbol",
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
    label: "TSNamespace",
    mergeLabel: "TSSymbol",
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
    label: "TSCallable",
    mergeLabel: "TSSymbol",
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
    label: "TSExternal",
    mergeLabel: "TSSymbol",
    key: "signature",
    properties: { signature: "string", name: "string", module: "string" },
  },
  { label: "TSPackage", mergeLabel: "TSPackage", key: "name", properties: { name: "string" } },
  {
    label: "TSDecorator",
    mergeLabel: "TSDecorator",
    key: "qualified_name",
    properties: { qualified_name: "string", name: "string" },
  },
  {
    label: "TSCallSite",
    mergeLabel: "TSCallSite",
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
    label: "TSAttribute",
    mergeLabel: "TSAttribute",
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
    label: "TSVariable",
    mergeLabel: "TSVariable",
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

const DECL_TARGETS = ["TSClass", "TSInterface", "TSEnum", "TSTypeAlias", "TSNamespace", "TSCallable"];

export const REL_TYPES: RelType[] = [
  { type: "TS_HAS_MODULE", from: ["TSApplication"], to: ["TSModule"], properties: {} },
  { type: "TS_DECLARES", from: ["TSModule", "TSNamespace", "TSClass", "TSCallable"], to: DECL_TARGETS, properties: {} },
  { type: "TS_HAS_METHOD", from: ["TSClass", "TSInterface"], to: ["TSCallable"], properties: {} },
  { type: "TS_HAS_ATTRIBUTE", from: ["TSClass", "TSInterface"], to: ["TSAttribute"], properties: {} },
  { type: "TS_DECLARES_VAR", from: ["TSModule", "TSNamespace", "TSCallable"], to: ["TSVariable"], properties: {} },
  { type: "TS_HAS_CALLSITE", from: ["TSCallable"], to: ["TSCallSite"], properties: {} },
  { type: "TS_RESOLVES_TO", from: ["TSCallSite"], to: ["TSCallable", "TSExternal"], properties: {} },
  {
    type: "TS_CALLS",
    from: ["TSCallable"],
    to: ["TSCallable", "TSExternal"],
    properties: { weight: "integer", provenance: "string[]", dispatch: "string", external: "boolean", module: "string" },
  },
  { type: "TS_EXTENDS", from: ["TSClass", "TSInterface"], to: ["TSClass", "TSInterface"], properties: {} },
  { type: "TS_IMPLEMENTS", from: ["TSClass"], to: ["TSInterface"], properties: {} },
  {
    type: "TS_IMPORTS",
    from: ["TSModule"],
    to: ["TSModule", "TSPackage"],
    properties: { imported_names: "string[]", import_kinds: "string[]", is_type_only: "boolean" },
  },
  { type: "TS_RE_EXPORTS", from: ["TSModule"], to: ["TSModule", "TSPackage"], properties: {} },
  { type: "TS_MEMBER_OF", from: ["TSExternal"], to: ["TSPackage"], properties: {} },
  {
    type: "TS_DECORATED_BY",
    from: ["TSClass", "TSCallable", "TSAttribute"],
    to: ["TSDecorator"],
    properties: { positional_arguments: "string[]", keyword_arguments_json: "string", start_line: "integer", end_line: "integer" },
  },
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
