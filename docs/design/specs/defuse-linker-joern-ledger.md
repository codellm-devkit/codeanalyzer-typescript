# Joern superset ledger — tsc + defuse call graph (#98)

The enforced acceptance gate of `defuse-linker-call-graph.md`: the analyzer's L2 call graph must
be a **strict superset of every real call pair** Joern `jssrc2cpg` produces on the validation
corpus. "Real" = both endpoints exist in source and are nameable in the schema; everything
excluded is classified below and each class is audited, not waved through. Reproduce with
`scripts/joern/` (dump-calls.sc → compare_joern.py; RESIDUAL must be 0).

- **Joern:** v4 distribution, `jssrc2cpg` frontend (`~/workspace/codellm-devkit/joern-dist`)
- **Analyzer:** branch `feat/issue-098-defuse-linker` (tsc resolver + defuse linker, no Jelly)

## Result

| App | Joern real pairs | Covered | Residual | Our internal edges |
| --- | --- | --- | --- | --- |
| `test/fixtures/sample-app` | 23 | 23 | **0** | — |
| `test/fixtures/dataflow-app` | 19 | 19 | **0** | — |
| `test/fixtures/anon-app` | 2 | 2 | **0** | — |
| nestjs-realworld-example-app @ `c1c2cc4` (35 files) | 30 | 30 | **0** | 126 (4.2× Joern) |

A/B determinism: paired analyzer runs are byte-identical on all four apps (edge set + signature
universe hash-compared). The linker adds no nondeterminism; the tsc checker is deterministic.

Two analyzer fixes fell out of the iteration (python's reference-validation experience repeated):

1. **Concise-arrow call sites** — `u => u.describe()` never recorded the call (walkBody visited
   only the body's children); Jelly's approximated edge had been masking the L1 gap. Fixed in
   builders; the site now resolves TYPED through the checker.
2. **Module-scope callers** — calls executing at module scope (top-level `main()`, class
   decorators, the top-level express registration idiom) had no caller. Now attributed to the
   MODULE (python #131 parity), with the module prefix registered in `idBySig` so the edges
   re-identify onto the module node — stronger than python, whose module-caller endpoints stay
   raw quals on the wire.

## Exception classes (audited)

| Class | What it is | Verdict |
| --- | --- | --- |
| `joern-synthetic-helper` | Joern's own TS-lowering machinery: `__decorate`, `__param`, `__metadata`, `__runInitializers`, `__ecma.*` factories, `require`/`import` module plumbing | Fabricated by their desugaring; not source calls |
| `joern-unresolved` | `<unknownFullName>` with no linked callee — Joern itself could not resolve the site | Their unresolved set, by definition not edges |
| `external-…:external` | Callee homes outside the project (stdlib/`node_modules`) | Outside the internal-pair gate; our graph carries these as phantom edges with id-homed external nodes |
| `external-…:notin` (fabricated stubs) | (a) **parameters-as-callees**: `next()` inside an express middleware → Joern fabricates a file-local `::program:next` target (python ledger's identical family); (b) **decorator-value targets**: `@User(...)` where `User = createParamDecorator(...)` — the target is a const VALUE, not a declared callable; Joern fabricates an import stub local to the using file | Targets do not exist in source as callables; unnameable in this schema (and in truth) |
| `super`-to-interface | `Square.<init> → ColoredShape:super` where `ColoredShape` is an **interface** — erased at runtime, no constructor exists | Joern fabrication on heritage clauses |
| `decorator-attribution-variant` (counted covered) | Joern attributes a method decorator's factory call to the module (`::program → Get`, the desugared `__decorate` site); we attribute the SAME invocation to the decorated callable (`show → Get`) — finer, matching the historical Jelly shape | Same edge, more precise caller; listed, not hidden |

## Known non-goals (recorded, deliberate)

- **Property-arrow class members** (`foo = () => …`) are fields, not tree callables — calls
  through them resolve via T5's bounded CHA when typed lookup fails; a dedicated model for
  callable-valued properties is future schema work, not this issue.
- Deep dynamic dispatch through containers/registries beyond T4's bounded votes — the same
  class python documents as knowingly lost vs PyCG (and PyCG never converged where it mattered).
