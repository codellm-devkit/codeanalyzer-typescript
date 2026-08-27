# Artifacts and dependencies — the repository-artifact layer for TypeScript

- **Status:** implemented (branch `feat/issue-101-artifacts`); **recalibrated 2026-08-27** to the
  ratified python contract after the first cut anchored on an orphaned branch
- **Scope:** `codeanalyzer-typescript`; schema v2 **additive** (no level, id-tier, or existing-field movement)
- **Parity anchor:** codeanalyzer-python **PR #160** (implementation of the approved spec
  `2026-08-27-artifacts-and-dependencies-design.md`, PR #158). NOT the `51ee29e`
  `feat/configuration-files` branch — that shape (language-namespaced `@artifact/` ids, contained
  dependency/config-key children, `artifact_kind` enum, text-capture caps) was never merged; this
  spec's first revision mirrored it and has been rebuilt.
- **Tracking:** one work item (#101), one PR (#103), branch stacked on `feat/issue-100-linker-propagation`

## Contract-impact triage

| Question | Answer |
| --- | --- |
| Schema v2 shape | **additive**: `application.artifacts{}` (flat nodes), `application.dependencies[]` (flat evidence rows), `application.unresolved_imports[]` |
| Identity | artifact ids are **language-NEUTRAL**: `can://artifact/<app>/<path>` — the first `can://` segment is a namespace (a language for code, the literal `artifact` for files), so sibling analyzers over one repo emit the SAME id for the same file. `<app>` agreement is the precondition for cross-analyzer joins |
| Levels / monotonicity | ungated, identical at `-a 1..4`; monotonicity holds trivially |
| schema_version | unchanged; Neo4j contract 2.1.0 → **2.2.0** (additive) |
| Repos | `codeanalyzer-typescript` now; **python-sdk** must gain the three families before its analyzer pin moves (its models are `extra="forbid"` — verified; python's own PR #160 carries the same obligation); repo docs |
| Shared vocabulary movement | ONE additive token: dependency `kind: "peer"` (npm's contract-with-host) against the ratified enum `runtime\|dev\|optional\|build`. Recorded like the `"reaching-defs"` precedent |

## The mirrored model (python PR #160 shapes)

```
application.artifacts: Record<repoRelPath, TSArtifact>
TSArtifact       id = can://artifact/<app>/<path> (per-run), kind "artifact", path,
                 format (json|jsonc|yaml|toml|ini|dockerfile|yarnlock|env|text),
                 roles[] (dependency-manifest|tool-config|container-image|service-topology|
                          ci|env|packaging|legal|docs|script|unknown),
                 size_bytes, sha256, source (verbatim, UNBOUNDED by decision — spec §3),
                 extraction (none|partial|full)

application.dependencies: TSDependency[]        # flat, no node ids — :Package (purl) is the node
TSDependency     name (@scope kept), spec, kind (runtime|dev|optional|peer|build), extras[] (npm: []),
                 declared_in (artifact id), locked_version?, provides_imports[],
                 prov[] (declared|lockfile|installed-metadata|heuristic)

application.unresolved_imports: TSImportBinding[]
TSImportBinding  module (specifier root), bound_to?, prov[]
```

## Locked TS decisions (recalibration session 2026-08-27)

1. **config_keys dropped** — python's unit 4 owns config extraction; config-role artifacts get
   node + roles + source only. The earlier TS config-key parser is parked (this file is its record).
2. **`peer` kind coined** (additive). npm mapping: `dependencies→runtime`,
   `devDependencies→dev`, `optionalDependencies→optional`, `peerDependencies→peer`.
3. **Capture is rules-matched only** (python's posture): the shipped table in
   `src/artifacts/rules.ts` (glob → format/roles, roles union across matches; basename patterns
   match at any depth, `/`-patterns anchor at root) + extensionless shebang files as `script`.
   An unmatched file is NOT an artifact. `source` is verbatim and unbounded (python's decision;
   revisit only with measured payload numbers); binary probe failures carry `source: ""`.
4. **Dependencies are declared-only and flat**: every `package.json` (workspace members included)
   emits records with `declared_in` = its artifact id; the JSON lock family
   (`package-lock.json`/`npm-shrinkwrap.json`/`bun.lock` JSONC) backfills `locked_version` on the
   OWNING (sibling) manifest's records and appends `"lockfile"` to `prov`; locks never create
   records; `yarn.lock`/`pnpm-lock.yaml` are inventory-only artifacts.
5. **provides_imports**: the package name itself; `@types/x` also provides `x`
   (DefinitelyTyped `scope__pkg` unmangled to `@scope/pkg`).
6. **Import binding / unresolved_imports**: every non-relative, non-builtin specifier ROOT from
   the symbol table's imports. A VALUE import needs the runtime package; an `import type` is
   satisfiable by `@types/x` alone. Only-@types-for-a-value-import → partially bound
   (`bound_to: "@types/x"`, `prov: ["heuristic"]`). `--resolve-installed` (opt-in, default off)
   probes `node_modules/<name>/package.json` (`prov: ["installed-metadata"]`); default runs read
   only repo files and stay byte-identical.
7. **Neo4j (contract 2.2.0)**: language-NEUTRAL `:Artifact` and `:Package` (purl ids,
   `pkg:npm/<name>`, scoped `pkg:npm/%40scope/<name>`) — the deliberate, sanctioned exception to
   TS-prefixing so sibling analyzers MERGE onto the same nodes (the conformance gate allowlists
   exactly these). Edges: `HAS_ARTIFACT`, `DECLARES_DEPENDENCY` (props spec/kind/extras/prov,
   `_k` = kind), `LOCKS` (version; fans from every lock artifact present — python's documented
   coarse fan), and the analyzer's own claims `TS_PROVIDES` (Package→minted module-level
   `:TSExternal` ghost) and `TS_UNRESOLVED_IMPORT` (application→ghost, prov). `source` stays off
   the graph.
8. **Pipeline**: `src/artifacts/` (rules, deps, binding, index) runs in `analyze()` after the
   symbol table (binding needs module imports), level-ungated, not cached; `assignIds` stamps
   artifact ids and re-stamps `declared_in` per run (`--app-name` rule).

## Definition of done

- Three sections emitted identically at every `-a`; monotonicity + conformance + count-parity
  gates green (parity gate counts neutral Artifact/Package rows + minted ghosts explicitly).
- Fixture app: root+workspace manifests, both JSON locks, `yarn.lock` inventory-only, `.env`,
  tsconfig, Dockerfile, CI workflow, LICENSE, an undeclared VALUE import, an `import type`
  satisfied by `@types` — every kind token incl. `peer`, prov chains, purl ids (scoped included),
  `--resolve-installed` exercised.
- Determinism: two consecutive default runs byte-identical.
- `schema.neo4j.json` regenerated at 2.2.0; CLAUDE.md + SCHEMA_DECISIONS + README/--help updated.

## Release plan

Ships in the minor after the linker train (#97 → #99 → #102 → #103); schema_version unmoved;
Neo4j 2.2.0 in release notes. **SDK lockstep required** (`extra="forbid"`): python-sdk gains the
three families before its pin moves. Cross-analyzer id joins additionally require pinned
`--app-name` agreement between analyzers (spec §2 precondition).
