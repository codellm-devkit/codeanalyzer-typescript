# Sharded, two-wave L4

Status: proposed. Implements [#112](https://github.com/codellm-devkit/codeanalyzer-typescript/issues/112)
Step 4 ("shard by program, union by id"), extended with a second wave that recovers what plain
sharding drops.

## Problem

Whole-vscode `-a 4` does not complete. It is killed at 28.0-31.7 GB across six configurations
(exit 133 — JSC aborting on heap exhaustion, not the OS OOM killer, which is why raising
`gcMaxHeapSize` to 40G did not help: it still died, at 31.65 GB).

Six restructurings of the analysis phases were measured and none moved the ceiling meaningfully.
The reason is that the cost is not in the phases that were restructured:

| measurement (`vscode/src`, `-a 4`) | value |
| --- | --- |
| RSS already committed when the interprocedural phase begins | **21.33 GB** |
| `datas` (126,236 callables, 991,277 CFG nodes, 1,304,747 CFG edges, 808,409 CDG edges) | 0.34 GB |
| `ddg` (1,691,626 edges) | 0.09 GB |
| `summaries` (126,236 entries) | 0.05 GB |
| **total retained by the whole interprocedural phase** | **0.48 GB** |

L4 is the *cheapest* phase in the run by retained bytes. The 21.33 GB is tsc's own
parse/bind/check state, which the analyzer does not own and cannot restructure. Every attempt to
shrink an analyzer-owned structure was therefore targeting a fraction of a gigabyte against a
roughly 10 GB gap.

This spec follows from that: **the only lever left is to stop holding all of tsc's state at once.**

## Design

Two waves. The load-bearing property is that **wave 2 needs no tsc state at all** — it is pure
computation over graph IR that wave 1 has already produced and written down.

### Wave 1 — per program

Run once per discovered program, with `--input` pinned to the **repository root** and `--app-name`
fixed. Each run builds only its own program's `Project`, analyses it to full L4 *within* the
program, and writes a shard plus its IR.

Peak memory becomes the largest single program. That bound is measured, not assumed: vscode's
largest program is `src`, and it completes `-a 4` at **28.75 GB**.

### Wave 2 — cross-shard stitch

Load the persisted IR only. No `Project`, no checker, no ASTs. Recompute the SCC condensation over
the **complete** call graph (all shards' edges plus the cross-program edges), redo the fixpoint for
components that span shards, replace the provisional summaries, and emit the additional `summary`
and `ddg` edges.

Scaled from the table above, whole-vscode IR is roughly 1 GB — against a 21 GB tsc floor that wave 2
never pays.

## Why ids make this work

`can://<language>/<appName>/<fileKey>/<sig-path>` (`src/schema/ids.ts`) embeds **no program
identity**. With `--input` and `--app-name` held fixed, the same file yields a byte-identical id in
any shard, so the union is defined by id equality and needs no rewriting step.

Two supporting invariants, both already true:

- **Modules are disjoint across shards by construction.** `ownerProgram` (`src/syntactic_analysis/symbolTable.ts:41`)
  assigns each discovered file to exactly one program, deepest scope wins. No module can appear in
  two shards, so the JSON union is concatenation with no conflict-resolution rule to invent.
- **Neo4j needs no new code.** The projection `MERGE`s on the `can://` id, so pushing shard after
  shard converges on the same graph a single run would have produced.

Note the constraint this places on sharding granularity: ids are stable because `fileKey` is
relative to `--input`. Sharding by *input root* instead of by program would change every `fileKey`
and break the union. Program granularity is therefore the floor — this scheme cannot be subdivided
further to buy more headroom.

## Shard size distribution

Measured by replicating `ownerProgram` over vscode's discovered source files (13,370 files across
99 tsconfig scope dirs, 96 of them non-empty):

| shard | files | share |
| --- | --- | --- |
| `src` | 8,966 | **67.1%** |
| `extensions/copilot` | 2,659 | 19.9% |
| `build` | 226 | 1.7% |
| `extensions/terminal-suggest` | 187 | 1.4% |
| remaining 92 | <= 157 each | ~10% combined |

**The distribution is the opposite of even: two shards hold 87% of the repository.** Three
consequences, and they shape both the value and the limits of this design:

1. **The peak barely moves.** The `src` shard is the same tree the standalone 28.75 GB `-a 4` run
   covered. Sharding makes whole-vscode L4 *complete* — today it fails because all 96 programs are
   held at once — but it lands at roughly 28.75 GB, not at some comfortably lower number.
2. **There is no headroom, and no way to make more.** `src` cannot be subdivided: sharding below
   program granularity would change `fileKey` and break id stability (see above). If `src` grows,
   this design runs out, and the next lever is #112 Step 3 (incremental reuse), not a finer split.
3. **Parallel orchestration buys almost nothing.** Wall-clock is dominated by one shard. Running
   the 94 small shards concurrently is fine but shortens nothing material; running `src` and
   `copilot` concurrently would *defeat the purpose*, since holding both is close to the failure
   this design exists to avoid. Shards must run sequentially, or at most with the small ones
   batched alongside one large one.

## What plain sharding costs, measured

Measured on the whole-vscode `-a 3` output (which does complete: 19m41s, 28.4 GB, 1.41 GB), by
replicating `ownerProgram`'s deepest-scope-wins rule over the repository's 99 tsconfig scope dirs:

| | edges | share |
| --- | --- | --- |
| same-program | 1,042,391 | **97.4%** |
| cross-program | 28,345 | **2.6%** |
| external / unresolved endpoints (excluded) | 90,128 | — |

Top cross-program pairs:

| edges | from | to |
| --- | --- | --- |
| 5,420 | `extensions/copilot` | `src` |
| 2,617 | `extensions/git` | `src` |
| 2,416 | `src` | `extensions/copilot` |
| 1,394 | `src` | `extensions/git` |
| 1,239 | `extensions/typescript-language-features` | `src` |

Wave 1 alone would drop those 28,345 edges. Wave 2 exists to recover them.

**These edges run in both directions** (`copilot → src` 5,420 *and* `src → copilot` 2,416), so
genuine SCCs span program boundaries. Wave 2 is therefore not a leaf patch that composes known
callee summaries into callers — it must redo the fixpoint for cross-shard components.

## Persistence

`<cache_dir>/graphs_summaries.json` already exists and is **write-only today** — one write site
(`src/dataflow/index.ts:481`), no reader. It persists `FunctionSummary` + `content_hash` per
signature, keyed by signature, under `PROGRAM_GRAPHS_SCHEMA_VERSION` (currently `1.0.0`).

That is the *callee* half. Wave 2 also needs the *caller* half — `CallableGraphData`
(`src/dataflow/model.ts:115`) — to recompose a caller once a callee's summary changes. It is not
persisted today.

Favourable accident: `CallableGraphData` is already a pure data structure, with `facts` and
`aliasPairs` stored as pairs explicitly "for clone-safety". It is JSON-serializable as-is, so
persistence is a serialization decision rather than a redesign.

Both artifacts must be keyed and versioned so a wave-2 run can reject IR from a mismatched
analyzer, `k_limit` (`--graph-field-depth`), or schema version.

## Correctness

The acceptance criterion is an **equivalence property, not a smoke test**:

> For any repository where a single-process L4 run completes, `wave1 + wave2` must produce a
> byte-identical `analysis.json` to that single run.

Validate on `vscode/src` (which completes at 28.75 GB), the three fixture apps at `-a 4` with every
graph selector, and superset. Only then is the result on whole vscode — where no baseline exists —
worth trusting.

The `L1 ⊆ L2 ⊆ L3 ⊆ L4` monotonicity gate (`test/schema-v2.test.ts`) must hold on the union, not
just per shard.

## Caveats and known risks

- **The margin is thin.** The largest shard measures 28.75 GB against a wall observed between
  28.0 and 31.7 GB. This makes whole-vscode L4 reachable, not comfortable, and program granularity
  is the floor (see above) — there is no finer split available if `src` alone grows.
- **L4's loss under wave 1 alone exceeds 2.6%.** That figure counts edges. Summaries propagate
  transitively, so one dropped cross-program edge truncates every summary chain through it. 2.6% is
  the floor on the damage, not an estimate of it. This is the whole reason wave 2 is in scope
  rather than deferred.
- **Wave 2's affected set may be large by count.** It is the backward reachability closure from the
  28,345 edges' source callables — potentially a large fraction of all callables, even though it is
  roughly 1 GB by weight. Cheap in memory; not necessarily cheap in time.
- **Wave 1 summaries are provisional wherever a callee is cross-program.** Replacing one
  invalidates its callers transitively. Wave 1 output must be marked as such so a wave-1-only run
  is never mistaken for complete L4.
- **Not validated against a whole-vscode L4 baseline**, because that baseline is precisely what
  does not exist. The equivalence property above is the substitute, and it is weaker.
- **Orchestration is out of scope here.** Whether the shards are driven by a script, a flag, or the
  analyzer itself is a separate decision; this spec fixes only the id/union/IR contract that makes
  any orchestration correct.

## CLI surface (proposed)

Additive; nothing existing changes shape.

- `--program <tsconfig-relpath>` (repeatable) — restrict this run to the named program(s). Must
  restrict **both** the constructed `Project`s **and** the symbol-table file set: restricting only
  the `Project`s would leave discovery and symbol-table cost repo-wide and would not lower peak.
- `--emit-ir` — write `CallableGraphData` alongside `graphs_summaries.json`.
- `--stitch <shard-dir...>` — wave 2. Consumes shards plus IR, emits the unioned analysis.

`--input` and `--app-name` must be identical across all waves; the stitch step must verify this and
refuse to proceed on a mismatch, since a divergence silently produces a wrong union rather than an
error.

## Decomposition (proposed — needs sign-off)

Tracking granularity follows PR granularity. Suggested units, each filed just-in-time as it is
picked up rather than all now:

1. `--program` selector + shard-correct symbol-table restriction. Independently useful: it makes
   any single program analysable on a machine that cannot hold the repository.
2. IR persistence + versioning (`--emit-ir`), with the round-trip test.
3. Shard union for the JSON projection, with the equivalence test on `vscode/src`.
4. Wave 2 stitch: cross-shard SCC condensation and fixpoint.

Neo4j needs no unit — `MERGE` on `can://` id already unions shards.

Units 1-3 are shippable without unit 4 only if wave-1 output is explicitly marked incomplete at L4
(see caveats).

## Open questions

- Does wave 2 need the full `datas` for every affected caller, or only a reduced per-call-site
  composition record? The reduced form would cut IR volume and wave-2 load time; it has not been
  worked out and may not be worth the added shape.
- Is `PROGRAM_GRAPHS_SCHEMA_VERSION` the right version anchor for the IR, or does the IR want its
  own, given it would now have a reader and a cross-run contract?
- Sibling parity: python and java have the same whole-repository ceiling in principle. If this
  design holds, does the `can://`-union property get written up as a cross-language contract rather
  than a TypeScript implementation detail?
