---
name: analyzing-cants-graphs
description: Use when querying the cants (codeanalyzer-typescript) Neo4j graph — call-graph, structure, inheritance, control/data-flow, dependency/SBOM, or configuration-use questions, or when writing any Cypher over schema v2's projection.
---

# Analyzing cants graphs (schema v2, Neo4j projection)

One additive tree + typed edge overlays, projected as a property graph (`--emit neo4j` →
`graph.cypher` snapshot or live Bolt push). Vocabulary is fixed — **never guess a label, property,
or key** — it is all in [references/vocabulary.md](references/vocabulary.md), generated from
`src/build/neo4j/schema.ts` and enforced by `test/neo4j-schema.test.ts`. The recipe catalogue
(structure, calls, inheritance, control/data-flow, slicing, dependencies/artifacts/SBOM,
configuration) is [references/analyses.md](references/analyses.md); every recipe states its
minimum `-a` level.

This skill mirrors codeanalyzer-python's `docs/skills/analyzing-canpy-graphs/`, which documents
field *mechanics*. The traps below go further: each one is a place where a mechanically-correct
query answers the wrong question.

## What exists at which level

| `-a` | tree | edges |
| --- | --- | --- |
| 1 | callables + `call`/`config_access` body nodes (`callee` null) | `TS_DECLARES`, `TS_HAS_METHOD`, `TS_HAS_FIELD`, `TS_HAS_BODY_NODE`, `TS_EXTENDS`, `TS_IMPLEMENTS` |
| 2 | `callee` resolved | `TS_CALLS` (prov tsc/defuse/import), `TS_RESOLVES_TO`, `TS_USES_CONFIG` (literal tier) |
| 3 | full statement `body`, `@entry`/`@exit` | `TS_CFG_NEXT`, `TS_CDG`, `TS_DDG` (prov `reaching-defs`); `TS_USES_CONFIG` widens (+dataflow, intra) |
| 4 | `@formal_in:N`/`@formal_out`/`actual_in:N`/`actual_out` vertices | `TS_PARAM_IN`, `TS_PARAM_OUT`, `TS_SUMMARY`, `TS_DDG` widened (+`points-to`); `TS_USES_CONFIG` widens further (+dataflow, interprocedural — same `prov` tag as intra) |

The repository-artifact layer — `Artifact`/`Package`/`ConfigKey` and every edge among them
(`HAS_ARTIFACT`, `DECLARES_DEPENDENCY`, `LOCKS`, `DEFINES_CONFIG`, `TS_PROVIDES`,
`TS_UNRESOLVED_IMPORT`) — is **L1 data, level-free**: identical at every `-a`. Neo4j is always
projected **full-depth** for the level actually analyzed (`--emit neo4j` + `-a`/`--graphs`
together is a CLI error, not a partial graph).

## Identity in 20 seconds

- **`can://` ids are opaque** — match on properties, never delimiter-split an id.
- Code ids are two-tier: **durable** at callable depth and above —
  `can://<lang>/<app>/<fileKeyWithExt>/<memberPath>`, e.g.
  `can://typescript/artifacts-app/src/config.ts/readHost` — and **ordinal** below it, appended
  with `@`: `line:col` for statements/calls/`config_access`, `@entry`/`@exit`/`@formal_in:N`/
  `@formal_out` for synthetic vertices, `<callsite-local>/actual_in:N`/`<callsite-local>/actual_out`
  for actuals. Example: `can://typescript/artifacts-app/src/config.ts/readHost@12:3`.
- **`Artifact.id` is language-neutral**: `can://artifact/<app>/<path>` — no `typescript` segment,
  so a TS and a Python analysis of one monorepo mint the *same* id for the same file (see the
  `--app-name` trap below).
- **`Package.id` is a purl**: `pkg:npm/<name>`, scoped `pkg:npm/%40scope/<name>` — the
  cross-language SBOM join key.
- **`ConfigKey.id`** is `<artifactId>@key/<dotted>` (numeric segments for array indices, e.g.
  `services.web.ports.0`). The `key` *property* is always the bare dotted name; the *id* alone can
  carry an internal `arg.`/`env.` disambiguation prefix (see the `ARG` trap below) — never match on
  a `key` substring expecting to see that prefix.

## Standing traps

**`direct` — dependency surface vs. supply chain.**

> Your dependency *surface* and your dependency *supply chain* are different questions.
> "What does this app declare?" filters `direct: true`. "What actually ships / where does
> CVE-XXXX live?" needs the transitives — a vulnerable package four levels down is in your
> bundle whether or not you named it.

Both recipes live side by side in `references/analyses.md` §6. Scoping note: every
`direct: false` record is a top-level lock entry carrying `kind: "runtime"` — a lock file does not
record *why* a package is present, so this layer asserts the safe default instead of inferring one.

**Measured, so the magnitude is concrete, not asserted** (this repo, codeanalyzer-typescript
itself, `-a 1` — an illustrative sample, not a universal constant): 185 dependency records, 16
`direct: true` / 169 `direct: false` — **91% of records are transitive**, invisible to the
declared-surface query. That is why the two recipes above return wildly different answers on the
same repo. Keeping them is cheap: `dependencies[]` is ~41 KB of a 2.67 MB payload (~1.5%), so the
transitive records are not what drives payload growth here — verbatim artifact `source` text is.

**`config_reads` shrinks as `-a` rises — deliberately.** It is the layer's one non-monotonic
section (`config_uses` is the opposite: asserted superset-monotonic, L2 ⊆ L3 ⊆ L4 — verified on
this branch's fixture at 21/25/29 uses and 10/9/8 reads across L2/L3/L4). A read unresolved at the
literal tier can close at a higher dataflow tier, so it *moves* from `config_reads` into
`config_uses` as the level climbs. Diffing two levels and seeing a `config_reads` record vanish
means "resolved at the higher tier," never "fixed in the code." Pair the two: `config_uses` is the
graph edge (`TS_USES_CONFIG`); `config_reads` never became an edge — it is JSON-only, a record of
absence, not a graph fact (analyses.md §7).

**`--app-name` is the cross-analyzer join precondition.** Artifact ids are language-neutral
specifically so a TS and a Python analysis of one repository MERGE onto the same `:Artifact` node
— but only if both runs pinned the *same* `--app-name`. Two analyzers pointed at different
subdirectories of one monorepo, or run with mismatched app names, will silently disagree on every
artifact and package id and never merge.

**`sha256` is always the full file; `source` may not be — and in Neo4j, `Artifact` has no
`source` at all.** Under `--artifact-text-max-bytes`, `text_truncated: true` in `analysis.json`
means the stored `source` is a prefix — hash-compare on `sha256`, never on `source`, and never
re-derive meaning from a truncated copy (the analyzer itself always parses the full on-disk text
for extraction). In the graph, this is moot for a different reason: `Artifact` carries `sha256` +
`size_bytes` but **no `source` property at all** — verbatim text lives only in `analysis.json`, by
design (`src/build/neo4j/project.ts`: "`source` text stays off the graph — hash and size
dereference to it"). A query like `WHERE f.source CONTAINS "..."` will not error; it will silently
match nothing.

**`value` is present by default and absent under `--no-artifact-text`** — an absent `ConfigKey.value`
is a capture setting, not an empty or unset config key. Check `references/vocabulary.md`'s
`extraction` field before treating a missing `value` as "this key has no value."

**Dockerfile `ARG` is not bindable.** `ENV` mints an `env`-namespace key that a `process.env` read
can join; `ARG` mints a `dockerfile`-namespace key that deliberately never joins one — it exists at
build time only. A query that unions the two namespaces (or filters `ConfigKey` without checking
`namespace`) will report build-time values as runtime configuration. This is also why the config-key
*id* sometimes carries an `arg.`/`env.` prefix (see Identity above): the same bare name can mint
twice on one artifact — a Dockerfile's `ARG VERSION` beside its own `ENV VERSION=$VERSION` — and
only the id, never the `key` property, disambiguates them.

**`config_access` nodes are reads, not calls.** They carry `root`/`key?` (JSON only — not
projected to Neo4j) but no `callee` at any level, so joining them through `TS_RESOLVES_TO` finds
nothing — that relationship only ever targets a `call` node's resolution. Follow `TS_USES_CONFIG`
from the body node straight to the `ConfigKey` instead.

**`TSExternal` ghosts come in two grains that do not share an id.** Call-graph targets
(`.../@external/<module>/<name>`) and dependency/import-hygiene ghosts (`.../@external/<module>`,
no name segment) sit on the same label but different ids — join them by the `module` property when
a query needs both (`references/vocabulary.md`, "External ghosts").

**No entrypoint or import-graph vocabulary exists yet.** `TSCallable` carries no `is_entrypoint`; a
"reachable from the entrypoints" query needs a root set you supply yourself (analyses.md §2). A
module's `imports[]`/`exports[]` (specifiers, aliases, type-only flags) live only in
`analysis.json`'s `TSModule` — `TS_UNRESOLVED_IMPORT`/`TS_PROVIDES` cover the dependency-hygiene
case only, not a general per-module import graph.

Every trap above is a silent-empty-result failure, not an error: Cypher does not reject a query
naming a nonexistent label, property, or relationship — it just returns nothing. Cross-check
`references/vocabulary.md` whenever a query returns an empty result you did not expect.
