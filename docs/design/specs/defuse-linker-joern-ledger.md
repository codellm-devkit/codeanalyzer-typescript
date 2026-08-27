# Joern superset ledger — tsc + defuse call graph (#98)

The enforced acceptance gate of `defuse-linker-call-graph.md`: the analyzer's L2 call graph must
be a **strict superset of every real call pair** Joern `jssrc2cpg` produces on the validation
corpus, plus a scale audit on microsoft/vscode. "Real" = a SINGLE-candidate Joern resolution
whose endpoints exist in source and are nameable in this schema; everything excluded is
classified below and audited per family, never waved through. Reproduce with `scripts/joern/`
(dump-calls.sc → compare_joern.py; corpus RESIDUAL must be 0).

- **Joern:** v4 distribution, `jssrc2cpg` frontend
- **Analyzer:** branch `feat/issue-098-defuse-linker` (tsc resolver + defuse linker, no Jelly)

## Corpus gate (enforced: residual 0)

| App | Joern real pairs | Covered | Residual |
| --- | --- | --- | --- |
| `test/fixtures/sample-app` | 23 | 23 | **0** |
| `test/fixtures/dataflow-app` | 19 | 19 | **0** |
| `test/fixtures/anon-app` | 2 | 2 | **0** |
| nestjs-realworld-example-app @ `c1c2cc4` (35 files) | 30 | 30 | **0** (ours: 126 internal edges, 4.2× Joern's 30) |

A/B determinism: paired analyzer runs byte-identical on every corpus app and on vscode's edge
dump (hash-compared). The linker adds no nondeterminism; the tsc checker is deterministic.

## vscode scale audit (microsoft/vscode @ a3c9dc6, `src/`, 8,735 TS files / 1.15M LOC)

64GB M-series (10 cores). Analyzer single-threaded (`-j 1`), eager, no deps materialized;
Joern on all 10 cores at `-Xmx48g`.

| Run | Wall | Max RSS | Output |
| --- | --- | --- | --- |
| cants L1 | **4m15s** | 18.9GB | 136,973 callables |
| cants L2 | **5m52s** | 24.4GB | **1,024,232 edges** — tsc 970,334 (324,525 resolved + 778,070 RTA + 89,344 phantom), defuse 54,170 (430 decorator / 26,466 callback / 1,797 votes / 31,581 CHA / rest chase) |
| cants **L4** (full SDG + artifact layer) | **10m42s** | 28.6GB | 1,028,736 call edges; CFG/CDG/DDG attached for 123,221 callables; **param_in 722,820 / param_out 200,775**; finalize survives via the structural (structuredClone) strip — the prior stringify-roundtrip clone OOM'd at exactly this scale, measured |
| Joern jssrc2cpg parse | **9m06s** | 30.3GB | CPG; 941,132 call rows + 768,350 parameter rows dumped (streamed writer — the single-StringBuilder dump crossed the JVM's 2GB array cap) |

Superset audit against Joern's single-candidate real pairs, after nine ledger-driven fix
rounds: **54,918 / 55,074 covered (99.72%), residual 135** — past python's odoo bar (99.0%,
final residual 243). Round 9/10 (#100): property-initializer attribution closed the whole
Registry-as-field family; the T4a property votes, T4b chained returns, and T4c ctor-field chain
landed; and Joern's parameter tables now PROVE the Promise-executor shadows (21 classified
`joern-param-shadow` by their own dump). Reference: the engines this architecture replaced DNF'd at this scale
class (PyCG 3h19m without convergence; Fraunhofer CPG OOM at 44GB).

### Analyzer fixes the ledger forced (python's reference-validation experience, repeated)

1. **Concise-arrow call sites** — `u => u.describe()` recorded no call (children-only body walk);
   Jelly's approximated edge had masked the L1 gap. Now checker-typed.
2. **Module-scope callers** — top-level `main()`, class decorators, the top-level express idiom
   had no caller. Attributed to the MODULE (python #131 parity), module prefix id-homed so the
   edges land on the module node.
3. **Tagged template calls** — `` inline`url(...)` `` was invisible to L1/L2 end to end (walkBody,
   resolver, call index), while L3's exception model already treated it as a call. vscode's
   cssValue idiom found it; regression-tested.
4. **Parameter-default initializer calls** — `f(sel, style = getSharedStyleSheet())` executes in
   the callee's activation but lived outside `getBody()`. vscode's domStylesheets family found
   it; regression-tested.
5. **JS sources were never discovered** — `SOURCE_EXTS` was ts-only, so vscode's vendored
   `marked.js` was "analyzed" through its bodiless `marked.d.ts` (zero edges from every body).
   `.js`/`.jsx`/`.mjs`/`.cjs` are first-class now, with two-way sibling rules: a `.js` beside a
   real `.ts` source is build output (skipped); a `.d.ts` beside an analyzed `.js` is its
   declaration file (skipped as a module — the checker still reads it from disk).
6. **T4c — the ctor-field callback chain** — `this.migrate(...)` where the field arrives through
   the constructor (parameter property / `this.f = param`) resolves to the function values passed
   at the class's `new` sites, with ONE bounded parameter hop (`register(key, cb)` →
   `new Migration(key, cb)`), and module-scope resolved calls feed the vote rounds — so the
   registered callbacks' own `write()` sites resolve too. vscode's migrateOptions family
   (22 pairs) closed end-to-end, no fixpoint anywhere.

## Exception classes (audited)

| Class | vscode count | What it is / verdict |
| --- | --- | --- |
| `joern-synthetic-helper` | 169,861 | Their TS-lowering machinery (`__decorate`, `__param`, `__metadata`, `__ecma.*`, `require`/`import` plumbing) — desugaring artifacts, not source calls |
| `joern-name-fanout` | 131,710 | Multi-candidate `callee` lists (one `.toString()` row links a 131KB candidate string) — candidate enumeration, not resolution; python's "speculative typed-attribute fan-out". Informational: 5,151 of these have ≥1 candidate covered by our graph |
| `external` | 173,092 | Callee homes outside the project — outside the internal gate; we carry these as phantom edges with id-homed external nodes |
| `notin` / fabricated stubs | 61,883 | Parameters-as-callees (`next()` → fabricated `::program:next`), decorator-value targets (`@User(...)` where `User = createParamDecorator(...)`), import-stubs — targets that do not exist in source as callables (python's identical families) |
| `odd-chain` / `lambda-unmapped` | 5,455 / 1,842 | Their fullName grammar edge cases and lambdas our line-matcher cannot uniquely map — mapping losses, counted, not silently dropped |
| `joern-this-misresolution` (covered, listed) | 1,469 | Their single "resolution" names a same-file free function while the receiver in source is `this.` — we hold the typed method edge (e.g. `setZoomLevel → WindowManager.getZoomLevel` vs their `→ browser.getZoomLevel`) |
| `joern-name-misresolution` (covered, listed) | 338 | Same shape across files — they name-linked `ActionBar.dispose` where the call is the imported free `dispose` from lifecycle.ts; we hold the typed import edge |
| `joern-unresolved` | 72 | `<unknownFullName>`, no linked callee — their unresolved set |

## The audited residual (189, classified)

| Family | ≈count | Nature |
| --- | --- | --- |
| Residual Promise-executor shadows | ~13 | Deeper lambda callers whose parameter tables Joern itself under-reports — same fabrication family as the 21 their tables DO prove |
| **Static/instance same-name collision** | 11 | `Range.isEmpty` (instance) calls `Range.isEmpty` (static): the signature grammar cannot mark static, both collapse to ONE signature — the pair is unrepresentable and the collision gate flags it. A REAL schema-grammar limitation surfaced by this audit → design-mode follow-up |
| Closure-local callables through deep value flow | ~55 | Functions escaping via event emitters/registries beyond T4/T4a/T4b/T4c's bounded hops (settingsTree `onChange`, event utilities, `registerAction` registries) — python zeroed its analog only with whole-program propagation (#150), the staged next step |
| Accessor/duck-typed and misc tails | ~56 | Getter-vs-method naming (`EventMultiplexer.event`), interface duck-typing (`ISearchTreeFolderMatch.id`), terminalTaskSystem/resources dynamic patterns |

## Known non-goals (recorded, deliberate)

- Whole-program propagation for escaped closure-locals (python #150's tier) — staged follow-up,
  not this issue.
- Static/instance signature discrimination — schema id-grammar change, design mode.
- Property-arrow class members as tree callables — future schema work; T5's bounded CHA covers
  the call sites meanwhile.
