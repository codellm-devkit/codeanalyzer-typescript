# tsc + defuse linker call graph (Jelly removal)

- **Status:** accepted, not yet implemented
- **Scope:** `codeanalyzer-typescript` only; one PR, tracked in #98
- **Tracking:** #98 (work item); branch `feat/issue-098-defuse-linker`, stacked on
  `refactor/issue-096-native-v2-model` (#97) — lands after it merges
- **Parity precedent:** codeanalyzer-python 1.2.0, which replaced PyCG's global fixpoint with
  Jedi + a per-callable defuse linker
  (`codeanalyzer-python/docs/design/specs/2026-08-25-defuse-linker-call-graph-design.md`, #148
  there). This spec is the TypeScript instantiation of that architecture; divergences are called
  out explicitly.

## Motivation

Jelly is the analyzer's scale ceiling and its heaviest dependency. It is a whole-program flow
analysis — the same cost class as python's removed PyCG (3h19m on odoo without convergence;
Fraunhofer CPG OOM at 44GB on the same corpus) — and it is bundled INTO the shipped binary
(`src/main.ts` `__jelly` dispatch, `CANTS_SELF_JELLY`, `patches/`, the `@cs-au-dk/jelly`
dependency). On the vscode-class targets we want to analyze, the Jelly leg is unusable; the tsc
leg alone loses exactly the edges Jelly recovers.

Measured on the repo fixtures (union provider, L2): 79 edges total, of which **6 are
jelly-only**, in four sharp classes:

| Class | Fixture evidence |
| --- | --- |
| Decorator invocations | `UserController.show → Get`, `→ Param`, `list → Get` (sample-app) |
| Library-mediated callback edges | `UserService.describeAll → <anon@37:27>` (lambda passed to `.map`) |
| Receiver typing inside anons | `<anon@37:27> → User.describe` (element type of the mapped array) |
| Param-flow calls | `<anon@20:16> → named` via a function-valued parameter (anon-app) |

Small counts, but the classes are the point: each is a bounded, per-callable resolution problem.
The expensive substrate already exists in this repo as the L3 kernels
(`src/dataflow/defuse.ts` — k-limited access-path def-use with the flow-insensitive alias
substrate — plus the CFG machinery). The replacement follows the same Joern/Fraunhofer CPG
architecture python adopted: a fast base graph from the type-checker, then a **local** linker
pass that backfills what the resolver missed. No global fixpoint anywhere.

## Contract-impact triage

| Question | Answer |
| --- | --- |
| Schema v2 shape (node/edge kinds, fields, ids, levels) | unchanged; schema_version stays **2.1.0** |
| `prov` vocabulary | `"jelly"` disappears; **`"defuse"`** coined for linker-derived edges (technique-named, matching python's `"defuse"` and the DDG's `"reaching-defs"`/`"points-to"`). `"tsc"` and `"import"` unchanged. Both-found edges merge to `["defuse", "tsc"]` via the existing provenance union |
| Refinement contract | unchanged — the linker runs inside the L2 build; `callee: null→id` stays the single sanctioned refinement |
| Monotonicity gate | unaffected (edges only added at L2, as today) |
| `synthesized_callables` | shape + 2.1.0 compat index unchanged; the residual-fallback path stays, but provider-reported unknowns effectively vanish (tsc + linker only name tree signatures) |
| Repos | `codeanalyzer-typescript` now. **python-sdk follow-up** (separate PR, next SDK minor): the `tsc_only` kwarg threads `cldk/core.py` → `backend_config.py` → `typescript/codeanalyzer.py` → `typescript_analysis.py` and passes `--tsc-only`; it must be removed once this releases. SDK `prov` is passthrough (`List[str]` — verified), no model change |
| CLI (**BREAKING**) | `--call-graph-provider` and `--tsc-only` removed; one code path, no backend flag (python: "the linker is cheap and deterministic; nothing to opt out of") |

## Locked decisions (design session 2026-08-26)

1. **tsc resolver is the base call graph, always.** Its edges keep `prov: ["tsc"]`; RTA
   expansion and the phantom/import leg (`prov: ["import"]`) are untouched.
2. **Jelly is removed wholesale**: `src/semantic_analysis/jellyProvider.ts`, the union provider
   and `selectProvider`, `options.callGraphProvider`, both CLI flags, the `__jelly` argv mode in
   `src/main.ts`, `CANTS_SELF_JELLY`, the `@cs-au-dk/jelly` dependency, its `patches/`, and
   `union-provider.test.ts` (superseded by the linker suite + reference validation).
3. **The linker runs at L2 with targeted kernels**: def-use state is built only for callables
   that still contain unresolved call sites after the tsc leg. Per-callable, no fixpoint,
   **sorted iteration mandated** — deterministic by construction.
4. **Linker edges carry `prov: ["defuse"]`** and merge with tsc edges through the existing
   `mergeCallGraphs` provenance union. Resolutions reach the L1 `call` body nodes through the
   same channel the tsc leg uses today, with python's cache rule preserved: linker resolutions
   are **never persisted into `callee_signature`** (the symbol table round-trips the analysis
   cache; a persisted resolution would resurface on a warm run with the wrong provenance).
5. **External-callback edges are kept** — a deliberate, documented **divergence from python**:
   when a function value (anonymous or named) is passed as an argument to an external or
   unresolved callee, the linker emits `enclosing-callable → function-value`,
   `prov: ["defuse"]`, **edge-only** (no body call node — matching Jelly's observed behavior;
   there is no real call site in first-party code). Rationale: JS/TS is callback-central, and
   2.1.0 materialized anonymous callables as tree nodes precisely so they can be addressed —
   they must stay reachable by edge, not only by containment. The parity clause covers shared
   vocabulary, not per-language recall.
6. **Decorator invocations become linker edges**, same edge-only rule: decorators are captured
   in the model (`decorators[]` with `qualified_name`) but their factory calls are outside
   `walkBody`'s reach, so no body node exists today and none is added (adding one would move the
   wire). The linker resolves `qualified_name`/`name` against the symbol table and emits
   `decorated-owner → decorator`, `prov: ["defuse"]`.
7. **No backend flag.** One code path.

## Tier ladder

Tiers land in order; the Joern ledger (below) decides how far down the ladder the
implementation must go before the gate is clean. Each tier is per-callable or bounded-round —
never a fixpoint.

- **T1 — local value chase.** For an unresolved call site whose callee expression is a local
  binding: chase the def-use chain (existing `defuse.ts` kernels, k-limited access paths)
  through alias assignments (`const f = handler; f()`) to a function literal / declaration /
  import binding. Imports resolve cross-module through the symbol table (the checker already
  did most of this; the chase covers what it declared as "a variable", not "a function").
- **T2 — decorator edges** (decision 6).
- **T3 — external-callback rule** (decision 5).
- **T4 — interprocedural votes, bounded.** A type-oracle round in python's style, narrowed by
  what tsc already proves: (a) function values passed at **resolved internal** call sites vote
  for the callee's parameter — a parameter-invoking site (`cb()`) resolves to the voted
  functions; (b) return summaries (`return inner` / unique ctor returns) let
  `const f = factory(); f()` resolve; (c) `this.x = fn` property assignments type
  `this.x()` sites. Two bounded rounds (round one's resolutions vote before round two),
  internal-target votes only.
- **T5 — CHA-by-name fallback.** Receiver call sites that survive every typed tier resolve to
  every internal callable of that method name (bounded per site) — the over-approximation Joern
  itself emits for untyped receivers. Applied last so precise resolutions are never widened.

## Reference validation (the enforced gate)

Mirrors python's method, per the maintainer's mandate: iterate edge-for-edge against **Joern
`jssrc2cpg`** (available in `~/workspace/codellm-devkit/joern-dist`) until our call graph is a
**strict superset of every real edge** Joern produces on the validation corpus:

- **Corpus:** `test/fixtures/sample-app`, `dataflow-app`, `anon-app`, plus **one real-world
  express/nest application** vendored or pinned at implementation time (the toy fixtures alone
  are too small to trust a superset claim).
- **"Real edge"** = both endpoints exist in source and are nameable in this schema; Joern's
  synthetic families (`<lambda>N` internals where we hold the positional anon node, `<body>`,
  `<meta*>`, fabricated members) are excluded through a **committed exception ledger, audited
  per class** — python's discipline, not a waiver.
- **Scale benchmark:** microsoft/vscode at L1/L2 — wall-clock, peak RSS, edge counts by `prov`
  — reported in the PR next to Joern `jssrc2cpg` on the same tree (or its failure mode). The
  giant-JSON emission ceiling is out of scope here (separate issue); the benchmark measures the
  analyze/compute phase and the Bolt projection path.

## Acceptance

- Joern superset ledger committed: 100% real-edge coverage per corpus app, every residual
  classified.
- **Jelly-recovery spike metric** (python's PyCG analog): of today's jelly-only edges on the
  fixtures, the % the linker recovers — reported in the PR, no hard gate (some jelly edges may
  be judged junk by the ledger; the report says which and why).
- **A/B determinism:** paired runs byte-identical on the corpus `call_graph` (the linker adds
  no nondeterminism; tsc inference is deterministic — stronger than python's Jedi caveat).
- Full suite, typecheck, monotonicity and Neo4j conformance gates green; `git grep -li jelly`
  over `src`/`packaging`/`patches`/`package.json` returns nothing; the binary loses its
  `__jelly` mode and shrinks.

## Release plan

- Ships in the analyzer's next MINOR (with the #96 native-model rewrite already queued for it);
  release notes carry **BREAKING** lines for the removed `--call-graph-provider`/`--tsc-only`
  flags — python 1.2.0 precedent for a flag removal in a minor. schema_version untouched.
- **python-sdk follow-up (tracked in this spec; file the issue when picked up):** remove the
  `tsc_only` kwarg chain and its `--tsc-only` pass-through, then bump the SDK's pinned analyzer
  version. Until it lands, `tsc_only=True` against the new binary is the one known break.
