/**
 * The canonical CLDK analysis schema for TypeScript — the NATIVE model. The stages build this
 * shape directly (schema v2, canonical-schema.md): one additive containment tree of nodes
 * (`id` / `kind` / `span` / named child maps) that `analysis.json` and the Neo4j projection both
 * emit. There is no second model and no emit-time reshape: what the builders construct is what
 * the wire carries, minus the INTERNAL fields listed below (stripped at serialization).
 *
 * Mirrors python's `codeanalyzer/schema/py_schema.py` field-for-field on the invariant spine —
 * `symbol_table{module → types{}/functions{}/fields{}}`, `type → callables{}/fields{}`,
 * `callable → body{}` — and extends it at the leaves with TypeScript-native node kinds
 * (interface / type_alias / enum / namespace) and typed fields (generics, modifiers, ...).
 *
 * Conventions:
 *  - A fact is PRESENT or ABSENT; never `null`. Optional fields are omitted, not nulled. The one
 *    sanctioned null is a `call` body node's `callee` at L1 (refined null→id at L2).
 *  - `id` fields are stamped per-run by `assignIds` (ids embed `--app-name`; the cached tree must
 *    stay app-name-free). Builders initialize them to "".
 *  - INTERNAL fields (never on the wire; serialize.ts strips them by key): `call_sites`,
 *    `config_accesses`, `abs_path`, `content_hash`, `last_modified`, `file_size`. They exist for
 *    the call-graph resolver, the dataflow join, and the analysis cache.
 *
 * All field names are snake_case so `JSON.stringify` emits keys the SDK Pydantic models parse.
 */

import { modulePrefixOf } from "./ids";

// ----------------------------------------------------------------------------------------------
// Span — the one universal attribute. `bytes` are char offsets into the owning module's `source`
// blob, so `source.slice(bytes[0], bytes[1])` reproduces the node's text. `start`/`end` are
// [line, column], 1-based.
// ----------------------------------------------------------------------------------------------

export interface TSSpan {
  start: [number, number]; // [line, column], 1-based
  end: [number, number]; // [line, column], 1-based
  bytes: [number, number]; // [startOffset, endOffset], char offsets into module.source
}

// ----------------------------------------------------------------------------------------------
// Leaf models (wire shapes — flat line/col ints are part of the wire here)
// ----------------------------------------------------------------------------------------------

export interface TSImport {
  module: string; // the module specifier, e.g. "./user" or "@nestjs/common"
  name: string; // the imported binding (or "" for side-effect imports / "*" for namespace)
  alias?: string;
  is_type_only: boolean; // `import type { X } ...`
  import_kind: "named" | "default" | "namespace" | "side_effect";
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
}

export interface TSExport {
  module?: string; // re-export source, e.g. "./user"; absent for `export { x }`
  name: string; // exported name ("*" for `export * from`)
  alias?: string;
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

export interface TSDecorator {
  name: string; // locally written name, e.g. "Get"
  qualified_name?: string; // checker-resolved FQN when available
  positional_arguments: string[]; // raw source fragments
  keyword_arguments: Record<string, string>; // object-literal args flattened to key→source
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
}

export interface TSTypeParameter {
  name: string;
  constraint?: string; // the `extends ...` clause text
  default?: string; // the `= ...` clause text
}

export interface TSCallableParameter {
  name: string;
  type?: string;
  default_value?: string;
  is_optional: boolean;
  is_rest: boolean;
  is_readonly: boolean; // parameter property `constructor(readonly x: T)`
  accessibility?: string; // parameter property visibility (NestJS DI / TS shorthand)
  decorators: TSDecorator[]; // param decorators (e.g. @Param('id'))
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
}

export interface TSOverloadSignature {
  parameters: TSCallableParameter[];
  return_type?: string;
  type_parameters: TSTypeParameter[];
  start_line: number;
  end_line: number;
}

/**
 * INTERNAL — a recorded call site. Never on the wire (the wire's view is the `call` node in the
 * owning callable's `body{}`, built per-run by the l1Body pass). Kept on the callable because the
 * call-graph resolver joins on it (span-matched to the AST) and the cache round-trips it.
 * `callee_signature` is backfilled in place by the tsc resolver.
 */
export interface TSCallsite {
  method_name: string;
  receiver_expr?: string;
  receiver_type?: string;
  argument_types: string[];
  arguments: string[]; // raw source text per argument — INTERNAL, feeds the config-use key match
  type_arguments: string[]; // explicit call type args, foo<T>()
  return_type?: string;
  callee_signature?: string; // absent when recorded; backfilled by the resolver call graph
  is_constructor_call: boolean; // `new X()`
  is_optional_chain: boolean; // `a?.b()`
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  bytes: [number, number]; // char offsets [start, end] into module.source
}

/** INTERNAL — a recognized configuration read (env root access). Never on the wire; the wire's
 * view is the `config_access` node in the owning callable's `body{}` (built by the l1Body pass). */
export interface TSConfigAccess {
  root: string; // "process.env" | "import.meta.env" | "Bun.env"
  key?: string; // present when statically known
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  bytes: [number, number];
}

// ----------------------------------------------------------------------------------------------
// Body nodes — a callable's `body{}` map, keyed by local id (`line:col`, or `@tag` synthetic).
// L1: `call` and `config_access` nodes; L3 adds statements + @entry/@exit; L4 adds formal/actual
// param vertices.
// ----------------------------------------------------------------------------------------------

export interface TSBodyNode {
  kind: string; // "call" | "config_access" | "statement" | "entry" | "exit" | "formal_in" | "actual_in" | …
  span?: TSSpan;
  callee?: string | null; // `call` nodes: null at L1, refined to an id at L2 (the one sanctioned null)
  of?: string; // synthetic param vertices: the flowed name ("arg0", "$ret", a global path)
  parent?: string; // actual_in/actual_out: the anchoring call-site statement's local id
  // call-node attributes (copied from the recorded call site by the l1Body pass)
  method_name?: string;
  receiver_expr?: string;
  receiver_type?: string;
  argument_types?: string[];
  type_arguments?: string[];
  return_type?: string;
  is_constructor_call?: boolean;
  is_optional_chain?: boolean;
  // config_access attributes (copied from the recorded access by the l1Body pass)
  root?: string;
  key?: string;
}

// ----------------------------------------------------------------------------------------------
// Intra-callable edge lists (L3/L4), bare local-id endpoints
// ----------------------------------------------------------------------------------------------

export interface TSCfgEdge {
  src: string;
  dst: string;
  kind: string;
}
export interface TSCdgEdge {
  src: string;
  dst: string;
}
export interface TSDdgEdge {
  src: string;
  dst: string;
  var?: string;
  prov: string[]; // "reaching-defs" (L3 syntactic; sanctioned additive token) / "points-to" (L4)
}
export interface TSSummaryEdge {
  src: string;
  dst: string;
  var?: string;
}

// ----------------------------------------------------------------------------------------------
// Field — module-level binding, class attribute / interface property, or enum member.
// One open-ish shape: each origin sets its own subset (matching what the origin declares).
// ----------------------------------------------------------------------------------------------

export interface TSField {
  id: string; // `${parentId}/${name}` — stamped per-run by assignIds
  kind: "field";
  span?: TSSpan; // absent for constructor parameter properties
  name: string;
  type?: string;
  // module/namespace variable
  initializer?: string;
  scope?: "module" | "namespace";
  declaration_kind?: "const" | "let" | "var" | "using" | "unknown";
  is_exported?: boolean;
  // class attribute / interface property
  comments?: TSComment[];
  decorators?: TSDecorator[];
  accessibility?: string;
  is_static?: boolean;
  is_readonly?: boolean;
  is_optional?: boolean;
  is_abstract?: boolean;
  // enum member
  value?: string; // initializer text or computed const value
}

// ----------------------------------------------------------------------------------------------
// Callable (function / method / constructor / accessor / arrow / function expression)
// ----------------------------------------------------------------------------------------------

export type TSCallableKind =
  | "function"
  | "method"
  | "constructor"
  | "getter"
  | "setter"
  | "arrow"
  | "function_expression";

export interface TSCallable {
  id: string; // can:// containment id — stamped per-run by assignIds
  kind: TSCallableKind;
  span: TSSpan;
  name: string;
  signature: string; // e.g. src/user.UserService.getUser — the internal join key
  comments: TSComment[];
  decorators: TSDecorator[];
  parameters: TSCallableParameter[];
  type_parameters: TSTypeParameter[];
  return_type?: string;
  cyclomatic_complexity: number;
  accessibility?: string; // public | private | protected
  is_static: boolean;
  is_abstract: boolean;
  is_async: boolean;
  is_generator: boolean;
  is_optional: boolean; // optional method `foo?()`
  is_readonly: boolean;
  is_exported: boolean;
  is_ambient: boolean; // `declare`
  is_implicit: boolean; // synthesized default constructor
  accessor_kind?: string; // getter | setter
  overload_signatures: TSOverloadSignature[];
  body: Record<string, TSBodyNode>; // L1: `call` nodes (l1Body pass); L3+: full statements
  callables?: Record<string, TSCallable>; // nested callables (closures) — present only when non-empty
  types?: Record<string, TSType>; // nested (local) classes — present only when non-empty
  cfg?: TSCfgEdge[]; // L3
  cdg?: TSCdgEdge[]; // L3
  ddg?: TSDdgEdge[]; // L3→L4
  summary?: TSSummaryEdge[]; // L4
  // INTERNAL (stripped from the wire)
  abs_path: string; // ABSOLUTE file path of the declaration — the resolver's AST-index key
  call_sites: TSCallsite[];
  config_accesses: TSConfigAccess[]; // INTERNAL (stripped from the wire)
}

// ----------------------------------------------------------------------------------------------
// Type — one node with a single `kind`; the buckets it populates depend on that kind:
//   class / interface → callables{} + fields{};  enum → fields{};  type_alias → (leaf);
//   namespace → types{} + functions{} + fields{} (a sub-file scope, same buckets as a module).
// ----------------------------------------------------------------------------------------------

export type TSTypeKind = "class" | "interface" | "enum" | "type_alias" | "namespace";

export interface TSType {
  id: string; // stamped per-run by assignIds
  kind: TSTypeKind;
  span: TSSpan;
  name: string;
  signature: string;
  comments: TSComment[];
  is_exported: boolean;
  is_ambient: boolean;
  // class / interface / enum / namespace members
  callables?: Record<string, TSCallable>;
  fields?: Record<string, TSField>;
  types?: Record<string, TSType>; // namespace only
  functions?: Record<string, TSCallable>; // namespace only
  // class
  decorators?: TSDecorator[];
  base_classes?: string[]; // spine: union of extends + implements (signature strings)
  implements_types?: string[]; // typed split: just the implemented interfaces
  is_abstract?: boolean;
  // class / interface / type_alias generics
  type_parameters?: TSTypeParameter[];
  // interface
  call_signatures?: string[]; // raw text of call/construct signatures
  index_signatures?: string[]; // raw text of `[key: string]: T`
  // enum
  is_const?: boolean;
  // type_alias
  aliased_type?: string; // the RHS type text
  // Heritage projection (resolved-only), stamped per-run by the heritage pass:
  extends_ids?: string[]; // resolved can:// id(s) of the extended class/interface(s)
  implements_ids?: string[]; // resolved can:// id(s) of implemented interfaces (classes only)
}

// ----------------------------------------------------------------------------------------------
// Module (compilation unit / file) — a scope holding types, functions, and free bindings
// ----------------------------------------------------------------------------------------------

export interface TSModule {
  id: string; // can://<lang>/<app>/<fileKey> — stamped per-run by assignIds
  kind: "module";
  span: TSSpan; // whole file
  source: string; // full file text, once; every node's text slices off this
  imports: TSImport[];
  exports: TSExport[];
  comments: TSComment[];
  types: Record<string, TSType>; // classes/interfaces/enums/type-aliases/namespaces
  functions: Record<string, TSCallable>; // free functions
  fields: Record<string, TSField>; // module-level const/let/var
  is_tsx: boolean;
  is_declaration_file: boolean;
  // INTERNAL — caching metadata (stripped from the wire)
  content_hash?: string;
  last_modified?: number;
  file_size?: number;
}

// ----------------------------------------------------------------------------------------------
// Repository-artifact layer (#101; parity with codeanalyzer-python PR #160 / spec
// 2026-08-27-artifacts-and-dependencies-design.md): recognized non-code files as nodes with
// LANGUAGE-NEUTRAL ids, plus evidence-tagged dependency records and the unresolved-import
// hygiene signal. Application-anchored, level-free — identical at every -a level. Capture is
// broad (every rules-matched file becomes a node, verbatim source, unbounded by decision);
// extraction is narrow (only dependency-manifest roles feed `dependencies` this unit).
// ----------------------------------------------------------------------------------------------

/** A configuration key flattened out of a config-bearing artifact (#101 unit B). */
export interface TSConfigKey {
  id: string; // `${artifactId}@key/${dotted}` — stamped per-run by assignIds
  key: string; // dotted path; numeric segments for arrays ("services.web.ports.0")
  namespace: string; // env|json|yaml|toml|ini|properties|dockerfile
  value?: string | number | boolean; // present by default; absent under --no-artifact-text
  span?: TSSpan; // best-effort: exact for yaml (the parser retains node positions);
  // line-based for env/ini/dockerfile; ABSENT for json/jsonc — JSON.parse discards
  // source positions, and re-deriving one by searching the text for the key token would
  // point at the wrong occurrence whenever a key name repeats under different parents
  // (routine in tsconfig/compose). Absent is honest; a wrong span is a lie a consumer would act on.
  references: string[]; // recognized ${VAR}/$VAR tokens, deduped, in order
}

/** A recognized non-code file (config, manifest, CI, container spec). */
export interface TSArtifact {
  id: string; // can://artifact/<app>/<path> — language-NEUTRAL namespace, stamped per-run
  kind: "artifact";
  path: string; // repo-relative POSIX path (also the map key)
  format: string; // json | jsonc | yaml | toml | ini | requirements? | dockerfile | yarnlock | text | env | binary
  roles: string[]; // dependency-manifest | tool-config | container-image | service-topology | ci | env | packaging | legal | docs | script | unknown
  size_bytes: number;
  sha256: string;
  source: string; // verbatim, unbounded by decision (spec §3)
  extraction: "none" | "partial" | "full";
  config_keys: TSConfigKey[]; // contained children; containment mirrors DEFINES_CONFIG
}

/** One third-party dependency (declared or lockfile-only transitive), evidence-tagged via `prov`. */
export interface TSDependency {
  name: string; // npm-native, @scope kept
  spec: string; // as declared ("^4.17.21"); "" when the section value is not a string
  kind: "runtime" | "dev" | "optional" | "peer" | "build"; // `peer` is the spec'd additive npm token
  extras: string[]; // npm has none — always [] (shared shape parity)
  declared_in: string; // TSArtifact id (a manifest for direct:true, the lock for direct:false)
  direct: boolean; // false = lockfile-only transitive (no manifest declares it)
  locked_version?: string;
  provides_imports: string[]; // import specifiers this distribution provides (npm: the name; @types/x: x)
  prov: string[]; // declared | lockfile | installed-metadata | heuristic
}

/** A non-relative import no declared dependency accounts for (the dependency-hygiene signal). */
export interface TSImportBinding {
  module: string; // the specifier root ("express", "@scope/pkg")
  bound_to?: string; // best-effort distribution name when partially bound
  prov: string[];
}

// ----------------------------------------------------------------------------------------------
// config_use literal tier (#101 unit C2/C3): joins a recognized config READ (a `config_access` or
// detector-table CALL body node) to the declared `TSConfigKey`(s) it names. Runs with the L2 stage
// (src/semantic_analysis/configUse.ts) because CALL rules need the resolved call graph. `src`/
// `site` are GLOBAL ordinal ids (`<callable-id>@<local>`); `dst` is a TSConfigKey id.
// ----------------------------------------------------------------------------------------------

/** One resolved config read: a recognized read whose key closed on exactly one literal that
 * matches a declared ConfigKey. `src` is the read's GLOBAL ordinal id; `dst` the key's id. */
export interface TSConfigUse {
  src: string;
  dst: string;
  prov: Array<"literal" | "dataflow">;
}

/** A recognized read that resolved to no declared key — first class, so an untraceable read is
 * as visible as a traced one. `config_reads` SHRINKS as levels rise (higher tiers resolve some);
 * that is deliberate and is the layer's one non-monotonic section. */
export interface TSConfigRead {
  site: string; // GLOBAL ordinal id
  callee: string; // the read root ("process.env") or the resolved callee id for call rules
  key?: string; // set only for reason "undefined-key"
  reason: "non-literal" | "undefined-key";
  prov: Array<"literal" | "dataflow">;
}

// ----------------------------------------------------------------------------------------------
// Call-graph edge (identity-only, provider output; endpoints are signature strings until the
// call-graph-ids pass rewrites them onto can:// ids at L2)
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

// A first-party anonymous callback a call-graph builder resolved as an edge endpoint but could
// not name against the symbol table (a residual-fallback safety net; since 2.1.0 the tree names
// anonymous callables positionally, so this map is normally empty). The map key IS the
// synthesized signature, so an edge `source`/`target` byte-matches it like a real signature.
export interface TSSynthesizedCallable {
  name: string; // display name — always "<anonymous>"; the signature carries the precise identity
  path: string; // owning module key (project-relative POSIX path WITH extension)
  start_line: number;
  start_column: number;
}

/**
 * The analyzer's INTERNAL working set: the live tree plus the signature-keyed provider outputs.
 * `finalizeAnalysis` consumes it and assembles the wire (`TSAnalysis`); it is never serialized
 * itself. (The program-graph IR travels separately — see AnalysisResult.)
 */
export interface AnalysisInternal {
  symbol_table: Record<string, TSModule>;
  call_graph: TSCallEdge[];
  external_symbols: Record<string, TSExternalSymbol>;
  synthesized_callables: Record<string, TSSynthesizedCallable>;
  /** Repository-artifact layer (level-free). */
  artifacts?: Record<string, TSArtifact>;
  dependencies?: TSDependency[];
  unresolved_imports?: TSImportBinding[];
  /** config_use literal tier (#101 unit C2/C3) — stamped by finalizeAnalysis, not by core.ts. */
  config_uses?: TSConfigUse[];
  config_reads?: TSConfigRead[];
}

// ----------------------------------------------------------------------------------------------
// The wire: envelope → application root → cross-callable edges (what analysis.json IS, and what
// the Neo4j projection consumes)
// ----------------------------------------------------------------------------------------------

export interface TSAnalysis {
  schema_version: string; // "2.1.0"
  language: string; // "typescript"
  max_level: number; // highest level populated; consumers read this, not key-sniffing
  k_limit?: number; // access-path depth bound for the L3/L4 dataflow (present at L3+)
  analyzer: TSAnalyzer; // which analyzer produced this artifact, and at what version
  application: TSApplication;
}

/** Analyzer identity — lets consumers correlate an `analysis.json` with the tool/version that emitted it. */
export interface TSAnalyzer {
  name: string; // "codeanalyzer-typescript"
  version: string; // ANALYZER_VERSION (src/utils/version.ts)
}

/** The application ROOT node (python's PyApplication): the containment tree + app-scope overlays. */
export interface TSApplication {
  id: string; // can://<lang>/<app>
  kind: "application";
  symbol_table: Record<string, TSModule>; // keyed by project-relative POSIX path (with extension)
  call_graph: TSCallGraphEdge[]; // L2 — callable → callable (empty at L1)
  param_in: TSParamEdge[]; // L4 (empty until L4)
  param_out: TSParamEdge[]; // L4
  /** Repository-artifact layer — identical at every level (#101, python PR #160 parity). */
  artifacts: Record<string, TSArtifact>;
  dependencies: TSDependency[];
  unresolved_imports: TSImportBinding[];
  /** config_use literal tier (#101 unit C2/C3) — empty until L2; CALL rules need the call graph. */
  config_uses: TSConfigUse[];
  config_reads: TSConfigRead[];
  // TS-additive (parity): edge endpoints outside the containment tree need an id home.
  external_symbols?: Record<string, import("./homing").TSExternalNode>; // L2 — library call targets, keyed by id
  // L2 — 2.1.0 compatibility index: pre-2.1.0 anonymous-callable id → the tree id that replaced
  // it. Entries whose key equals their own `id` are the residual fallback nodes for signatures no
  // provider could name.
  synthesized_callables?: Record<string, import("./homing").TSSynthesizedNode>;
}

/** A wire call-graph edge: identity-only, can:// endpoints (l2Callees re-identifies onto these). */
export interface TSCallGraphEdge {
  src: string;
  dst: string;
  prov: string[]; // provenance, e.g. ["tsc"], ["defuse"], ["import"]
  weight: number;
}

export interface TSParamEdge {
  src: string;
  dst: string;
  var?: string;
}

// ----------------------------------------------------------------------------------------------
// Tree walkers — the one place the containment reach is defined (shared by the id/body/callee
// passes, the call-graph resolver, and the dataflow join).
// ----------------------------------------------------------------------------------------------

/** Depth-first over every callable in a module: free functions, type members (class/interface
 * accessors and methods, namespace functions), and everything nested inside callables. */
export function forEachCallable(mod: TSModule, fn: (c: TSCallable) => void): void {
  const visitCallable = (c: TSCallable): void => {
    fn(c);
    for (const nested of Object.values(c.callables ?? {})) visitCallable(nested);
    for (const t of Object.values(c.types ?? {})) visitType(t);
  };
  const visitType = (t: TSType): void => {
    for (const m of Object.values(t.callables ?? {})) visitCallable(m);
    for (const f of Object.values(t.functions ?? {})) visitCallable(f); // namespace
    for (const nt of Object.values(t.types ?? {})) visitType(nt); // namespace
  };
  for (const f of Object.values(mod.functions ?? {})) visitCallable(f);
  for (const t of Object.values(mod.types ?? {})) visitType(t);
}

/** Depth-first over every type node in a module, including types nested inside callables. */
export function forEachType(mod: TSModule, fn: (t: TSType) => void): void {
  const visitType = (t: TSType): void => {
    fn(t);
    for (const nt of Object.values(t.types ?? {})) visitType(nt);
    for (const m of Object.values(t.callables ?? {})) visitCallable(m);
    for (const f of Object.values(t.functions ?? {})) visitCallable(f);
  };
  const visitCallable = (c: TSCallable): void => {
    for (const nested of Object.values(c.callables ?? {})) visitCallable(nested);
    for (const t of Object.values(c.types ?? {})) visitType(t);
  };
  for (const t of Object.values(mod.types ?? {})) visitType(t);
  for (const f of Object.values(mod.functions ?? {})) visitCallable(f);
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
  return { fileKey: rel, modulePrefix: modulePrefixOf(rel) };
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

// --- small path helpers (kept dependency-light so schema.ts has no runtime deps beyond ids) ---

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
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
