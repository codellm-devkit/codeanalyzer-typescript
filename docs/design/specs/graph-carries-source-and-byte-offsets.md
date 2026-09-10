# The graph carries `source` and byte offsets

Tracking: codeanalyzer-typescript #201. Ships in 1.6.0 (analyzer minor — new graph properties).
`SCHEMA_VERSION` stays at the held `2.0.0`; detection is by presence. Adopts property spellings
coined by codeanalyzer-java #254 / PR #255, **merged 2026-09-10 14:45Z** — the four names were
re-read from java's post-merge `schema.neo4j.json` and adopted verbatim, see D6.

## Problem

The two projections disagree about the primary text, and the graph is the wrong one.

The canonical model makes a module's whole-file `source` the primary text, and every narrower
node's text a UTF-8 byte slice of it (`span.bytes`, #179, `docs/design/specs/span-bytes-are-bytes.md`).
`analysis.json` carries `source`. The Neo4j projection does not: `:TSModule`
(`src/build/neo4j/schema.ts:120`) carries `content_hash` and `exports_json` but no `source`, while
`:TSCallable` keeps `code` — a *derivation* of the source the graph no longer holds. The intent was
explicit, at `src/build/neo4j/project.ts:81`: `// source text stays off the graph (hash + size
dereference to it)`. This spec reverses that decision.

The flattened span is the other half of the same defect. `const SPAN = { start_line: "integer",
end_line: "integer" }` (`src/build/neo4j/schema.ts:55`) drops the columns and the byte offsets, and
`...SPAN` is spread into **ten** node labels. Carrying `source` without byte offsets makes nothing
sliceable, so the two move together or neither does.

Net effect: nothing narrower than a callable resolves to text on the graph backend, and `python-sdk`
documents living with it — the "Projection-lossy fields" note at
`cldk/analysis/typescript/neo4j/neo4j_backend.py:68`. A required `source` field cannot express "the
projection did not carry this", so the SDK reports `""` and the lossiness is invisible at the type
level.

Until this lands the grammar is split: a database holding two languages has sliceable Java nodes and
unsliceable ones from this analyzer, so a cross-language "give me the text at this span" query cannot
be written at all.

## Contract-impact triage

Changes schema v2 output: **yes** — one property on `:TSModule`, four on the shared `SPAN`, which
rides every `can://`-keyed label. Change type: **schema v2 evolution**.

| Repo | Why it is affected | Tracked as |
|---|---|---|
| codeanalyzer-typescript | the change itself | #201 |
| codeanalyzer-java | **coins the four names**; issue #254, PR #255 | upstream, D6 |
| codeanalyzer-python | same defect class is plausible but unverified here — `codeanalyzer-python#203` is the *other* half (the #202 class), not this one | #201 goal, D7 |
| python-sdk | its projection-lossy note goes stale, and required-`source`-returns-`""` masks the gap | #201 goal, D8 |
| codeanalyzer-schema | records this analyzer's schemas per `bfa5bef` | #201 goal, D9 |

Tracking shape: **one work item, #201**, with the sibling repos as named checklist items in its
goals rather than child issues — the change lands in one PR here, and each sibling's own work is a
separate PR on a separate clock, filed when picked up. No epic; this is not plural enough to need a
coordination record.

## Decision

| # | Concept | Decision | Rationale |
|---|---|---|---|
| D1 | **`source` on the module node** | `:TSModule` carries `source`, the whole file, byte-identical to what `analysis.json` carries for that module. Always present, never absent: an empty file yields `""`. | A consumer must never have to distinguish "not carried" from "empty" — the distinction the SDK currently cannot express. |
| D2 | **`SPAN` gains four properties** | `start_column`, `end_column`, `start_byte`, `end_byte`, beside the existing line pair, at all ten `...SPAN` sites. Byte offsets are UTF-8, the #179 meaning, sliced with `Buffer`. | Columns and bytes are what make a span resolve to text; without them `source` buys nothing. |
| D3 | **Those spellings are not ours** | Adopt codeanalyzer-java's four verbatim. This repo does not get to name them. | The parity clause: a term coined twice is permanently wrong. java's PR #255 spells them exactly thus, and PR #258 is stacked on it, so they are already load-bearing in java's own stack. |
| D4 | **`code` stays** | The callable `code` property is NOT dropped, even though D1+D2 make it derivable. | `python-sdk` reconstructs from it. Removing it is a breaking change and belongs to its own decision, not this one. |
| D5 | **`SCHEMA_VERSION` does not move** | Held at `2.0.0` per codellm-devkit/.github#50, so the addition is presence-detectable only. | Noting the tension plainly: `schema.ts:19` says "MINOR on additive", which would make this `2.1.0`. The org decision freezes the number until every analyzer re-baselines together, and the artifact layer (#101) already shipped additively under the same freeze. Local policy yields to the org decision; when the re-baseline happens, this addition is part of what it accounts for. |
| D6 | **Sequencing: wait for java** | RESOLVED. #255 merged 2026-09-10 14:45Z (and #258, stacked on it, at 14:50Z); implementation then proceeded. Java's merged snapshot carries `start_column`/`end_column`/`start_byte`/`end_byte` on 8 labels and `source` on `JModule` + `Artifact`, `schema_version` still `2.0.0` — the spellings survived review unchanged, and were adopted from the merged artifact rather than the PR diff. | #255 was open, unreviewed and hours old when this was written. Shipping first and having its review move a spelling would make *this* analyzer the second coining — the exact outcome D3 exists to prevent. The wait cost nothing and removed the risk entirely. |
| D7 | **python's state is a question, not an assumption** | Verify whether codeanalyzer-python's graph carries `source` and byte offsets before claiming a third sibling is affected. A `gh search code` for `start_byte` came back empty, which is weak evidence — code-search indexing lags. | The affected-repo list should not carry a guess dressed as a fact. If python has the same gap it needs its own issue; `codeanalyzer-python#203` does not cover it. |
| D8 | **the SDK's lossy note is in scope to flag, not to fix** | This change makes `cldk/analysis/typescript/neo4j/neo4j_backend.py:68` stale. `python-sdk` is not edited here; the staleness is reported to that repo. | #201's scope boundary says it does not change `python-sdk`, and the SDK ships on its own clock. |
| D9 | **the recorded snapshot re-records** | `bun run gen:schema` regenerates `schema.neo4j.json`, and the release CI records it in `codeanalyzer-schema`. | RESOLVED: #199 merged as `7f7a795`, so the recording step is on `main` ahead of the 1.6.0 tag. |
| D10 | **java's `body_` prefix is reserved, not adopted** | PR #258 coins `body_start_line` … `body_end_byte` for a declaration's body block, and a `spanKey` span discriminant for span-keyed MERGE. Neither is adopted here. | This analyzer has no body span in its JSON model at all — `grep bodySpan\|body_span src/schema/schema.ts` is empty — so there is nothing to project. That is a JSON-side parity gap deserving its own issue, not something to invent on the projection. `spanKey` has no use while every node here is keyed by its `can://` id; it becomes relevant to #202's decorator positions, where `:TSDecorator` merges on `name`. |

## Consequence found during implementation

Carrying whole-file `source` puts arbitrary file text inside the rendered Cypher, which breaks any
test that scans that text for a bare substring. `test/neo4j-prefix-scope.test.ts` asserted
`expect(cypher).not.toContain("_module")` to prove the `_module` property is gone (#140) — and any
fixture whose source says `node_modules` now contains that substring legitimately. The assertion was
re-pointed at the projected rows' property keys, which is what it always meant. Expect the same
collision in any future test that greps rendered output.

## Release plan

1. **Now** — this spec commits; #201's goals gain the sibling checklist items and its wrong premise
   ("java fixed it in #255") is corrected to "java proposes it in #255, unmerged".
2. **Gate** — codeanalyzer-java PR #255 merges. Only then does implementation start (D6).
3. **Implement** — `SPAN` + `:TSModule` in `src/build/neo4j/schema.ts`; `project.ts` already threads
   the module source to the projection (`project.ts:74`), so the value is in hand and the diff is small.
   Regenerate `schema.neo4j.json`. Strengthen `test/neo4j-schema.test.ts` per the definition of done.
4. **Ship** — analyzer 1.6.0. Wants PR #199 landed first so the schema recording fires (D9).
5. **After** — report the stale note to `python-sdk` (D8); resolve python's actual state (D7) and file
   an issue there if the gap is real; file the body-span JSON gap (D10).

Nothing in step 3–5 gates on #202, and #202 gates on this: it needs these byte offsets before any
position it carries can be checked by slicing.

## Definition of done

- Every module node carries `source`, and each one's hash matches the `content_hash` that same node
  declares — that is what proves the value survived serialization intact rather than merely being
  present.
- `Buffer.from(source).subarray(start_byte, end_byte)` equals the `code` property already on the
  node, byte-for-byte, for every callable where both are present, with zero mismatches. This is the
  check that the offsets are real rather than merely declared, and it is a `Buffer` slice, not
  `String.slice` (#179).
- At least one fixture module contains a non-ASCII character before a declaration, so a char-offset
  regression fails the above rather than passing by coincidence.
- Every one of the ten `...SPAN` labels emits the four new properties; asserted per label, not by
  spot-check.
- `bun run gen:schema` leaves `schema.neo4j.json` unchanged (emitted schema matches the snapshot).
- `bun test` and `bun run typecheck` green.
