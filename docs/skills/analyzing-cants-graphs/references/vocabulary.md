# Neo4j vocabulary (authoritative: `schema.neo4j.json`; regenerate with `bun run gen:schema`)

Source of truth: `src/build/neo4j/schema.ts` (`NODE_LABELS`/`REL_TYPES`), enforced by
`test/neo4j-schema.test.ts` — the emitter can never write an undeclared label, relationship, or
property. If a query below returns nothing, check the property is actually declared before
assuming the graph is empty.

## Node labels

| label | merge key | properties | notes |
| --- | --- | --- | --- |
| `TSApplication` | `id` | id, schema_version, language, max_level, k_limit, analyzer_name, analyzer_version | one per run; the `:Application` anchor |
| `Artifact` | `id` (`can://artifact/<app>/<path>`) | id, kind, path, format, roles[], size_bytes, sha256, extraction | **language-neutral, no TS prefix by design** — sibling analyzers MERGE onto the same node. No `source`/`text_truncated`/`config_keys` here (see "No verbatim text in the graph" below) |
| `Package` | `id` (purl `pkg:npm/<name>`, scoped `pkg:npm/%40scope/<name>`) | id, ecosystem, name | language-neutral |
| `ConfigKey` | `id` (`<artifactId>@key/<dotted>`) | id, key, namespace, value, references[] | language-neutral; `key` is always the bare dotted name even when `id` carries an internal `arg.`/`env.` disambiguation prefix (see SKILL.md's identity section) |
| `TSModule` | `id` | _module, content_hash, id, is_declaration_file, is_tsx, kind, name, start_line, end_line | `name` is the file key (e.g. `"src/config.ts"`, WITH extension) — same value as `_module` |
| `TSClass` | `id` | _module, base_classes[], id, implements_types[], is_abstract, is_ambient, is_exported, kind, name, signature, start_line, end_line | |
| `TSInterface` | `id` | _module, base_classes[], id, is_ambient, is_exported, kind, name, signature, start_line, end_line | |
| `TSEnum` | `id` | _module, id, is_ambient, is_const, is_exported, kind, name, signature, start_line, end_line | |
| `TSTypeAlias` | `id` | _module, aliased_type, id, is_ambient, is_exported, kind, name, signature, start_line, end_line | |
| `TSNamespace` | `id` | _module, id, is_ambient, is_exported, kind, name, signature, start_line, end_line | |
| `TSCallable` | `id` | _module, accessibility, accessor_kind, cyclomatic_complexity, id, is_abstract, is_ambient, is_async, is_exported, is_generator, is_implicit, is_static, kind, name, return_type, signature, start_line, end_line | function / method / constructor / getter / setter / arrow / function_expression — one label for all `TSCallableKind` values |
| `TSField` | `id` | _module, id, kind, name, type, start_line, end_line | module var, class/interface property, or enum member |
| `TSBodyNode` | `id` (GLOBAL ordinal) | _module, callee, id, kind, of, parent, start_line, end_line | see `TSBodyNode.kind` below; no `method_name`/`receiver_expr`/`argument_types`/`root`/`key` in Neo4j — those exist only in `analysis.json` |
| `TSExternal` | `id` | _module, id, kind, module, name | ghosts; **two grains**, same label — see "External ghosts" below |
| `TSAnonymousCallable` | `id` | (same property set as `TSCallable`, plus `path`, `start_column`) | **not a separate node** — a second label co-carried on the real `:TSCallable` tree node of an unnamed arrow/function expression (schema 2.1.0). `MATCH (c:TSAnonymousCallable)` finds exactly the anonymous ones; every other query against `:TSCallable` already includes them |

`TSBodyNode.kind`: `entry`, `exit`, `statement`, `call`, `config_access`, `formal_in`,
`formal_out`, `actual_in`, `actual_out`. `call` nodes carry `callee` (null until `-a 2`);
`config_access` nodes never carry `callee` — they are reads, not calls (see SKILL.md's traps).

`Artifact.format`: `json` \| `jsonc` \| `yaml` \| `toml` \| `ini` \| `dockerfile` \| `yarnlock` \|
`env` \| `text` \| `binary` (`src/artifacts/rules.ts`). `Artifact.roles` (list, unioned across every
matching rule): `dependency-manifest`, `tool-config`, `container-image`, `service-topology`, `ci`,
`env`, `packaging`, `legal`, `docs`, `script`, `unknown`. `Artifact.extraction`: `none` \| `partial`
\| `full`. `ConfigKey.namespace`: `env` \| `json` \| `yaml` \| `toml` \| `ini` \| `properties` \|
`dockerfile`.

### No verbatim text in the graph

Neither `TSModule` nor `TSCallable` nor `Artifact` carries source text, a file path, or column
positions in Neo4j — only `_module`/`path` (the file key) and `start_line`/`end_line`. This is a
deliberate design line (`src/build/neo4j/project.ts`: "`source` text stays off the graph — hash
and size dereference to it"), not an omission. To read exact text: re-open the file at
`start_line`/`end_line`, or read `analysis.json`, where every module's `source` is stored once and
every node's exact text is `source.slice(...span.bytes)`.

### External ghosts (`TSExternal`) — two grains, one label

- **Call-graph targets** (`src/schema/homing.ts::homeExternals`): `<appId>/@external/<module>/<name>`
  — one ghost per (module, member), the endpoint of `TS_CALLS`/`TS_RESOLVES_TO` for a call into a
  library or Node builtin.
- **Dependency/import-hygiene ghosts** (`src/build/neo4j/project.ts::importGhost`):
  `<appId>/@external/<module>` — one ghost per import-specifier ROOT, the endpoint of `TS_PROVIDES`
  and `TS_UNRESOLVED_IMPORT`. No `name` segment: `module` alone.

These are **different ids on the same label** — a call-graph ghost for `express`'s `Router` member
does not share an id with the dependency ghost for the `express` package. Join them by the shared
`module` property when a query needs both (e.g. "which callables reach code from this declared
package" — `references/analyses.md` §6).

## Relationships

| type | from → to | properties | notes |
| --- | --- | --- | --- |
| `TS_HAS_MODULE` | TSApplication → TSModule | — | |
| `TS_DECLARES` | TSModule/TSNamespace/TSCallable → TSClass/TSInterface/TSEnum/TSTypeAlias/TSNamespace/TSCallable | — | containment; also how a nested/anonymous callable is reached |
| `TS_HAS_METHOD` | TSClass/TSInterface → TSCallable | — | |
| `TS_HAS_FIELD` | TSModule/TSClass/TSInterface/TSEnum/TSNamespace → TSField | — | |
| `TS_HAS_BODY_NODE` | TSCallable/TSAnonymousCallable → TSBodyNode | — | |
| `TS_RESOLVES_TO` | TSBodyNode → TSCallable/TSExternal/TSAnonymousCallable | — | per-callsite resolution (L2); only `call` nodes have an outgoing edge — `config_access` never does |
| `TS_CALLS` | TSCallable/TSAnonymousCallable → TSCallable/TSExternal/TSAnonymousCallable | weight, prov[] | condensed call graph; prov ⊆ {tsc, defuse, import} |
| `TS_EXTENDS` | TSClass/TSInterface → TSClass/TSInterface | — | resolved-only (external/library supertypes never reach here) |
| `TS_IMPLEMENTS` | TSClass → TSInterface/TSClass | — | |
| `TS_CFG_NEXT` | TSBodyNode → TSBodyNode | kind, `_k` | control flow; `_k` = `kind` (a conditional's true/false pair needs both edges to coexist) |
| `TS_CDG` | TSBodyNode → TSBodyNode | — | control dependence |
| `TS_DDG` | TSBodyNode → TSBodyNode | var, prov[], `_k` | one edge per (var, prov); prov ⊆ {reaching-defs (L3), points-to (L4)}; `_k` = `"<var>\|<prov joined by comma>"` |
| `TS_PARAM_IN` | caller `actual_in` → callee `formal_in` | var | L4 |
| `TS_PARAM_OUT` | callee `formal_out` → caller `actual_out` | var | L4 |
| `TS_SUMMARY` | `actual_in` → `actual_out` (same call site) | var | L4 transitive shortcut |
| `HAS_ARTIFACT` | TSApplication → Artifact | — | L1, level-free |
| `DECLARES_DEPENDENCY` | Artifact → Package | spec, kind, direct, extras[], prov[] | one edge per (artifact, package, kind); `direct: false` = lockfile-only transitive, never manifest-declared |
| `LOCKS` | Artifact (a lock file) → Package | version | fans from every lock artifact present (coarse fan — python's documented posture) |
| `DEFINES_CONFIG` | Artifact → ConfigKey | — | containment; level-free |
| `TS_PROVIDES` | Package → TSExternal (module-level ghost) | — | correlatable with the call-graph grain via `module` only (see "External ghosts" above), not the same id; `TS_`-prefixed because the claim is this analyzer's own |
| `TS_UNRESOLVED_IMPORT` | TSApplication → TSExternal (module-level ghost) | prov[] | undeclared-import hygiene signal |
| `TS_USES_CONFIG` | TSBodyNode → ConfigKey | prov[] | which read joins which key; prov ⊆ {literal (L2+), dataflow (L3 intra, L4 interproc — same tag both tiers)}; superset-monotonic `-a 2 ⊆ 3 ⊆ 4` |

There is **no relationship for unresolved config reads** — `config_reads` (JSON: `site`, `callee`,
`key?`, `reason`, `prov[]`) is not projected; it records an absence, not a graph fact. There is also
**no import-graph relationship** — a module's `imports[]`/`exports[]` (with specifiers, aliases,
type-only flags) exist only in `analysis.json`'s `TSModule`; `TS_UNRESOLVED_IMPORT`/`TS_PROVIDES`
cover the dependency-hygiene case only, not a general per-module import graph. There is also **no
entrypoint vocabulary** — `TSCallable` carries no `is_entrypoint`/`entrypoint_frameworks`; this
analyzer does not (yet) detect framework entrypoints.

All dataflow relationships are stored src→dst in the forward direction.

Dependency `prov` vocabulary: `declared`, `lockfile`, `installed-metadata` (only with
`--resolve-installed`), `heuristic`. `TSDependency.kind` (`DECLARES_DEPENDENCY.kind`): `runtime` \|
`dev` \| `optional` \| `peer` \| `build` — `peer` is this analyzer's one coined additive token
against the shared cross-language enum (npm's contract-with-host has no analogue in it). A
`direct: false` record is always `kind: "runtime"`: a lock file does not record *why* a package is
present, and inferring one would need a whole-graph walk this layer deliberately does not do.
