# Neo4j projection: import/export bindings, callable parameters, unresolved config reads

Tracking: codeanalyzer-typescript #182. Ships in 1.4.0, one PR, Neo4j contract unchanged at
2.0.0 (additive). Sibling references: codeanalyzer-python `neo4j/schema.py` (`PY_IMPORTS`,
`parameters_json`, `PY_READS_CONFIG_UNRESOLVED`), python-sdk leg 2.5 spec
(`docs/design/specs/2026-09-06-leg-2.5-typescript.md`), codeanalyzer-java #231.

## Problem

Three python-sdk accessors refuse on a TypeScript graph and answer on the in-process backend, and
every one of them is recoverable from data `analysis.json` already carries. Measured on
`main @ 2064b6b` (cants on itself: 139 modules, 1008 callables):

| gap | `analysis.json` | graph |
|---|---|---|
| import / export bindings | 801 imports, 67 exports | none |
| callable parameters | 1546 parameters on 970 callables | none |
| unresolved config reads | `config_reads` 10 (artifacts-app, `-a 2`) | none — `TS_USES_CONFIG` (resolved reads) IS projected; only the unresolved counterpart is missing |

The third row corrects the issue as filed: TypeScript does not emit `DEFINES_CONFIG` alone.

## Contract-impact triage

- **Schema v2 output moves.** `analysis.json`: `resolved_module` on `TSImport` and `TSExport`.
  Neo4j: relationship types `TS_IMPORTS`, `TS_RE_EXPORTS`, `TS_READS_CONFIG_UNRESOLVED`;
  properties `:TSCallable.parameters_json`, `:TSModule.exports_json`. Ids, levels, the containment
  spine, and every existing label/type are untouched. Additive → `SCHEMA_VERSION` stays `2.0.0`
  (decision D1 of the v1.3.0-parity block: every analyzer re-baselines together).
- **Repos.** codeanalyzer-typescript emits (this PR). python-sdk consumes in leg 2.5b, which
  re-points its TypeScript Neo4j backend from the v1 vocabulary and pins the release carrying this
  work. codeanalyzer-java #231 must spell the unresolved-config edge the same way
  (`JAVA_READS_CONFIG_UNRESOLVED`) — a naming constraint, not a child. Docs: the consumer skill
  `docs/skills/analyzing-cants-graphs/` and the regenerated `schema.neo4j.json`.

## Decisions

| # | Concept | Decision | Rationale |
|---|---|---|---|
| D1 | **Import resolution** | `resolved_module?: string` on `TSImport` and on re-export `TSExport`s: the importer-relative **file key** of the target module, computed at build time in `builders.ts` from ts-morph's `getModuleSpecifierSourceFile()`, keyed the same way the symbol table keys modules. Absent when the specifier is external, a builtin, or unresolvable. Cached with the tree (file keys carry no app name). | Python parity (`PyImport.resolved_module`, canonical keystone `import.path`). The checker already resolved it — `tsconfig` `paths`, `index.ts`, `.js`→`.ts`, `.d.ts` — so the analyzer neither re-implements a resolver nor guesses. Nothing today maps a specifier to a module; `phantoms.ts` only classifies externals. |
| D2 | **`TS_IMPORTS`** | `:TSModule → :TSModule \| :TSExternal`, **one edge per (importer, target)** aggregating every binding: `spellings[]` (the raw specifiers), `imported_names[]`, `aliases[]`, plus the TS-only `type_only_names[]` (names imported `import type` / `{ type X }`). Target: the resolved module's node when `resolved_module` is set; otherwise the existing import ghost `<app-id>/@external/<specifierRoot>` (`binding.ts::specifierRoot`; `node:`-prefixed and bare builtins ghost under their own spelling, e.g. `@external/node:fs`). Relative spellings that failed to resolve are dropped from the graph (they survive in JSON). | Python's exact shape and aggregation rule (a second row for the same pair would overwrite the first under MERGE). Ghosting on the package root joins the edge to `TS_PROVIDES` / `TS_UNRESOLVED_IMPORT`, closing `:Package → :TSExternal ← :TSModule`. `type_only_names[]` lets a consumer drop type-only edges from a runtime dependency graph — TypeScript's one structural difference here. |
| D3 | **Exports** | Two carriers. `exports_json` on `:TSModule`: `JSON.stringify(mod.exports)` verbatim, `null` when empty — lossless, answers `get_exports`. `TS_RE_EXPORTS`: `:TSModule → :TSModule \| :TSExternal`, aggregated per (module, target) like D2 with `spellings[]`, `exported_names[]` (`"*"` for `export * from`), `aliases[]`, `type_only_names[]`; targets resolved as in D2. Local exports need no edge — `is_exported` already sits on every declaration node. | No reference precedent (ES modules only; python and java have none), so the shape is coined here once. The edge is what makes barrel chains (`index.ts` re-exporting a tree) walkable in Cypher; the property is what keeps `export { x as y }` locals and per-binding spans recoverable. The 1.x graph carried `RE_EXPORTS`; the name is prefixed like every other TS claim. |
| D4 | **`parameters_json`** on `:TSCallable` (and the `:TSAnonymousCallable` twin) | `JSON.stringify(c.parameters)` verbatim — name, `id` (`@formal_in:N`), type, default, `is_optional`/`is_rest`/`is_readonly`, accessibility, decorators, span — `null` when the list is empty. | Python's property, python's encoding; the SDK's `reconstruct.callable_` already decodes `parameters_json` for TypeScript, so the accessor answers with no SDK change. Cost measured at 430 KB on cants self = 1.4 % of `graph.cypher` (body nodes dominate); a minimal shape (148 KB) would be a second parameter vocabulary to keep in sync for 0.9 %. Property on the existing node, so declaration merging (#177) is not made worse: the collapsed node keeps the last writer's list exactly as it keeps the last writer's `kind`. |
| D5 | **`TS_READS_CONFIG_UNRESOLVED`** | `:TSApplication → :TSExternal \| :TSCallable`, one edge per `config_reads` record with `key`, `reason`, `prov`, discriminant `_k = key\|reason`. Target: for env-root reads (`callee` = `process.env`, `import.meta.env`, `Bun.env`) the ghost `<app-id>/@external/<root>`; for detector-table call rules the resolved callee id as-is (an `:TSExternal` ghost or an in-project `:TSCallable`). `site` is not carried. | Python's shape verbatim, including its documented ceiling: several sites reading the same (callee, key, reason) collapse into one edge, so counts differ from `analysis.json` while presence/absence agrees — the python-sdk comment on `get_unresolved_config_reads` applies unchanged and the shared reconstruct needs no TS branch. Retires the #101 note "config_reads stay JSON-only"; python overturned that in its #162. |
| D6 | **Version and tracking** | Contract `2.0.0`, analyzer 1.4.0 minor. One work item (#182), one PR, spec in this repo. | Every addition is optional-with-absent; a graph from 1.3.0 differs only by missing rows. The SDK's generation probe keys on `analyzer_version`, which is what it pins. |

## Projection rules (what the backend rung implements)

- `project.ts::projectModule`-side: after the module node, aggregate `mod.imports` by target
  (`resolved_module` → `moduleIdOf(app, key)`; else `specifierRoot(spec) ?? spec` → import ghost),
  emit one `TS_IMPORTS` per bucket; same for re-export `TSExport`s into `TS_RE_EXPORTS`.
  `exports_json` rides `moduleProps`. Sorted arrays, so the snapshot is byte-stable.
- `callableProps` gains `parameters_json`. `prune` keeps the python `null`-when-empty rule.
- After the `config_uses` loop: `config_reads` → `TS_READS_CONFIG_UNRESOLVED` with key
  `${key ?? ""}|${reason}`.
- `schema.ts`: three `RelType`s, two properties, `_k` declared on the config edge. `bun run
  gen:schema` re-baselines `schema.neo4j.json`; the conformance test enforces it.
- Incremental Bolt (#140): every new edge's owner is its source module (`TS_IMPORTS`/`TS_RE_EXPORTS`)
  or the application (`TS_READS_CONFIG_UNRESOLVED`), so the existing per-module purge and the
  "shared or changed-owner" edge filter already cover them. Ghost targets are shared nodes, never
  pruned — unchanged.

## Definition of done

- `analysis.json`: `resolved_module` present on every relative import/re-export of the sample-app
  fixture that names a module in the symbol table; absent on externals. L1 ⊆ L2 ⊆ L3 ⊆ L4 gate
  still green (the field is level-free).
- Snapshot on `test/fixtures/sample-app`: `TS_IMPORTS` to `:TSModule` for `./controllers`,
  `./models`, `./services`, `./util`, to ghosts for `commander`, `neo4j-driver`, `node:crypto`,
  `node:fs`, `node:path`; `parameters_json` on every callable with parameters; `exports_json`
  where `exports[]` is non-empty. On `artifacts-app`: `TS_READS_CONFIG_UNRESOLVED` count = number
  of distinct (callee, key, reason) triples in `config_reads`.
- Conformance test green against the regenerated `schema.neo4j.json`; edge-identity test covers
  the `_k` discriminant on the new config edge; bolt container test exercises an incremental
  re-push where an import target module vanishes.
- `.claude/SCHEMA_DECISIONS.md` carries D1–D6; `docs/skills/analyzing-cants-graphs/` documents
  the three query shapes.
- Propagation: comment on codeanalyzer-java #231 naming `JAVA_READS_CONFIG_UNRESOLVED` and the
  `_k` rule; python-sdk #55 / leg 2.5b pointed at the release.
