/**
 * The canonical CLDK analysis schema for TypeScript.
 *
 * Mirrors the identity-only Python schema (codeanalyzer-python/.../py_schema.py) field for
 * field on the invariant spine — `TSApplication { symbol_table, call_graph, entrypoints }`,
 * `Module → Class/Callable` nesting, identity-only `TSCallEdge` whose `source`/`target` are
 * bare signature strings — and extends it at the leaves with TypeScript-native node kinds
 * (interface / type-alias / enum / namespace) and typed fields (generics, modifiers, ...).
 * See SCHEMA_DECISIONS.md.
 *
 * All field names are snake_case so `JSON.stringify` emits keys the SDK Pydantic models parse.
 * The matching Pydantic models live in python-sdk/cldk/models/typescript/models.py and MUST be
 * co-evolved with this file.
 */

// ----------------------------------------------------------------------------------------------
// Leaf models
// ----------------------------------------------------------------------------------------------

export interface TSImport {
  module: string; // the module specifier, e.g. "./user" or "@nestjs/common"
  name: string; // the imported binding (or "" for side-effect imports / "*" for namespace)
  alias: string | null;
  is_type_only: boolean; // `import type { X } ...`
  import_kind: "named" | "default" | "namespace" | "side_effect";
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
}

export interface TSExport {
  module: string | null; // re-export source, e.g. "./user"; null for `export { x }`
  name: string; // exported name ("*" for `export * from`)
  alias: string | null;
  is_type_only: boolean;
  export_kind: "named" | "default" | "namespace" | "re_export";
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
}

export interface TSComment {
  content: string;
  is_docstring: boolean; // JSDoc block attached to a declaration
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
}

export interface TSSymbol {
  name: string;
  scope: string; // local | parameter | class | module | global
  kind: string; // variable | parameter | property | function | class | interface | enum | type_alias | module
  type: string | null;
  qualified_name: string | null;
  is_builtin: boolean;
  lineno: number;
  col_offset: number;
}

export interface TSVariableDeclaration {
  name: string;
  type: string | null;
  initializer: string | null;
  value: unknown | null;
  scope: "module" | "namespace" | "class" | "function" | "block";
  declaration_kind: "const" | "let" | "var" | "using" | "unknown";
  is_readonly: boolean;
  is_exported: boolean;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
}

export interface TSDecorator {
  name: string; // locally written name, e.g. "Get"
  qualified_name: string | null; // checker-resolved FQN when available
  positional_arguments: string[]; // raw source fragments
  keyword_arguments: Record<string, string>; // object-literal args flattened to key→source
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
}

export interface TSTypeParameter {
  name: string;
  constraint: string | null; // the `extends ...` clause text
  default: string | null; // the `= ...` clause text
}

export interface TSCallableParameter {
  name: string;
  type: string | null;
  default_value: string | null;
  is_optional: boolean;
  is_rest: boolean;
  is_readonly: boolean; // parameter property `constructor(readonly x: T)`
  accessibility: string | null; // parameter property visibility (NestJS DI / TS shorthand)
  decorators: TSDecorator[]; // param decorators (e.g. @Param('id'))
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
}

export interface TSCallsite {
  method_name: string;
  receiver_expr: string | null;
  receiver_type: string | null;
  argument_types: string[];
  type_arguments: string[]; // explicit call type args, foo<T>()
  return_type: string | null;
  callee_signature: string | null; // null when recorded; backfilled by the resolver call graph
  is_constructor_call: boolean; // `new X()`
  is_optional_chain: boolean; // `a?.b()`
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
}

// ----------------------------------------------------------------------------------------------
// Callable (function / method / constructor / accessor / arrow)
// ----------------------------------------------------------------------------------------------

export type TSCallableKind =
  | "function"
  | "method"
  | "constructor"
  | "getter"
  | "setter"
  | "arrow"
  | "function_expression";

export interface TSOverloadSignature {
  parameters: TSCallableParameter[];
  return_type: string | null;
  type_parameters: TSTypeParameter[];
  start_line: number;
  end_line: number;
}

export interface TSCallable {
  name: string;
  path: string; // file path of the declaration
  signature: string; // e.g. src/user.UserService.getUser — the edge id
  comments: TSComment[];
  decorators: TSDecorator[];
  parameters: TSCallableParameter[];
  type_parameters: TSTypeParameter[];
  return_type: string | null;
  code: string | null;
  start_line: number;
  end_line: number;
  code_start_line: number;
  accessed_symbols: TSSymbol[];
  call_sites: TSCallsite[];
  inner_callables: Record<string, TSCallable>;
  inner_classes: Record<string, TSClass>;
  local_variables: TSVariableDeclaration[];
  cyclomatic_complexity: number;
  entrypoints: TSEntrypoint[]; // non-empty ⇒ this callable is an entrypoint (level-2 finders populate)
  // --- TypeScript-native typed fields ---
  kind: TSCallableKind;
  accessibility: string | null; // public | private | protected | null
  is_static: boolean;
  is_abstract: boolean;
  is_async: boolean;
  is_generator: boolean;
  is_optional: boolean; // optional method `foo?()`
  is_readonly: boolean;
  is_exported: boolean;
  is_ambient: boolean; // `declare`
  is_implicit: boolean; // synthesized default constructor
  accessor_kind: string | null; // getter | setter | null
  overload_signatures: TSOverloadSignature[];
}

// ----------------------------------------------------------------------------------------------
// Class attribute
// ----------------------------------------------------------------------------------------------

export interface TSClassAttribute {
  name: string;
  type: string | null;
  comments: TSComment[];
  decorators: TSDecorator[];
  initializer: string | null;
  accessibility: string | null;
  is_static: boolean;
  is_readonly: boolean;
  is_optional: boolean;
  is_abstract: boolean;
  start_line: number;
  end_line: number;
}

// ----------------------------------------------------------------------------------------------
// Class
// ----------------------------------------------------------------------------------------------

export interface TSClass {
  name: string;
  signature: string; // e.g. src/user.UserService
  comments: TSComment[];
  code: string | null;
  decorators: TSDecorator[];
  base_classes: string[]; // spine: union of extends + implements (signature strings)
  implements_types: string[]; // typed split: just the implemented interfaces
  type_parameters: TSTypeParameter[];
  methods: Record<string, TSCallable>;
  attributes: Record<string, TSClassAttribute>;
  inner_classes: Record<string, TSClass>;
  entrypoints: TSEntrypoint[]; // class-level entrypoint (e.g. a framework @Controller); empty otherwise
  is_abstract: boolean;
  is_exported: boolean;
  is_ambient: boolean;
  start_line: number;
  end_line: number;
}

// ----------------------------------------------------------------------------------------------
// Interface (TS node kind)
// ----------------------------------------------------------------------------------------------

export interface TSInterface {
  name: string;
  signature: string;
  comments: TSComment[];
  code: string | null;
  base_classes: string[]; // extended interfaces (signature strings)
  type_parameters: TSTypeParameter[];
  methods: Record<string, TSCallable>; // bodiless
  properties: Record<string, TSClassAttribute>;
  call_signatures: string[]; // raw text of call/construct signatures
  index_signatures: string[]; // raw text of `[key: string]: T`
  is_exported: boolean;
  is_ambient: boolean;
  start_line: number;
  end_line: number;
}

// ----------------------------------------------------------------------------------------------
// Enum (TS node kind)
// ----------------------------------------------------------------------------------------------

export interface TSEnumMember {
  name: string;
  value: string | null; // initializer text or computed const value
  start_line: number;
  end_line: number;
}

export interface TSEnum {
  name: string;
  signature: string;
  comments: TSComment[];
  code: string | null;
  members: TSEnumMember[];
  is_const: boolean;
  is_exported: boolean;
  is_ambient: boolean;
  start_line: number;
  end_line: number;
}

// ----------------------------------------------------------------------------------------------
// Type alias (TS node kind)
// ----------------------------------------------------------------------------------------------

export interface TSTypeAlias {
  name: string;
  signature: string;
  comments: TSComment[];
  code: string | null;
  aliased_type: string; // the RHS type text
  type_parameters: TSTypeParameter[];
  is_exported: boolean;
  is_ambient: boolean;
  start_line: number;
  end_line: number;
}

// ----------------------------------------------------------------------------------------------
// Namespace (TS node kind) — recursive container, same shape as Module's declaration buckets
// ----------------------------------------------------------------------------------------------

export interface TSNamespace {
  name: string;
  signature: string;
  comments: TSComment[];
  classes: Record<string, TSClass>;
  interfaces: Record<string, TSInterface>;
  enums: Record<string, TSEnum>;
  type_aliases: Record<string, TSTypeAlias>;
  functions: Record<string, TSCallable>;
  variables: TSVariableDeclaration[];
  namespaces: Record<string, TSNamespace>;
  is_exported: boolean;
  is_ambient: boolean;
  start_line: number;
  end_line: number;
}

// ----------------------------------------------------------------------------------------------
// Module (compilation unit / file)
// ----------------------------------------------------------------------------------------------

export interface TSModule {
  file_path: string;
  module_name: string; // the file key minus extension (== signature prefix)
  imports: TSImport[];
  exports: TSExport[];
  comments: TSComment[];
  classes: Record<string, TSClass>;
  interfaces: Record<string, TSInterface>;
  enums: Record<string, TSEnum>;
  type_aliases: Record<string, TSTypeAlias>;
  functions: Record<string, TSCallable>;
  namespaces: Record<string, TSNamespace>;
  variables: TSVariableDeclaration[];
  // TS file flags
  is_tsx: boolean;
  is_declaration_file: boolean;
  // caching metadata
  content_hash: string | null;
  last_modified: number | null;
  file_size: number | null;
}

// ----------------------------------------------------------------------------------------------
// Call-graph edge (identity-only)
// ----------------------------------------------------------------------------------------------

export const CALL_DEP = "CALL_DEP" as const;

export interface TSCallEdge {
  source: string; // caller TSCallable.signature
  target: string; // callee TSCallable.signature
  type: typeof CALL_DEP;
  weight: number;
  provenance: string[]; // e.g. ["tsc"]
  tags: Record<string, string>;
}

// ----------------------------------------------------------------------------------------------
// Entrypoint (optional; level-2 / framework finders populate it — empty for level 1).
// Embedded on the owning TSCallable/TSClass, so it carries no signature/source_file of its own.
// ----------------------------------------------------------------------------------------------

export interface TSEntrypoint {
  framework: string;
  detection_source: string; // decorator | base_class | convention | extension | ...
  route_path: string | null;
  http_methods: string[];
  tags: Record<string, string>;
}

// ----------------------------------------------------------------------------------------------
// Application (root)
// ----------------------------------------------------------------------------------------------

// ----------------------------------------------------------------------------------------------
// External (phantom) symbol — a synthetic stub for a call target OUTSIDE the project (an imported
// library / Node builtin). Lets the call graph point at external callees (WALA-style phantom
// nodes) without dropping the edge or dangling: an edge `target` byte-matches either a real
// `Callable.signature` or a `TSExternalSymbol.signature`.
// ----------------------------------------------------------------------------------------------

// Slim: the map key IS the signature (e.g. "commander.parse"), and membership in
// `external_symbols` already means external — so neither is repeated in the value.
export interface TSExternalSymbol {
  name: string; // the called member, e.g. "readFileSync"
  module: string; // the import/require specifier, e.g. "node:fs", "express", "@scope/pkg"
}

// A first-party anonymous callback that Jelly resolves as a call-graph endpoint but the symbol
// table never names (the canonicalizer returns null for anonymous functions). The map key IS the
// synthesized signature `<nearest-named-enclosing-signature>:<line:col>`, so an edge `source`/
// `target` byte-matches it just like a real `Callable.signature` or `TSExternalSymbol.signature`.
export interface TSSynthesizedCallable {
  name: string; // display name — always "<anonymous>"; the signature carries the precise identity
  path: string; // owning module key (project-relative POSIX path WITH extension)
  start_line: number;
  start_column: number;
}

export interface TSApplication {
  symbol_table: Record<string, TSModule>;
  call_graph: TSCallEdge[];
  external_symbols: Record<string, TSExternalSymbol>;
  synthesized_callables: Record<string, TSSynthesizedCallable>;
}

// ==============================================================================================
// signatureOf — THE linchpin. One canonicalizer, used caller- and callee-side, so ids byte-match.
// ==============================================================================================

/**
 * Compute the stable symbol-table key (project-relative POSIX path WITH extension) and the
 * module/signature prefix (the same path WITHOUT its extension) for an absolute file path.
 */
export function fileKeyOf(absPath: string, projectRoot: string): { fileKey: string; modulePrefix: string } {
  const rel = toPosix(relativePath(projectRoot, absPath));
  const modulePrefix = stripTsExtension(rel);
  return { fileKey: rel, modulePrefix };
}

/**
 * Build a signature by dot-joining a scope prefix with one or more member names. The prefix is
 * the module/signature prefix (rel path without extension) or an already-built parent signature.
 * Constructors normalize to `<ClassSignature>.constructor`.
 */
export function signatureOf(prefix: string, ...members: string[]): string {
  return [prefix, ...members].join(".");
}

export function constructorSignatureOf(classSignature: string): string {
  return `${classSignature}.constructor`;
}

// --- small path helpers (kept dependency-free so schema.ts has no runtime imports) ---

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function stripTsExtension(relPosix: string): string {
  return relPosix.replace(/\.d\.ts$/, "").replace(/\.(tsx|ts|jsx|js|mts|cts|mjs|cjs)$/, "");
}

function relativePath(from: string, to: string): string {
  const a = toPosix(from).replace(/\/+$/, "").split("/");
  const b = toPosix(to).split("/");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => "..");
  const down = b.slice(i);
  return [...up, ...down].join("/");
}
