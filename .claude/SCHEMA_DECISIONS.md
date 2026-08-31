# Schema decisions (codeanalyzer-typescript)

Auditable record of the node-by-node schema design. Anchored on the two mature reference
analyzers — Java (`python-sdk/cldk/models/java/models.py`, rich-edge legacy) and Python
(`codeanalyzer-python/codeanalyzer/schema/py_schema.py`, identity-only, the model we mirror).
Every divergence below was decided **with the user**.

## Invariant spine (never drifts)
- Root: `TSApplication { symbol_table: Dict[path, TSModule], call_graph: List[TSCallEdge],
  entrypoints: Dict[str, List[TSEntrypoint]] }`.
- `symbol_table` keyed by **project-relative POSIX path with extension** (e.g. `src/user.ts`).
- `Module → Class/Callable` nesting; identity-only edges (`source`/`target` are bare signature
  strings that byte-match a real `Callable.signature`).
- **One `signatureOf()`** produces every id, caller- and callee-side.

## Decisions

| # | Node / concept | Java | Python | **TS decision** | Rationale |
|---|---|---|---|---|---|
| 1 | **Signature scheme** | dotted FQN | `module.Class.method` (file-stem prefix, can collide) | **rel-path (no ext) + dotted members**: `src/services/user.UserService.getUser` | unique project-wide, file is recoverable from the id |
| 2 | **Constructor id** | `<init>` | `Class.__init__` | **`Class.constructor`** | matches the TS keyword; reads naturally |
| 3 | **interface / type-alias / enum** | one Class + `is_interface`/`is_enum` flags | none | **separate sibling collections** `interfaces{}`, `type_aliases{}`, `enums{}` on Module/Namespace, each a typed node with its own signature | first-class & queryable; `base_classes`/edges can reference them |
| 4 | **Decorators** | flat `annotations: List[str]` | structured `PyDecorator` | **structured `TSDecorator`** (name, qualified_name, positional_arguments[], keyword_arguments{}, span) | entrypoint finders read `@Get('/path')` without re-parsing |
| 5 | **Generics** | — | — | **structured `TSTypeParameter[]`** (`{name, constraint?, default?}`) on class/interface/callable/type-alias | faithful `<T extends Base = D>`; queryable |
| 6 | **extends / implements** | `extends_list` + `implements_list` | flat `base_classes` | **flat `base_classes` (spine) + typed `implements_types`** | `get_class_hierarchy` reads `base_classes`; split preserves class-vs-interface |
| 7 | **Member modifiers** | flat `modifiers: List[str]` | — | **typed fields**: `accessibility` (public\|private\|protected\|null), `is_static`, `is_abstract`, `is_async`, `is_generator`, `is_readonly`, `is_optional`, `accessor_kind` (getter\|setter\|null) | consumers branch on visibility/static directly |
| 8 | **Ambient / JSX / namespace / overloads** | — | — | **first-class**: `is_ambient` on declarations; `namespaces{}` collection (recursive, same containers as Module); `overload_signatures: List[TSOverloadSignature]` on the implementation callable; `is_tsx`/`is_declaration_file` on Module | the team wants these queryable, not buried in tags |
| 9 | **Anonymous callables** | lambdas not materialized (`LambdaExpr` absent from the model) | lambdas/comprehensions get no `PyCallable`; internals stay attributed to the enclosing function | **materialized as a `V2Callable`** in the enclosing callable's `callables{}`, with its own `body`/`cfg`/`cdg`/`ddg` and `@formal_in:N` at L4; call sites re-anchor to it and no compensating enclosing-callable edge is emitted | a Python lambda is one expression; a JS arrow is a full body and the dominant unit of behaviour (883 handlers in Juice Shop). Folding loses the application. Honours L10 for the unnamed case. Spec: `docs/design/specs/anonymous-callable-materialization.md` |
| 10 | **Anonymous callable identity** | — | — | **`contributorName` contributes `<anon@L:C>`** to the dotted chain: `routes/login.login.<anon@34:10>` | durable tier as the keystone requires, no collision with the `@line:col` ordinal namespace, and byte-identical from both the resolver and Jelly (both know positions; neither counts ordinals). TS-local pending roadmap candidate 4 ratification |
| 11 | **Legacy anonymous surfaces (2.1.0)** | — | — | **retained, re-meant**: `:TSAnonymousCallable` becomes a second label on the real tree node (reached by containment); `synthesized_callables` becomes a signature→`can://` id index, not a node registry | keeps the bump MINOR under the `neo4j/schema.ts:19` rule (no label/relationship/key removed), keeps existing `MATCH` queries working, and closes #75 — the wipe's containment traversal now reaches these nodes |

## Derived conventions
- **module prefix** = file key minus extension (`src/services/user`); also stored as
  `TSModule.module_name`.
- **scope chain**: namespace/class/function names are dot-joined onto the module prefix as we
  descend, so `namespace Api { class V1 {} }` in `src/api.ts` → `src/api.Api.V1`.
- **implicit constructors**: a class instantiated with `new` but lacking an explicit
  constructor still needs an edge target, so each class without an explicit constructor gets a
  synthesized `Class.constructor` callable (`is_implicit = true`) — mirrors Java's default
  constructor. Keeps the call graph free of dangling edges.
- **call-graph dispatch precision** (Tier-1): decided at the Call Graph Construction step.

## What stays open-vocabulary
`TSCallEdge.provenance` (`["tsc"]`, later `["tsc","joern"]`), `TSCallEdge.tags`,
`TSEntrypoint.tags` — plain strings/maps so a persisted `analysis.json` round-trips even
without the producing pass installed.

---

# Level 3 — program graphs (`program_graphs`, issue #2)

The `-a 3` section: CFG / PDG (CDG+DDG) / SDG, per the cross-language dataflow contract.
Shared vocabulary is untouched; everything TS-specific below is additive.

## Node identity
- Every node keyed by `(signature, node_id)` — the SAME `signatureOf()` as
  `symbol_table`/`call_graph`; `node_id` = source-span order of the owning AST node within the
  callable, ENTRY = 0, EXIT = last. Stable across runs on identical content.
- Node kinds: `entry`, `exit`, `param` (the SDG formal-in; span = the parameter declaration),
  `statement`. Statement-level CFG (no basic-block compression).

## Decisions

| # | Concept | Decision | Rationale |
|---|---|---|---|
| L1 | **CFG edge kinds** | shared set + TS-native `await_resume` (await suspension) and `yield` (generator suspension) as the outgoing-normal edge of the suspending statement | additive per the parity clause |
| L2 | **Short-circuit / ternary / optional chaining** | intra-statement — never split into CFG nodes; reads of both arms attributed to the containing statement | statement-level identity stays stable; sound over-approximation |
| L3 | **Exceptional edges** | over-approximate: any call/`new`/`await`/tagged template (and `throw`) edges to the nearest catch node, else the finally entry, else EXIT; a finally region's exits also edge outward (`exception`) for the re-raise path; bare property reads do NOT throw | region splicing, not finally-duplication |
| L4 | **Infinite loops** | `while (true)` / `for (;;)` still emit the loop-exit `false` edge (dead) | keeps EXIT the unique post-dominance root — the contract's synthetic edge |
| L5 | **Call sites (actuals)** | collapsed onto the containing statement node: it is both actual-in and actual-out; `PARAM_IN` var `argN` sources there, `PARAM_OUT` var `return` targets it, and **SUMMARY edges are self-edges** on it (var = the input that flows to the result) | no synthetic actual nodes → every node keeps a real source span |
| L6 | **Formal-out** | EXIT doubles as the formal-out node: return-value nodes get a synthetic DDG edge `→ EXIT` var `return`; module-global writes get `→ EXIT` var `<global>` | PARAM_OUT sources at EXIT must be reachable from the callee's PDG (slice descent) — the two documented non-syntactic DDG edges |
| L7 | **Globals** | canonical path `<modulePrefix>.<name>` (same prefix as signatures); defined at ENTRY on entry, ride the SDG as extra params (`PARAM_IN` → callee ENTRY, `PARAM_OUT` ← callee EXIT); callee transitive global effects are re-applied at the caller's callsite node (uses/defs), so cross-function global flow is visible in the caller's own DDG | HRB "globals as extra formals" |
| L8 | **Base identity** | a DDG base is its *declaration node* (locals/params/captured), `this`, or the canonical module path — labels are names, identity is the decl | shadowed names in nested scopes can never leak edges |
| L9 | **Aliasing (MVP)** | flow-insensitive union-find over bases joined by bare copies (`const q = p`); field writes are always weak (no kill); strong kills only for whole-base local/param writes | sound-leaning stub per the substrate menu; Jelly points-to upgrade is staged PR F |
| L10 | **Closures** | nested callables get their own graphs; their reads of outer state are *capture uses* attributed to the declaring statement in the enclosing CFG (capture-at-declaration); captured bases are defined at the closure's own ENTRY | capture edges without cross-graph DDG |
| L11 | **Summaries** | node-granular relational summaries: `param_flows` (argN → return), `global_reads`/`global_writes`, `globals_to_return`; composed bottom-up over the Tarjan SCC condensation, co-defined to a monotone fixpoint inside an SCC; k-limited access paths (`--graph-field-depth`, default 3) bound the domain | statement-level precision cap, documented posture |
| L12 | **External / unresolved callees** | conservative pass-through SUMMARY self-edges (every arg may flow to the result); no CALL/PARAM edges (their graphs don't exist — no dangling endpoints); their global effects are unmodeled | the call-graph no-dangling rule extended to graphs |
| L13 | **Emission scoping** | `--graphs cfg,dfg,pdg,sdg` (strict validation); `dfg` = the DDG subset of `pdg` (no separate section); `program_graphs.schema_version` versioned independently ("1.0.0") | contract |

## Known unsoundness (documented, not silently absorbed)
Dynamic `eval` / `Function`, reflection and monkey-patching, dynamic property names beyond
`[*]`, `this` flow across call boundaries (no this-param edges yet), exceptions carrying values
(the catch binding is a def but not data-linked to the throw site), npm-internal global effects.

## Deferred (staged in issue #2)
Taint models-as-data + `taint_flows` (PR E), Jelly-backed alias-aware propagation (PR F),
CPG Neo4j projection + schema bump (PR G), incremental re-analysis over the recorded summary
dependency edges in `graphs_summaries.json` (PR H — the file is written today, read by nothing).

# Native v2 model (#96, docs/design/specs/native-v2-model.md)

The v1 compute model and the emit-time v1→v2 transform are retired: `src/schema/schema.ts` IS
schema v2 (envelope `TSAnalysis` → root `TSApplication` → `TSModule`/`TSType`/`TSCallable`/
`TSField`/`TSBodyNode`), built directly by the builders. Wire unchanged (proved by deep-equal
goldens across `-a 1..4` + cypher during the transition; schema_version stays 2.1.0).

| # | Concept | Decision | Rationale |
|---|---|---|---|
| N1 | **One model family + per-run passes** | builders emit the wire shapes; `assignIds`/`l1Body`/`heritage`/`homing`/`l2Callees`/`dataflow/attach` stamp the derived layers each run | python parity (`assign_ids.py` et al.); ids embed `--app-name` while the cache round-trips the tree, so ids can never be baked at build time |
| N2 | **INTERNAL fields, strip-at-emit** | `call_sites`, `callee_signature`, `abs_path`, `content_hash`/`last_modified`/`file_size` ride the model, stripped by key in `finalizeAnalysis`'s deep wire copy | the resolver span-joins on call sites and the cache needs them; the wire never saw them (python d0084cb precedent) |
| N3 | **Derived layers rebuilt wholesale per run** | `l1Body` rebuilds `body{}` from `call_sites` and deletes `cfg`/`cdg`/`ddg`/`summary`; every pass is overwrite-idempotent | cache safety across `--app-name` changes + repeated finalization at different levels stays correct |
| N4 | **Present-or-absent is the model's own convention** | nullable leaf fields became optional; builders omit instead of null (the sanctioned `callee: null` excepted) | the old recursive emit-time null-pruning defined the wire nowhere; now the types do |
| N5 | **types{} fill order = collision precedence** | classes → interfaces → enums → aliases → namespaces; later kind wins a member-key collision (declaration merging) | bit-for-bit the historical per-kind bucket merge |

# Repository-artifact layer (#101, docs/design/specs/artifacts-and-dependencies.md)

Python-parity port of 51ee29e: `application.artifacts{}` with contained dependency/config-key
children, `@artifact/` id marker, level-free. TS decisions: coined additive scope token `peer`
(npm's contract-with-host; shared vocabulary grows); JSON-lock family extracts, yarn/pnpm
inventory-only; declared-only records (`direct:false` reserved); the wire strip became
STRUCTURAL (structuredClone + targeted deletes) because artifact `content_hash` is wire payload
while the module trio is internal — and because the stringify-roundtrip clone OOM'd at
vscode-L4 scale (measured). SDK `extra="forbid"` ⇒ lockstep: python-sdk gains the families
before its pin moves.

# Linker propagation tiers (#100)

T4a property votes (object-literal callbacks through parameters), T4b chained return summaries
(one level, memoized), T4c ctor-field chain (parameter properties + one bounded parameter hop),
property-initializer attribution (initializers execute in the ctor; initializer arrows are
class-scoped anons — the property-arrow gap closes sig-consistently). vscode ledger: 99.72%,
residual 135 all-classified. Joern parameter tables prove the param-shadow fabrications.

## Recalibration (2026-08-27): PR-160 is the anchor

The first #101 cut mirrored `51ee29e` — an UNMERGED python branch (`feat/configuration-files`).
The ratified contract is python PR #160 / spec PR #158: language-neutral `can://artifact/` ids,
flat roles[] artifacts with unbounded verbatim source (rules-matched capture only), flat
evidence-tagged `dependencies[]` (kinds runtime|dev|optional|build + our coined `peer`),
`unresolved_imports[]`, neutral :Artifact/:Package (purl) with the prefix-gate exception,
LOCKS coarse fan, TS_PROVIDES/TS_UNRESOLVED_IMPORT ghosts, `--resolve-installed`. config_keys
dropped for this cut (python's unit 4 owned config extraction) — **superseded 2026-08-30**, see
below: units B/C/D shipped the family. Lesson recorded: parity anchors must be merged refs, not
local branch archaeology.

## v1.3.0 parity (2026-08-30, #101 units A–D)

Spec: `docs/design/specs/2026-08-30-artifact-layer-v130-parity.md`. Brings the branch to
codeanalyzer-python **v1.3.0**: the ConfigKey family, the level-graded `config_use` edge, and
deployment-env namespaces all shipped, reversing the "config_keys dropped" line above.

| # | Concept | Decision | Rationale |
|---|---|---|---|
| A1 | **`direct: false` transitives** (`src/artifacts/deps.ts::transitiveRecords`) | every lock-pinned package no manifest declares becomes its own `TSDependency` record: `direct: false`, `kind: "runtime"` unconditionally, `declared_in` the lock artifact, `prov: ["lockfile"]`. Projected onto `DECLARES_DEPENDENCY.direct` in Neo4j | dependency *surface* and dependency *supply chain* are different questions — a lock file never records WHY a package is present, so `kind` asserts the safe default instead of inferring one from a whole-graph walk |
| B1 | **`config_access`** joins `call`/`entry`/`exit`/… as new L1 `body{}` vocabulary (`src/schema/l1Body.ts`) | a recognized env-root read (`process.env.X`, `import.meta.env.X`, `Bun.env.X`, incl. destructured bindings) mints one node per read into the SAME body-key space as `call` nodes, carrying `root`/`key?` but never `callee` | keeps `config_uses.src` a uniform ordinal id at every level without inventing a second body-node addressing scheme; a read is not a call, so it must not resolve through `TS_RESOLVES_TO` |
| B2 | **`arg.`/`env.` config-key id disambiguation** (`src/schema/assignIds.ts`) | the `key` FIELD always stays the bare variable name (env-namespace resolution joins on a plain `key ===` match); only the ID gets an internal prefix — `arg.` for a `namespace: "dockerfile"` (ARG) mint, `env.` for a YAML artifact's `namespace: "env"` dual-mint. Dockerfile's own `ENV` mint and every ordinary structural key stay unprefixed | a bare name can mint twice on one artifact (Dockerfile `ARG VERSION` beside its own `ENV VERSION=$VERSION`; a YAML top-level `PAYMENT_HOST:` leaf beside the `env` dual-mint under `services.web.environment.*`) and Task 10 MERGEs `:ConfigKey` on id — an undisambiguated collision would silently drop one key. python v1.3.0's scheme, adopted verbatim |
| C1 | **`config_reads` shrinks as `-a` rises — deliberately** | the layer's one non-monotonic section, unlike `config_uses` (asserted superset-monotonic, L2 ⊆ L3 ⊆ L4 — measured 21/25/29 uses, 10/9/8 reads on the `artifacts-app` fixture). A read unresolved at the literal tier can close at a higher dataflow tier, so it MOVES from `config_reads` to `config_uses` as the level climbs | mirrors python's documented same-shape caveat; a consumer diffing two levels must read a vanished `config_reads` record as "resolved at the higher tier," never "fixed in the code" — recorded here and in the consumer skill (`docs/skills/analyzing-cants-graphs/`) |
| D1 | **`SCHEMA_VERSION` held at 2.1.0** | PR #103's provisional `"2.2.0"` bump (recorded in the 2026-08-27 recalibration above) reverted in Task 10; the whole config layer (`ConfigKey`, `DEFINES_CONFIG`, `TS_USES_CONFIG`, `direct` on `DECLARES_DEPENDENCY`) landed additively under 2.1.0 instead | every analyzer re-baselines together, cross-language, only when the artifact layer settles across the org — the maintainer's call, tracked in the org epic; a solo version bump would commit the schema before that's decided |

`config_reads` and `config_uses` both stay level-graded via the SAME three tiers: literal (L2,
`config_access`/detector-table call joined to a declared key by exact `(namespace, key)` match),
dataflow-intra (L3, reaching-definitions to a unique string literal), dataflow-interproc (L4, the
same chain crossing one call boundary via the SDG param/summary edges). Neither tier ever guesses:
an unresolved read is `reason: "non-literal"` (key never closes on one literal) or
`reason: "undefined-key"` (a literal key matching no declared `ConfigKey`) — first-class in
`config_reads`, never silently dropped.
