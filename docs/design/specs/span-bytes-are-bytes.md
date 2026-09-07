# `span.bytes` are UTF-8 byte offsets

Tracking: codeanalyzer-typescript #179. Ships in 1.5.0. Neo4j contract unchanged at 2.0.0; the
`analysis.json` field keeps its name and shape — its VALUES change for every node that follows a
non-ASCII character in its file.

## Problem

`span.bytes` was documented (`src/schema/schema.ts`) and produced as UTF-16 char offsets — ts-morph's
`getStart()`/`getEnd()` — while the canonical keystone (`get_method_body(sig)` →
`module.source[callable.span.bytes]`) and codeanalyzer-python (`byte_offsets`, `_span_code` doing
`source.encode("utf-8")[lo:hi]`) mean bytes. The Neo4j projection's `spanCode` already sliced a
UTF-8 `Buffer` by them, so `:TSCallable.code` ran short by exactly the multibyte surplus inside the
span: python-sdk's sample `src/index.main` contains one em dash (3 bytes) → 2 bytes short → the
closing `\n}` missing. A consumer with one slicing rule across languages was wrong on every
non-ASCII TypeScript file.

## Decision

| # | Concept | Decision | Rationale |
|---|---|---|---|
| D1 | **`span.bytes` meaning** | UTF-8 byte offsets into the module's `source`, every node, every level: declarations, body nodes (`call`/`config_access` at L1, statements and `@entry`/`@exit` at L3), the module's own span (`[0, byteLength]`), and artifact `ConfigKey` spans. `Buffer.from(source).subarray(lo, hi)` reproduces the text; `source.slice(lo, hi)` no longer does on a non-ASCII file. | Python parity and the keystone's meaning; one slicing rule per SDK, not one per language. |
| D2 | **Where conversion happens** | One utility, `src/schema/offsets.ts`: `offsetMapOf(source)` (ASCII fast path = identity; otherwise a cumulative `Uint32Array` built once per text and cached per owning object). Producers convert on the way OUT (builders' `richSpan`, call-site and config-access spans, the module span, `dataflow/attach` for the L3 IR's char offsets, `artifacts/yamlKeys`). Consumers that need a compiler position convert on the way IN (`dataflow/configUse.nodeAtSpan`, `semantic_analysis/defuseLinker` factory lookup, `entrypoints/matching` default-export resolution). The dataflow IR (`schema/graphs.ts` `start_offset`/`end_offset`) stays in char units — internal, never on the wire. | A single definition of the mapping; ts-morph keeps its native positions internally so no compiler call changes. |
| D3 | **Version** | Analyzer 1.5.0 (minor): a documented field's values move toward the documented contract; Neo4j contract stays 2.0.0. Cache invalidates by analyzer version. | Not a new field or shape; consumers on ASCII files see no change at all. |
| D4 | **Consumers** | python-sdk's TypeScript leg (2.5, #343) slices bytes as its python side already does; the four `xfail(strict=True)` marks in its parity harness flip on the release. | The SDK's shared `_slice` rule becomes language-neutral. |

## Definition of done

- A fixture with multibyte chars before and inside declarations: for every callable, call-site body
  node, L3 statement, `@entry`/`@exit`, `config_access`, and the module span, `Buffer` slicing by
  `span.bytes` reproduces the node's text byte-for-byte; `:TSCallable.code` equals that slice.
- Existing consumers still resolve: config-use call rules, the defuse linker's factory tier, the
  Next.js default-export file rule — all exercised by their existing tests on ASCII fixtures plus
  one non-ASCII case each.
- `bun test` green, `-j` determinism unchanged, docs (`schema.ts` comments, `vocabulary.md`,
  `CLAUDE.md`) say bytes.
