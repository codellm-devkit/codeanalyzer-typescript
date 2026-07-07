/**
 * Schema v2 — the canonical CLDK analysis shape (the "additive CPG"): one scale-free node
 * (id / kind / span / children / typed-edge overlays), emitted as `analysis.json`. This file is
 * the TypeScript projection of `codeanalyzer-backend/references/canonical-schema.md`; the SDK's
 * Pydantic models mirror it. It is produced by `emit.ts` as a transform of the v1 in-memory
 * model (`../schema.ts`) — the parsing/resolution guts are untouched; only serialization changes.
 *
 * Levels are additive: L1 grows the tree to callable depth (+ `call` nodes in `body`); L2 adds
 * `call_graph` and backfills `callee`; L3 grows the rest of `body` + `cfg`/`cdg`/`ddg`; L4 adds
 * synthetic param vertices + `param_in`/`param_out`/`summary`. This file already declares the
 * later-level slots (all optional) so the shape is stable as levels land.
 */

import type { TSSpan } from "../schema";

/** The one universal attribute. `bytes` are char offsets into the owning module's `source`. */
export type Span = TSSpan;

// ----------------------------------------------------------------------------------------------
// Root
// ----------------------------------------------------------------------------------------------

export interface V2Application {
  schema_version: string; // "2.0.0"
  language: string; // "typescript"
  max_level: number; // highest level populated; consumers read this, not key-sniffing
  k_limit?: number; // access-path depth bound for the L3/L4 dataflow (present at L3+)
  analyzer: V2Analyzer; // which analyzer produced this artifact, and at what version
  application: V2Root;
}

/** Analyzer identity — lets consumers correlate an `analysis.json` with the tool/version that emitted it. */
export interface V2Analyzer {
  name: string; // "codeanalyzer-typescript"
  version: string; // ANALYZER_VERSION (src/utils/version.ts)
}

export interface V2Root {
  id: string; // can://<lang>/<app>
  kind: "application";
  symbol_table: Record<string, V2Module>; // keyed by project-relative POSIX path (with extension)
  call_graph: V2CallEdge[]; // L2 — callable → callable (empty at L1)
  param_in: V2ParamEdge[]; // L4 (empty until L4)
  param_out: V2ParamEdge[]; // L4
  // TS-additive (parity): edge endpoints outside the containment tree need an id home.
  external_symbols?: Record<string, V2External>; // L2 — imported/library call targets, keyed by id
  synthesized_callables?: Record<string, V2Node>; // L2 — first-party anonymous callbacks, keyed by id
}

/** A call target outside the project (an imported library member / builtin) — an edge endpoint, not a tree node. */
export interface V2External extends V2Node {
  kind: "external";
  module: string; // the import/require specifier, e.g. "node:fs", "express"
  name: string; // the called member, e.g. "readFileSync"
}

// ----------------------------------------------------------------------------------------------
// Cross-callable edges (application scope)
// ----------------------------------------------------------------------------------------------

export interface V2CallEdge {
  src: string; // caller callable id
  dst: string; // callee callable (or external) id
  prov: string[]; // provenance, e.g. ["tsc"], ["jelly"]
  weight: number;
}

export interface V2ParamEdge {
  src: string;
  dst: string;
  var?: string;
}

// ----------------------------------------------------------------------------------------------
// Nodes — one scale-free node; language-native attrs ride additively via the index signature.
// ----------------------------------------------------------------------------------------------

export interface V2Node {
  id: string;
  kind: string;
  span?: Span;
  [attr: string]: unknown; // additive language-native attributes (decorators, is_*, type_parameters, …)
}

/** A file / compilation unit — a *scope* holding types, functions, and free bindings. */
export interface V2Module extends V2Node {
  kind: "module";
  source: string; // whole file text, once; every node's text slices off this
  types: Record<string, V2Type>; // classes/interfaces/enums/type-aliases/namespaces
  functions: Record<string, V2Callable>; // free functions
  fields: Record<string, V2Field>; // module-level const/let/var (Gap B → fields on the scope)
}

/**
 * A type-or-scope node. Classes/interfaces/enums/type-aliases populate `callables`/`fields`;
 * a `namespace` (a sub-file scope, Gap A) instead populates `types`/`functions`/`fields`.
 */
export interface V2Type extends V2Node {
  kind: "class" | "interface" | "enum" | "type_alias" | "namespace";
  signature: string; // v1 human-readable id (kept; the durable id is `id`)
  callables?: Record<string, V2Callable>; // class/interface/enum members
  fields?: Record<string, V2Field>; // class attributes / interface properties / enum members
  types?: Record<string, V2Type>; // namespace: nested types
  functions?: Record<string, V2Callable>; // namespace: nested functions
}

export interface V2Callable extends V2Node {
  kind: "function" | "method" | "constructor" | "getter" | "setter" | "arrow" | "function_expression";
  signature: string;
  body: Record<string, V2BodyNode>; // L1: `call` nodes keyed by line:col; L3+: full statements
  callables?: Record<string, V2Callable>; // nested callables (closures) — syntactic containment
  types?: Record<string, V2Type>; // nested (local) classes
  cfg?: unknown[]; // L3
  cdg?: unknown[]; // L3
  ddg?: unknown[]; // L3→L4
  summary?: unknown[]; // L4
}

export interface V2Field extends V2Node {
  kind: "field";
}

/** A node inside a callable `body` (L1: call sites; L3+: statements; L4: synthetic vertices). */
export interface V2BodyNode {
  kind: string; // "call" | "statement" | "return" | "entry" | "exit" | "formal_in" | …
  span?: Span;
  callee?: string | null; // on `call` nodes: null at L1, backfilled to a callable id at L2
  [attr: string]: unknown;
}
