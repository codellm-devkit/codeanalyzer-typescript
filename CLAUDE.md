# CLAUDE.md

Agent guidance for `codellm-devkit/codeanalyzer-typescript` (`cants`).

## What this project is

`cants` is a TypeScript/JavaScript static analyzer built on the TypeScript compiler
(via [ts-morph](https://ts-morph.com/)). It is the CLDK TypeScript backend: it emits
the **canonical schema v2** — one additive Code Property Graph — in **two projections**,
`analysis.json` and a **Neo4j** property graph. It mirrors its
[Python](https://github.com/codellm-devkit/codeanalyzer-python) and
[Java](https://github.com/codellm-devkit/codeanalyzer-java) sibling analyzers, so
output-shape parity with them is a first-class concern.

## Schema v2 — the additive CPG (read this before touching output)

The output is **one scale-free structure**: a containment tree of nodes (id / kind /
`span` / children) with **typed edge overlays** (a CPG). Every classic artifact — symbol
table, call graph, CFG, PDG, SDG — is a *projection* of that one structure, and analysis
**levels** are how deeply it is populated (each level only ever *adds*, never rewrites):

- **L1** (`-a 1`): the tree to callable depth — `application → symbol_table{module} →
  types{}/functions{}/fields{} → callables{}` — plus `call` nodes in each callable's
  `body{}` (with `callee` unresolved). `source` is stored once per module; every node's
  text slices off it via `span.bytes`.
- **L2** (`-a 2`): the `call_graph` edge list (callable→callable) at the application scope,
  and the `callee` slot on each call node refined `null → id` (the one sanctioned mutation).
- **L3** (`-a 3`): the rest of `body{}` (statements + `@entry`/`@exit`) and the intra-callable
  edge lists `cfg`/`cdg`/`ddg` (reaching-definitions, `prov:["reaching-defs"]`) hung on each callable.
- **L4** (`-a 4`): the synthetic `@formal_in:N`/`@formal_out`/`<L>/actual_in:N`/`<L>/actual_out`
  vertices, the intra-caller `summary` edges, and the application-scope `param_in`/`param_out`
  lists (the interprocedural SDG).

**Identity is two-tier**: durable `can://<lang>/<app>/<file>/<type>/<sig>` ids at callable
depth and above; ordinal `<callable-id>@<line>:<col>` (or `@<tag>`) below. Intra-callable
edge lists use **bare local ids**; cross-callable lists use **fully-qualified `can://…@local`**
ids. `L1 ⊆ L2 ⊆ L3 ⊆ L4` is a CI-checkable monotonicity gate (`test/schema-v2.test.ts`). The
model + every decision live in `.claude/SCHEMA_DECISIONS.md` (§ "Schema v2 migration") and the
skillset's `canonical-schema.md`.

**Provider/client boundary:** the analyzer is a *pure graph provider* — it emits the graph
substrate (CFG/PDG/SDG + `summary` edges) and stops. Slicing and taint are reachability
*queries* over it and belong to the frontend SDK; never add a `taint_flows` section here.

The v1→v2 emitter is a pure transform in **`src/schema/v2/`** (`emit.ts` reshapes the v1
in-memory model, `dataflow.ts` maps `program_graphs` into the tree) — the parse/resolve/
dataflow *compute* is untouched; only serialization is v2.

The call graph defaults to the **union** of two backends: the TS compiler's resolver
and the embedded [Jelly](https://github.com/cs-au-dk/jelly) flow analyzer (which
recovers higher-order/callback edges the resolver misses). Merged edges keep a
`provenance` tag (`tsc` / `jelly`); `--tsc-only` or `--call-graph-provider jelly`
selects one alone.

## Architecture — follow the pipeline

The whole analyzer is one orchestration function: `analyze()` in `src/core.ts`. Read
it first; everything else is a stage it calls, in order:

1. **materialize** (`src/build`) — resolve/prepare the target project's deps.
2. **buildSymbolTable** (`src/syntactic_analysis`) — modules, classes, interfaces,
   enums, type aliases, namespaces, functions, methods, variables, decorators, and
   JSDoc, with precise source spans.
3. **call graph** (`src/semantic_analysis`) — `selectProvider()` picks tsc / jelly /
   union; each provider returns edges + external (phantom) symbols.
4. **program graphs** (`src/dataflow`) — levels 3–4 (`-a 3`/`-a 4`): CFG → post-dominance/CDG →
   access-path def-use → PDG → SCC-condensed bottom-up summaries → SDG. This is the *compute*;
   it produces the internal `program_graphs` model, which `src/schema/v2/dataflow.ts` then maps
   **into the v2 tree** (`body{}` + `cfg`/`cdg`/`ddg`/`summary` per callable + `param_in`/
   `param_out`). Decisions: `.claude/SCHEMA_DECISIONS.md`; contract + staged follow-ups: issue #2.
5. **cache** (`src/utils/cache.ts`) — content-hash cache under `.codeanalyzer/`, so
   re-analysis only touches what changed (levels 3–4 also record summaries +
   dependency edges in `graphs_summaries.json`).
6. **output** (`src/schema/v2`, `src/build/neo4j`) — `src/schema/v2/emit.ts` reshapes the v1
   compute model into the schema-v2 `analysis.json`; `src/build/neo4j` projects the *same* v2
   tree into a `graph.cypher` snapshot or an incremental Bolt push. `--emit neo4j` is always
   **full-depth** (levels gate the JSON path only; combining `-a`/`--graphs` with it is an error).

The **output** shape is schema v2 (`src/schema/v2/model.ts`, `V2Application` the top type); the
types in `src/schema` (`TSApplication`) are the *internal compute model* the emitter transforms.
The Neo4j schema (`src/build/neo4j/schema.ts`, v2.0.0) is versioned and enforced by a conformance
test — treat both as contracts and keep them in lockstep with the JSON.

## Directory map

| Path | Responsibility |
|------|----------------|
| `src/main.ts`, `src/cli.ts` | Entry point + Commander CLI |
| `src/core.ts` | `analyze()` orchestrator — the spine |
| `src/options` | Parsed CLI options / `AnalysisOptions` |
| `src/syntactic_analysis` | Symbol table (ts-morph traversal) |
| `src/semantic_analysis` | Call-graph providers (tsc, jelly, union), phantoms |
| `src/dataflow` | L3/L4 program-graph **compute**: CFG, dominance/CDG, def-use, summaries, SDG |
| `src/schema` | `TSApplication` — the internal compute model + `signatureOf` + `program_graphs` |
| `src/schema/v2` | **the schema-v2 emitter**: `model.ts` (target shape) + `emit.ts` (tree/L1/L2) + `dataflow.ts` (L3/L4) |
| `src/build` | Dep materialization; `build/neo4j` = the v2 graph projection (project/rows/cypher/bolt/schema) |
| `src/utils` | fs, caching, logging, serialization (`serialize.ts` → `toV2`), version |
| `test` | Bun tests + `fixtures/sample-app` + `fixtures/dataflow-app`; `schema-v2.test.ts` = the L1–L4 gates |

## Commands

- `bun run start -- --input /path/to/project` — run the analyzer from source.
- `bun run build` — compile the standalone `dist/cants` binary.
- `bun test` — run tests. Container tests: `bun run test:container` (needs Docker).
- `bun run typecheck` — `tsc --noEmit`.
- `bun run gen:schema` — regenerate `schema.neo4j.json`.
- `bun run gen:readme` — regenerate the README's `cants --help` block.

## I implement features myself — you assist

For feature work, **I write the implementation** to stay fluent in my own analyzer.
Act as a helper, not the author:

- **Don't write the feature code** or apply edits to implement it unless I explicitly
  ask ("write this", "implement X", "apply it"). Default to guiding, not doing.
- **Do** move me fast: explain the relevant stage, point at prior art (e.g. an existing
  call-graph provider in `src/semantic_analysis` as the template for a new one), sketch
  signatures/types, outline an approach, and answer questions about the codebase.
- **Review on request:** when I share a diff or push, critique it — correctness,
  **parity with the Python/Java backends**, schema conformance, missing tests, edge
  cases — and suggest concrete improvements.
- Scaffolding like tests or boilerplate is fine **when I ask**; otherwise leave the
  keyboard to me.
- If you think I'm about to go wrong, say so briefly and let me decide — don't pre-empt
  by implementing the fix.

## Rules

1. **Think before coding.** State assumptions explicitly; ask rather than guess. Push
   back when a simpler approach exists. Stop when confused.
2. **Simplicity first.** Guide me toward the minimum idiomatic code that solves the
   problem. Nothing speculative; no abstractions for single-use code.
3. **Issue → branch → work → PR.** Every change starts as an issue, on a branch named
   `feat/issue-XXX`, `fix/issue-XXX`, `chore/issue-XXX`, and lands via a PR.
4. **Guard the contract.** Changes to `src/schema` or Neo4j output must keep parity
   with the sibling analyzers and pass the schema conformance test.

## Goal-driven execution, as a teaching loop

Success is measured by the sole fact that **I understand it**. The success criterion:
I can point to the exact line of code where any feature lives, however remote or
obscure, and explain why it's there and how it behaves.

To that end, be my teacher and a Socratic one — not an answer key:

- Lead with questions that make me derive the answer; don't hand me the solution.
- Verify understanding, not just behavior — have me locate and explain the relevant
  LOC, walk edge cases, and predict what a change would do before running it.
- Teach, help improve, and strengthen the weak spots you surface; circle back to them.
- The loop closes when I can **teach it back** and place every feature on a line, not
  merely when the tests pass.
- Over the session, frequently — but not so much that I am stymied — ask spaced
  repetition questions so concepts are internalized.

Learning progress is tracked globally, not per-repo: see the SRS deck and the
"continual learning" defaults in `~/.claude/CLAUDE.md`.

# Auxiliary support tasks

## Tidy up the release announcement

Every `vX.Y.Z` tag makes the release workflow (`.github/workflows/release.yml`)
auto-post an announcement to the **Announcements** discussion (this repo, and the
org mirror in `codellm-devkit/.github`). That body is machine-generated from the
release notes / PR titles — it mis-categorizes changes, includes `chore(release)`
noise, and buries breaking changes.

When you're working in this repo, check whether the latest release's announcement
still needs cleanup, and if so, fix it:

1. **Find it.** `gh release view --json tagName,publishedAt`; then list recent
   discussions via `gh api graphql` (repository → discussions), match category
   `Announcements` and title `vX.Y.Z`. Keep the discussion node `id` and read its
   `body`.
2. **Skip if already done.** If the body starts with `<!-- cleaned-up -->` (or already
   reads as a clear, human-written announcement), do nothing.
3. **Otherwise rewrite it** into a clear, user-facing announcement, grounded in
   `CHANGELOG.md` and the referenced PRs/diff (not the auto-grouping — verify each
   change; never invent anything):
   - **breaking changes first**, each with a one-line migration step;
   - plain-language highlights (what it does, not the PR title);
   - upgrade lines — `pip install -U "codeanalyzer-typescript==X.Y.Z"`, or
     `brew upgrade codellm-devkit/homebrew-tap/codeanalyzer-typescript`, or the
     shell installer one-liner;
   - links to the GitHub release and `CHANGELOG.md`.
4. **Update in place.** Edit the discussion body with the GraphQL `updateDiscussion`
   mutation (don't open a new one), prepend `<!-- cleaned-up -->`, and mirror the same
   body to the org discussion. This task only reads code and edits Discussions — it
   makes no commits.
