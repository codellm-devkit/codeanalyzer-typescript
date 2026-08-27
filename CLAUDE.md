# CLAUDE.md

Agent guidance for `codellm-devkit/codeanalyzer-typescript` (`cants`).

## What this project is

`cants` = TypeScript/JavaScript static analyzer built on TypeScript compiler
(via [ts-morph](https://ts-morph.com/)). CLDK TypeScript backend: emits
**canonical schema v2** — one additive Code Property Graph — in **two projections**,
`analysis.json` and **Neo4j** property graph. Mirrors
[Python](https://github.com/codellm-devkit/codeanalyzer-python) and
[Java](https://github.com/codellm-devkit/codeanalyzer-java) sibling analyzers, so
output-shape parity with them first-class concern.

## Schema v2 — the additive CPG (read this before touching output)

Output = **one scale-free structure**: containment tree of nodes (id / kind /
`span` / children) with **typed edge overlays** (CPG). Every classic artifact — symbol
table, call graph, CFG, PDG, SDG — is *projection* of that one structure. Analysis
**levels** = how deep it populated (each level only *adds*, never rewrites):

- **L1** (`-a 1`): tree to callable depth — `application → symbol_table{module} →
  types{}/functions{}/fields{} → callables{}` — plus `call` nodes in each callable's
  `body{}` (`callee` unresolved). `source` stored once per module; every node's
  text slices off it via `span.bytes`.
- **L2** (`-a 2`): `call_graph` edge list (callable→callable) at application scope,
  and `callee` slot on each call node refined `null → id` (only sanctioned mutation).
- **L3** (`-a 3`): rest of `body{}` (statements + `@entry`/`@exit`) and intra-callable
  edge lists `cfg`/`cdg`/`ddg` (reaching-definitions, `prov:["reaching-defs"]`) hung on each callable.
- **L4** (`-a 4`): synthetic `@formal_in:N`/`@formal_out`/`<L>/actual_in:N`/`<L>/actual_out`
  vertices, intra-caller `summary` edges, and application-scope `param_in`/`param_out`
  lists (interprocedural SDG).

**Identity two-tier**: durable `can://<lang>/<app>/<file>/<type>/<sig>` ids at callable
depth and above; ordinal `<callable-id>@<line>:<col>` (or `@<tag>`) below. Intra-callable
edge lists use **bare local ids**; cross-callable lists use **fully-qualified `can://…@local`**
ids. `L1 ⊆ L2 ⊆ L3 ⊆ L4` = CI-checkable monotonicity gate (`test/schema-v2.test.ts`).
Model + every decision live in `.claude/SCHEMA_DECISIONS.md` (§ "Schema v2 migration") and
skillset's `canonical-schema.md`.

**Provider/client boundary:** analyzer = *pure graph provider* — emits graph
substrate (CFG/PDG/SDG + `summary` edges) and stops. Slicing and taint = reachability
*queries* over it, belong to frontend SDK; never add `taint_flows` section here.

Schema v2 = **native model** (#96): stages build v2 tree directly (`src/schema/schema.ts`,
one model family — no v1 model, no emit-time reshape). Per-run passes stamp derived
layers (python parity): `assignIds` (can:// ids — per-run because ids embed `--app-name`
while cache round-trips tree), `l1Body` (`call_sites` → `body{}`), `heritage`,
`homing` + `l2Callees` (L2), `dataflow/attach` (L3/L4). `finalizeAnalysis`
(`src/schema/emit.ts`) runs them + assembles envelope + strips INTERNAL fields
(`call_sites`, `abs_path`, cache trio).

Call graph = tsc resolver + **defuse linker** (#98): deterministic per-callable
pass over resolver leftovers — alias chains, decorator edges, library-callback
edges, bounded interprocedural votes, CHA-by-name fallback. No whole-program
fixpoint, no backend flag, one code path. Module-scope calls attributed to
MODULE (python #131 parity). prov tags: `tsc` / `defuse` / `import`. Joern
superset ledger: `docs/design/specs/defuse-linker-joern-ledger.md`.

## Architecture — follow the pipeline

Whole analyzer = one orchestration function: `analyze()` in `src/core.ts`. Read
it first; everything else is stage it calls, in order:

1. **materialize** (`src/build`) — resolve/prepare target project deps.
2. **buildSymbolTable** (`src/syntactic_analysis`) — modules, classes, interfaces,
   enums, type aliases, namespaces, functions, methods, variables, decorators,
   JSDoc, with precise source spans.
3. **call graph** (`src/semantic_analysis`) — tsc resolver (`callGraph.ts`, incl.
   module-scope sweep + RTA + phantoms) then `defuseLinker.ts` tiers T1–T5;
   merged with provenance union.
4. **program graphs** (`src/dataflow`) — levels 3–4 (`-a 3`/`-a 4`): CFG → post-dominance/CDG →
   access-path def-use → PDG → SCC-condensed bottom-up summaries → SDG. This is *compute*
   (IR in `src/schema/graphs.ts`); `src/dataflow/attach.ts` writes it **onto tree**
   (`body{}` + `cfg`/`cdg`/`ddg`/`summary` per callable + `param_in`/`param_out`).
   Decisions: `.claude/SCHEMA_DECISIONS.md`; contract + staged follow-ups: issue #2.
5. **cache** (`src/utils/cache.ts`) — content-hash cache under `.codeanalyzer/`; stores
   **id-free** builder tree only (ids/body/heritage = per-run layers; levels 3–4 also
   record summaries + dependency edges in `graphs_summaries.json`).
6. **finalize + output** — `finalizeAnalysis` (`src/schema/emit.ts`, called by `analyze()`)
   runs pass spine, returns `AnalysisResult` {`application` (wire `TSAnalysis` envelope),
   `internal`, `program_graphs`, gates}; `src/utils/serialize.ts` writes envelope verbatim;
   `src/build/neo4j` projects *same* envelope into `graph.cypher` snapshot or incremental
   Bolt push. `--emit neo4j` always **full-depth** (levels gate JSON path only; combining
   `-a`/`--graphs` with it = error).

**Output** shape = schema v2 (`src/schema/schema.ts`: `TSAnalysis` envelope →
`TSApplication` root → `TSModule`/`TSType`/`TSCallable`/`TSField`/`TSBodyNode`).
Same types = the model stages build; INTERNAL fields never reach wire.
Neo4j schema (`src/build/neo4j/schema.ts`) versioned and enforced by conformance
test — treat both as contracts, keep in lockstep with JSON.

## Directory map

| Path | Responsibility |
|------|----------------|
| `src/main.ts`, `src/cli.ts` | Entry point + Commander CLI |
| `src/core.ts` | `analyze()` orchestrator — the spine |
| `src/options` | Parsed CLI options / `AnalysisOptions` |
| `src/syntactic_analysis` | Symbol table (ts-morph traversal) |
| `src/semantic_analysis` | Call graph: tsc resolver + defuse linker (T1–T5), phantoms |
| `src/dataflow` | L3/L4 program-graph **compute** (CFG, dominance/CDG, def-use, summaries, SDG) + `attach.ts` (IR → tree) |
| `src/schema` | **the native v2 model** (`schema.ts`) + per-run passes (`assignIds`/`l1Body`/`heritage`/`homing`/`l2Callees`) + `emit.ts` (`finalizeAnalysis`) + `signatureOf` + graphs IR |
| `src/build` | Dep materialization; `build/neo4j` = the v2 graph projection (project/rows/cypher/bolt/schema) |
| `src/utils` | fs, caching, logging, serialization (`serialize.ts` writes the envelope), version |
| `test` | Bun tests + `fixtures/sample-app` + `fixtures/dataflow-app`; `schema-v2.test.ts` = the L1–L4 gates |

**Repository-artifact layer** (#101, python PR #160 parity): `application.artifacts{}`
(rules-matched non-code files, LANGUAGE-NEUTRAL `can://artifact/<app>/<path>` ids,
roles[], verbatim unbounded `source`) + flat `dependencies[]` (npm kinds incl.
coined `peer`, prov-tagged, lock backfill) + `unresolved_imports[]` (@types
type-only rule; `--resolve-installed` opt-in probe). `src/artifacts/`. Neo4j
contract 2.2.0: NEUTRAL :Artifact/:Package (purl) — sanctioned prefix exception —
plus TS_PROVIDES/TS_UNRESOLVED_IMPORT into :TSExternal ghosts.

## Commands

- `bun run start -- --input /path/to/project` — run analyzer from source.
- `bun run build` — compile standalone `dist/cants` binary.
- `bun test` — run tests. Container tests: `bun run test:container` (needs Docker).
- `bun run typecheck` — `tsc --noEmit`.
- `bun run gen:schema` — regenerate `schema.neo4j.json`.
- `bun run gen:readme` — regenerate README's `cants --help` block.

## I implement features myself — you assist

For feature work, **I write the implementation** to stay fluent in my own analyzer.
Act as helper, not author:

- **Don't write feature code** or apply edits to implement it unless I explicitly
  ask ("write this", "implement X", "apply it"). Default to guiding, not doing.
- **Do** move me fast: explain relevant stage, point at prior art (e.g. existing
  call-graph provider in `src/semantic_analysis` as template for new one), sketch
  signatures/types, outline approach, answer questions about codebase.
- **Review on request:** when I share diff or push, critique it — correctness,
  **parity with Python/Java backends**, schema conformance, missing tests, edge
  cases — and suggest concrete improvements.
- Scaffolding like tests or boilerplate fine **when I ask**; otherwise leave
  keyboard to me.
- If you think I'm about to go wrong, say so briefly and let me decide — don't pre-empt
  by implementing the fix.

## Rules

1. **Think before coding.** State assumptions explicitly; ask rather than guess. Push
   back when simpler approach exists. Stop when confused.
2. **Simplicity first.** Guide me toward minimum idiomatic code that solves the
   problem. Nothing speculative; no abstractions for single-use code.
3. **Issue → branch → work → PR.** Every change starts as issue, on branch named
   `feat/issue-XXX`, `fix/issue-XXX`, `chore/issue-XXX`, lands via PR.
4. **Guard the contract.** Changes to `src/schema` or Neo4j output must keep parity
   with sibling analyzers and pass schema conformance test.

## Goal-driven execution, as a teaching loop

Success measured by sole fact that **I understand it**. Success criterion:
I can point to exact line of code where any feature lives, however remote or
obscure, and explain why it's there and how it behaves.

To that end, be my teacher and Socratic one — not answer key:

- Lead with questions that make me derive answer; don't hand me solution.
- Verify understanding, not just behavior — have me locate and explain relevant
  LOC, walk edge cases, predict what change would do before running it.
- Teach, help improve, strengthen weak spots you surface; circle back to them.
- Loop closes when I can **teach it back** and place every feature on a line, not
  merely when tests pass.
- Over session, frequently — but not so much that I am stymied — ask spaced
  repetition questions so concepts internalized.

Learning progress tracked globally, not per-repo: see SRS deck and
"continual learning" defaults in `~/.claude/CLAUDE.md`.

# Auxiliary support tasks

## Tidy up the release announcement

Every `vX.Y.Z` tag makes release workflow (`.github/workflows/release.yml`)
auto-post announcement to **Announcements** discussion (this repo, and
org mirror in `codellm-devkit/.github`). That body machine-generated from
release notes / PR titles — mis-categorizes changes, includes `chore(release)`
noise, buries breaking changes.

When working in this repo, check whether latest release's announcement
still needs cleanup, and if so, fix it:

1. **Find it.** `gh release view --json tagName,publishedAt`; then list recent
   discussions via `gh api graphql` (repository → discussions), match category
   `Announcements` and title `vX.Y.Z`. Keep discussion node `id`, read its
   `body`.
2. **Skip if already done.** If body starts with `<!-- cleaned-up -->` (or already
   reads as clear, human-written announcement), do nothing.
3. **Otherwise rewrite it** into clear, user-facing announcement, grounded in
   `CHANGELOG.md` and referenced PRs/diff (not auto-grouping — verify each
   change; never invent anything):
   - **breaking changes first**, each with one-line migration step;
   - plain-language highlights (what it does, not PR title);
   - upgrade lines — `pip install -U "codeanalyzer-typescript==X.Y.Z"`, or
     `brew upgrade codellm-devkit/homebrew-tap/codeanalyzer-typescript`, or
     shell installer one-liner;
   - links to GitHub release and `CHANGELOG.md`.
4. **Update in place.** Edit discussion body with GraphQL `updateDiscussion`
   mutation (don't open new one), prepend `<!-- cleaned-up -->`, mirror same
   body to org discussion. This task only reads code and edits Discussions — makes
   no commits.
