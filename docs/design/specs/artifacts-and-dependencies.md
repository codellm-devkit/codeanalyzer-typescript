# Artifacts and dependencies — the repository-artifact layer for TypeScript

- **Status:** accepted, not yet implemented
- **Scope:** `codeanalyzer-typescript`; schema v2 **additive** (no level, id-tier, or existing-field movement)
- **Parity anchor:** codeanalyzer-python's SHIPPED layer (`51ee29e`, "repository-artifact layer
  (artifact/dependency/config_key)") — the implementation, which supersedes the draft
  `2026-08-27-artifacts-and-dependencies-design.md` where they differ (ids are
  language-namespaced with an `@artifact/` marker, not the draft's neutral `can://artifact/`
  namespace; Neo4j labels are language-prefixed per the org label contract; no import-binding
  or purl in this unit)
- **Tracking:** one work item, one PR, branch stacked on `feat/issue-100-linker-propagation`

## Contract-impact triage

| Question | Answer |
| --- | --- |
| Schema v2 shape | **additive**: `application.artifacts{}` + contained `dependencies{}`/`config_keys{}`; new node kinds `artifact`, `dependency`, `config_key`; new id marker `@artifact/` (outside the `signatureOf` space, like `@external/`) |
| Levels / monotonicity | ungated, identical at `-a 1..4` (entrypoints posture); `L1 ⊆ … ⊆ L4` holds trivially |
| schema_version | unchanged (python kept 2.0.0 for the same change); Neo4j contract bumps additively 2.1.0 → **2.2.0** |
| Repos | `codeanalyzer-typescript` now; **python-sdk**: verify its TS models tolerate the new `application` keys (extras-ignore) — checklist line, not a child issue; repo docs |
| Shared vocabulary movement | ONE additive token: dependency `scope: "peer"` (npm's contract-with-host; the closed enum was runtime\|development\|test\|build\|optional\|unknown). Recorded like the `"reaching-defs"` precedent; python's Literal grows when next touched |

## The mirrored model (field-for-field with python's shipped shapes)

```
application.artifacts: Record<repoRelPath, TSArtifact>     # like symbol_table keys modules

TSArtifact    id = can://typescript/<app>/@artifact/<path> (assignIds stamps per run)
              kind: "artifact"
              artifact_kind: build_manifest | dependency_lockfile | configuration |
                             deployment_manifest | container | infrastructure | ci |
                             script | documentation | data | other      (closed, catch-all)
              path, format?, source? (producing subsystem), content_hash (sha256, always),
              size_bytes (always), text? (verbatim, capture policy), text_encoding?,
              text_truncated
              dependencies: Record<name, TSDependency>     # contained children
              config_keys: Record<dottedKey, TSConfigKey>

TSDependency  id = <artifactId>/<name>   kind: "dependency"
              name (npm-native, @scope kept), version_spec?, resolved_version?,
              ecosystem: "npm", scope: runtime|development|test|build|optional|peer|unknown,
              direct: true    (direct:false reserved; no transitive records this unit)

TSConfigKey   id = <artifactId>/<dotted-key>   kind: "config_key"
              key, namespace?, value?, references[], span?
```

Dotfiles keep their leading dot in ids (python's rule — `.env` is exactly what this inventories).
`TSArtifact.source` is the SUBSYSTEM string (python's field), not file text — text lives in
`text`; the name collision with `module.source` is inherited parity, documented here.

## Locked TS decisions (design session 2026-08-27)

1. **`peer` scope token coined** (additive shared vocabulary). npm mapping:
   `dependencies→runtime`, `devDependencies→development`, `optionalDependencies→optional`,
   `peerDependencies→peer`; `bundledDependencies` names ride the matching records (no own scope).
2. **Extraction targets:** every `package.json` (workspace roots AND members — each is its own
   `build_manifest` artifact with its own contained dependencies). Lockfiles all become
   `dependency_lockfile` artifacts; **extraction parses the JSON family only** —
   `package-lock.json` / `npm-shrinkwrap.json` / `bun.lock` backfill `resolved_version`;
   `yarn.lock` / `pnpm-lock.yaml` are inventory-only (no new parser dependency), documented as
   such via absent `resolved_version`.
3. **Declared-only records:** lockfiles never create dependency records; transitive-only
   packages are skipped this unit (payload sanity on npm's full trees; `direct:false` stays
   reserved for a later unit).
4. **Config keys this unit:** `.env`-family (flat keys, `namespace: "env"`) and JSON configs
   (dotted keys — `tsconfig*.json`, `.eslintrc.json`, …). YAML configs are artifact nodes
   without key extraction (no YAML dependency), same posture as the lockfile rule.
5. **Roles table** (filename rules → artifact_kind/format) ships in code,
   `src/artifacts/rules.ts`: package manifests/locks, `tsconfig*`/rc-configs, `Dockerfile*`/
   compose (`container`/`deployment_manifest`), `.github/workflows/*` (`ci`), `*.sh`/bin
   scripts, `*.md` (`documentation`), data files, `other` catch-all. A file is never dropped
   for lack of a rule.
6. **Capture policy:** `--artifact-text-max-bytes` (default 256 KiB, python's flag + default);
   over-cap → `text_truncated: true`, hash/size still present; undecodable bytes → no `text`,
   no `text_encoding`.

## Pipeline and projection

- New `src/artifacts/` (`index.ts` walk + rules, `deps.ts`, `config.ts`); reuses the discovery
  `SKIP_DIRS` and sorted order; runs in `analyze()` after the symbol table, ungated by level;
  **not cached** (trivial cost, python's call).
- `assignIds` stamps artifact/dependency/config-key ids per run (they embed `--app-name`, same
  rule as every durable id); builders leave them `""`.
- Wire: the three families are wire fields (nothing stripped — `content_hash` here is payload,
  unlike the module cache trio; the strip list is keyed on module/callable fields only, but the
  implementation must verify no INTERNAL_KEYS collision — `content_hash` collides! The strip
  filter moves from key-name matching to structural stripping of module/callable internals, or
  artifacts are serialized outside the replacer's reach; decided at implementation, gate:
  artifact `content_hash` must appear on the wire).
- Neo4j (contract 2.2.0, org language-prefix rule): `:TSArtifact` / `:TSDependency` /
  `:TSConfigKey` nodes; `TS_HAS_ARTIFACT` (application→artifact), `TS_DECLARES_DEPENDENCY`
  (artifact→dependency), `TS_DEFINES_CONFIG` (artifact→config_key); id-unique constraints;
  full-depth-always unchanged.

## Definition of done

- `application.artifacts` with contained dependencies/config_keys emitted identically at
  `-a 1|2|3|4`; monotonicity + conformance gates green.
- Fixture app carrying: root+workspace `package.json`, `package-lock.json`, `bun.lock`,
  `yarn.lock` (inventory-only), `.env`, `tsconfig.json`, a `Dockerfile`, a workflow file —
  every scope token incl. `peer` asserted; artifact `content_hash` asserted ON the wire.
- Neo4j rows for the three families + `schema.neo4j.json` regenerated at 2.2.0.
- Determinism: two consecutive default runs byte-identical.
- python-sdk: VERIFIED NOT tolerant — `cldk/models/typescript/models.py` is `extra="forbid"` by design, so the SDK must gain the three families (TSArtifact/TSDependency/TSConfigKey + `application.artifacts`) BEFORE its pinned analyzer version moves to a release carrying this layer. Release-ordering constraint, python's own 51ee29e has the same obligation.
- CLAUDE.md + SCHEMA_DECISIONS.md updated; `--artifact-text-max-bytes` in `--help`/README.

## Release plan

Ships in the minor AFTER the linker train (#97 → #99 → #100 → this), as an additive schema
feature; schema_version unmoved, Neo4j 2.2.0 noted in release notes. SDK LOCKSTEP REQUIRED
(discovered at implementation): the SDK's `extra="forbid"` models reject the new keys — the
python-sdk model update must land before the SDK's analyzer pin moves.
