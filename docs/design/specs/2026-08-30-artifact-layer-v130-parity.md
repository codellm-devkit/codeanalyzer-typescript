# Repository-artifact layer — parity with codeanalyzer-python v1.3.0

- **Date:** 2026-08-30
- **Status:** approved (brainstorming dialogue in-session); supersedes
  `artifacts-and-dependencies.md`, which anchored on the pre-1.3.0 shape
- **Scope:** `codeanalyzer-typescript`; schema v2 **additive**
- **Parity anchor:** codeanalyzer-python **v1.3.0** (tag, released 2026-08-29) — artifacts +
  dependencies (#157/#160), the ConfigKey family (#152/#163), the level-graded `config_use` edge
  (#162/#164), deployment-env namespaces (#165/#168). Copy-from: that repo's
  `docs/design/specs/2026-08-27-artifacts-and-dependencies-design.md`,
  `2026-08-28-config-key-family-design.md`, `2026-08-28-config-use-edge-design.md`
- **Tracking:** org epic `codellm-devkit/.github#45`; this repo's work item #101 (PR #103),
  branch `feat/issue-101-artifacts`
- **Decomposition:** one spec, four staged units (A→D), each independently green

## Problem

Schema v2 is code-only. The org epic's repository-artifact layer — the producer-side evidence a
cross-service analysis needs — shipped in python at v1.3.0; TypeScript emits a subset of its
pre-release shape (PR #103) and none of the ConfigKey / `config_use` / deployment-env work. This
spec brings TypeScript to the v1.3.0 contract, with the TS-native decisions the epic delegates
to each analyzer.

## Units

| Unit | Content |
| --- | --- |
| **A** | Inventory reconcile: never-drop walk, text-capture policy, `direct: false` transitives |
| **B** | ConfigKey family: per-artifact `config_keys[]`, namespaces, spans, references |
| **C** | `config_use`: `config_access` body nodes, detector table, level-graded tiers, first-class unresolved reads |
| **D** | Deployment-env: Dockerfile `ENV`/`ARG`, compose and k8s `env` |

## Wire model (python v1.3.0 field-for-field; TS-native where the ecosystem differs)

```ts
application.artifacts: Record<repoRelPath, TSArtifact>
application.dependencies: TSDependency[]
application.unresolved_imports: TSImportBinding[]
application.config_uses: TSConfigUse[]      // C
application.config_reads: TSConfigRead[]    // C

TSArtifact   { id: `can://artifact/<app>/<path>`, kind: "artifact", path, format, roles[],
               size_bytes, sha256, source, text_truncated, extraction: none|partial|full,
               config_keys: TSConfigKey[] }
TSConfigKey  { id: `${artifactId}@key/${dotted}`, key, namespace, value?, span?, references[] }
TSDependency { name, ecosystem: "npm", spec, kind: runtime|dev|optional|peer|build, extras[],
               declared_in, direct, locked_version?, provides_imports[], prov[] }
TSConfigUse  { src /* body-node ordinal id */, dst /* ConfigKey id */, prov: ("literal"|"dataflow")[] }
TSConfigRead { site, callee, key?, reason: "non-literal"|"undefined-key", prov[] }
```

Identity: artifact ids are language-neutral (`can://artifact/<app>/<path>`) so sibling analyzers
over one repo emit the same id for the same file; `--app-name` agreement is the join
precondition. Packages are purl-keyed (`pkg:npm/<name>`, scoped `pkg:npm/%40scope/<name>`).
Config keys hang off their artifact — containment mirrors `DEFINES_CONFIG`. The code tree stays
code-only.

`kind: "peer"` remains this analyzer's one coined additive token against the shared
`runtime|dev|optional|build` enum (npm's contract-with-host has no analogue in the ratified set).

## Unit A — inventory reconcile

1. **Never drop.** Every non-source file is inventoried: rules-matched → its `roles`; unmatched
   but decodable → `roles: ["unknown"]`; undecodable → `format: "binary"`, `source: ""`, hash and
   size only. (Today's branch skips unmatched files — the largest divergence from shipped python.)
2. **Text policy.** Capture on by default; `--artifact-text` / `--no-artifact-text`;
   `--artifact-text-max-bytes` (default 256 KiB). `text_truncated` marks a stored prefix.
   `sha256` and `size_bytes` are always the **full file**. Extraction (dependencies, config keys)
   parses the **full on-disk text**, never the stored copy — truncation can never change
   extracted meaning.
3. **Transitives.** Lock-only packages become records with `direct: false`, `prov: ["lockfile"]`.
   Payload growth is measured on a real repository and reported, not assumed.

Unchanged from the current branch: neutral ids, purl packages, `provides_imports` (`@types/x`
also provides `x`), `unresolved_imports` with the type-only rule, `--resolve-installed`,
`TS_PROVIDES` / `TS_UNRESOLVED_IMPORT`.

## Unit B — ConfigKey family

`src/artifacts/configKeys.ts`. L1 data, identical at every level. Keys are dotted paths with
numeric segments for arrays (`services.web.ports.0`).

| Artifact | namespace | notes |
| --- | --- | --- |
| `.env` family | `env` | flat keys, quotes stripped |
| JSON configs | `json` | **JSONC-tolerant** for `tsconfig*` / rc files (comments, trailing commas) |
| YAML (compose, k8s, workflows) | `yaml` | new `yaml` dependency; node positions give real spans |
| TOML | `toml` | |
| INI / `.properties` | `ini` / `properties` | |
| Dockerfile | `dockerfile` | refined by unit D |

- `value` is present **by default** (capture is on); absent under `--no-artifact-text`.
- `span` is best-effort into the artifact source: exact for JSON/YAML, line-based for
  env/ini/dockerfile.
- `references[]` records recognized `${VAR}` / `$VAR` tokens, deduplicated, in order of appearance.
- **Overlay posture:** a parse failure never suppresses the artifact node — the node stays and
  `extraction` becomes `"partial"`.

`extraction` across the layer: `"full"` when the artifact's meaning was extracted (dependency
records and/or config keys), `"partial"` when extraction was attempted and failed or completed
only in part, `"none"` when the artifact's roles call for no extraction (docs, legal, binary,
`unknown`).

## Unit C — the `config_use` edge

### C1. `config_access` body nodes (new L1 vocabulary)

Python's detector table is call-based, and they dropped `os.environ["X"]` after verifying a
subscript never lowers to a call body node. In TypeScript that shape *is* the dominant idiom, so
recognized non-call reads mint a `body{}` node of kind **`config_access`** during the L1 walk
(`builders.ts`), keeping `config_uses.src` a uniform ordinal id at every level:

- `process.env.X`, `process.env["X"]`
- `import.meta.env.X`, `Bun.env.X`
- destructuring — `const { PORT, HOST } = process.env` mints one node per bound element

The node carries `span`, `root` (e.g. `"process.env"`), and `key` when statically known. It has
no `callee` (it is not a call). Additive at L1; recorded in `.claude/SCHEMA_DECISIONS.md`.

### C2. Detector table

`src/semantic_analysis/configUseRules.ts`, shipped in code (the `rules.ts` precedent; no
user-extension flag, matching python's posture). Two rule kinds:

- **access rules** — env roots above → namespaces `[env]`
- **call rules** — `{ module, callable, key_arg, namespaces }`: `Deno.env.get`, node-config
  `get`, `nconf.get`, and the equivalents; matched prefix-aware on module, as python does

### C3. Tiers

Level-graded, never guessing:

- **literal** (`-a 2`+, `prov: ["literal"]`) — the key is statically known; join a declared
  `TSConfigKey` on `(namespace, key)`. Several artifacts may declare one key (`.env` *and*
  Dockerfile `ENV`): one edge per match, emitted in sorted order.
- **dataflow-intra** (`-a 3`+, `prov: ["dataflow"]`) — a non-literal key resolved through
  reaching-definitions (`src/dataflow/defuse.ts`) to a unique string literal in the callable.
- **dataflow-interproc** (`-a 4`, same `prov`) — the chain crosses one call boundary via the SDG
  param/summary edges.

Superset-monotonic: literal ⊆ +intra ⊆ +interproc.

**Unresolved reads are first class.** A key that never closes on exactly one literal →
`config_reads` with `reason: "non-literal"`; a literal matching no declared key →
`reason: "undefined-key"`. `prov` lists every tier attempted. `config_reads` deliberately
**shrinks** as levels rise — the one non-monotonic section, documented here and in the decision
log (python carries the same caveat).

## Unit D — deployment-env namespaces

Three sources mint **bindable `env`-namespace keys in addition to** the structural key their file
already produces in unit B:

- Dockerfile `ENV FOO=bar` → `env:FOO`
- compose `services.<svc>.environment` — map **and** list forms → `env:*`
- k8s `spec.containers[].env[]` (`name` / `value`) → `env:*`

Dockerfile `ARG` stays namespace `dockerfile`: **non-bindable**, build-time only, never joins an
env read. `env_file:` indirection is out of scope for this unit.

## Neo4j projection

- Neutral `ConfigKey` node (id-keyed) and `DEFINES_CONFIG` (Artifact→ConfigKey) — neutral because
  sibling analyzers MERGE onto the same nodes.
- `TS_USES_CONFIG` (TSBodyNode→ConfigKey, property `prov`) — language-prefixed because the claim
  is this analyzer's.
- `config_reads` stay JSON-only: records of absence, not edges.
- The conformance gate's neutral allowlist grows by `ConfigKey` / `DEFINES_CONFIG`.
- **`SCHEMA_VERSION` is untouched** by this work (PR #103's 2.2.0 bump reverts). All analyzers
  re-baseline at 2.0.0 when the layer settles across languages — the maintainer's call, recorded
  in the epic.

## Pipeline placement

`analyze()`, in order:

1. `buildSymbolTable` — builders mint `config_access` nodes during the L1 walk
2. artifact inventory → dependencies → config keys (after the symbol table: import binding needs
   module imports), level-ungated, not cached
3. call graph (L2) → **literal tier** (`src/semantic_analysis/configUse.ts`, needs resolved callees)
4. program graphs (L3/L4) → **dataflow tiers** (`src/dataflow/`, over the def-use substrate)
5. `finalizeAnalysis` — `assignIds` stamps artifact, config-key, and `declared_in` ids per run

This is pipeline-shaped placement rather than python's single `artifacts/` package: each pass
sits with the stage whose output it consumes, matching how this repo already places
`defuseLinker` in `semantic_analysis`.

## Testing and gates

Fixture `artifacts-app` grows: an unmatched file, a binary, a JSONC `tsconfig`, compose + k8s +
Dockerfile (`ENV` **and** `ARG`), `.env`, and a source file exercising every detector shape and
every tier — literal, intra-dataflow, interprocedural, plus one `undefined-key` and one
`non-literal` read.

- artifacts / dependencies / config keys identical at `-a 1|2|3|4`
- `config_uses` superset-monotonic L2 ⊆ L3 ⊆ L4; `config_reads` shrink asserted, not merely allowed
- two consecutive default runs byte-identical
- Neo4j rows for `ConfigKey` / `DEFINES_CONFIG` / `TS_USES_CONFIG`; count-parity gate taught the
  new families; `schema.neo4j.json` regenerated (version unmoved)
- measured payload delta from `direct: false` transitives on a real repository, reported in the PR
- full suite + typecheck green at every unit boundary

## Caveats and risks

- **Transitive payload.** npm lock trees are large; unit A's `direct: false` records are the
  growth point. Measured, reported, and revisited only with numbers.
- **New runtime dependency** (`yaml`) enters the compiled binary. Accepted for correct YAML
  (anchors, flow style, multiline) and real spans; a hand-rolled subset would silently mis-parse.
- **`config_access` moves `body{}`** at L1. Additive, but it is new vocabulary in the wire's most
  load-bearing map; the schema decision log records it.
- **`config_reads` is non-monotonic** by design — inherited from python, documented in both
  places rather than silently absorbed.
- **SDK lockstep.** `python-sdk`'s TypeScript models are `extra="forbid"`; six new application
  keys must land there before its analyzer pin moves. Same obligation python's own release carries.
- **Cross-analyzer joins need `--app-name` agreement**; analyzers pointed at different
  subdirectories of one monorepo will disagree on artifact ids.

## Definition of done

- Units A–D land as staged commits on `feat/issue-101-artifacts`, each green, closing #101 via
  PR #103.
- Every gate above passes; the spec's caveats are reflected in `.claude/SCHEMA_DECISIONS.md`.
- `CLAUDE.md`, `README.md` (`--help` block), and the epic comment trail record the shipped
  contract; `artifacts-and-dependencies.md` is marked superseded by this spec.
