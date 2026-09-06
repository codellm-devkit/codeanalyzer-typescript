# Entrypoint detection for TypeScript (python parity)

Status: proposed. Reframes [#72](https://github.com/codellm-devkit/codeanalyzer-typescript/issues/72),
which is scoped too narrowly (see "Why #72 needs reframing").

## Problem

TypeScript has **no entrypoint detection at all**. `grep -rniE "entry_?point" src/` returns one
hit, and it is a bundler comment in `src/dataflow/pool.ts` about `bun build --compile`.

codeanalyzer-python shipped this as its #27: a `codeanalyzer/entrypoints/` package (5 files),
73 source references, `PyEntrypoint`/`PyEntrypointReport` in the schema, `is_entrypoint` and
`entrypoint_frameworks` on two Neo4j labels, and a `--entrypoint-rules` CLI flag.

Without it a consumer cannot answer "what is reachable from outside this application", which is the
first question any taint or attack-surface query asks. The analyzer emits a call graph with no
distinguished roots.

## What python built (the thing to match)

Read `codeanalyzer/entrypoints/` before implementing; the parts that matter:

- **A declarative rules file**, not hardcoded detectors — `rules.yml`, frameworks keyed by import,
  matched on decorators and base classes, with brace expansion (`{get,post,put}`) and globs
  (`rest_framework.viewsets.*`). Shipped: flask, fastapi, celery, click/typer, DRF, django.
- **A framework gate (stage 0)** — a rule family only runs if the project actually uses it, so a
  project without Celery never pays for Celery rules *and cannot false-positive on a locally
  defined `shared_task`*. A package counts as present if first-party source imports it OR the
  dependency manifest names it, since an import may be dynamic.
- **User-extensible rules** — `--entrypoint-rules <yaml>`, repeatable, merged with the shipped set,
  and each finding records `ruleset: shipped | user:<path>`.
- **Graded confidence** — `declared | certain | heuristic`, so a consumer thresholds on evidence
  quality instead of inheriting the analyzer's judgement.
- **Several entrypoints per node** — two `@app.route`s, or a function that is both a Celery task
  and a CLI command.
- **Dispatch modelling** — a routed class names the methods it dispatches to (`dispatch: [get,
  post, ...]`), and the dispatched method records `via:` the `can://` id of the routed node.
- **A coverage report** — `frameworks_detected`, `rulesets`, `unresolved`, `errors`. Its docstring
  states the reason plainly: *the pass under-approximates by design, so silence is its failure
  mode*, and the report is what makes a gap visible instead of indistinguishable from "this project
  has no entrypoints".
- **Failure isolation** — loading rules is CONFIGURATION (a malformed user file is a hard error
  before analysis starts); detection itself is best-effort and must never abort the analysis.
- **Level-free** — a post-pass over the built L1 tree, identical at every `-a`.

Every one of those properties should hold for TypeScript. They are the contract, not python
implementation detail.

## Schema (mirror python exactly)

```ts
interface TSEntrypoint {
  framework: string;
  confidence: "declared" | "certain" | "heuristic";  // default "certain"
  rule: string;        // rules file `id:`, or an engine name
  ruleset: string;     // "shipped" | "user:<path>"
  evidence?: string;
  route?: string;
  http_methods: string[];
  via?: string;        // can:// id of the routed node dispatching here
}

interface TSEntrypointReport {
  frameworks_detected: string[];
  rulesets: string[];
  unresolved: Record<string, number>;
  errors: string[];
}
```

`entrypoints: TSEntrypoint[]` and `is_entrypoint: boolean` on **`TSCallable` and `TSType`**
(python puts them on `PyCallable` and `PyClass`); `entrypoint_report` on the application root.

Neo4j: `is_entrypoint: boolean` and `entrypoint_frameworks: string[]` on `:TSCallable` and the
class-like labels, exactly as python projects them (`neo4j/project.py:720`, `:745`). Additive —
no existing property or relationship changes. `SCHEMA_VERSION` does not move (see #144: one schema
version until every analyzer re-baselines together).

## Where TypeScript diverges — the real design work

Python's rules engine has exactly **two** matchers: decorators and base classes. Those cover the
Python web/task ecosystem almost completely. They do **not** cover TypeScript's, and this is the
part that cannot be ported.

| framework | how the entrypoint is declared | matcher needed |
| --- | --- | --- |
| NestJS | `@Controller`, `@Get`, `@Post`, `@Injectable` | decorator (python has it) |
| Angular | `@Component`, `@NgModule`, route arrays | decorator (python has it) |
| Express / Koa / Fastify | `app.get('/p', handler)` — a CALL, not a decorator | **call-site** (`heuristics.calls`) |
| Next.js, Remix, SvelteKit | `pages/api/*.ts`, `app/**/route.ts`, `+server.ts` | **file convention** |
| AWS Lambda / serverless | an exported binding named `handler` | **export name** |
| CLI tools, npm packages | `bin` / `main` in package.json | **manifest** |

So TypeScript needs three matcher kinds python has no analog for: **call-site**, **file
convention**, and **manifest**. The rules file format must be designed for that from the start
rather than copied from `rules.yml` and extended later.

Two consequences worth deciding explicitly:

1. **A file-convention entrypoint has no decorator and often no distinguished callable** — the
   module's default export *is* the entrypoint. Decide whether `entrypoints` can hang off a module,
   or whether the convention resolves to the exported callable. Python never faced this.
2. **Call-site matching needs the callee resolved**, which is L2 information, while entrypoints are
   specified as a level-free L1 post-pass. Either the Express family is gated to `-a >= 2` (which
   breaks "identical at every `-a`"), or it matches syntactically on the receiver's written
   spelling at L1 with `confidence: heuristic`. **Recommendation: the latter** — it keeps the pass
   level-free, and the confidence grading exists precisely to carry this kind of weaker evidence.

## What TypeScript already has going for it

Better positioned than python was at the same point:

- **Decorators are structured** (#143, shipped in v1.2.0): `TSDecorator` carries
  `positional_arguments` and `keyword_arguments`, which is exactly what `route: {from: positional,
  index: 0}` and `methods: {from: keyword, ...}` consume. **But they are not resolved** — see
  "Correction: `qualified_name` is syntactic" below. An earlier draft of this spec, and the #143
  PR description, called `qualified_name` the analog of the Jedi definition path. That was wrong.
- **Heritage is resolved** — `extends_ids`/`implements_ids` are `can://` ids, so python's
  `transitive: true` base matching is a graph walk here rather than a name match.
- **The framework gate has two ready sources** — `TSImport` per module and `TSDependency` from the
  artifact layer (which already records `provides_imports`, and `direct` to distinguish declared
  dependencies from lockfile transitives). Python had to parse manifests by regex; TypeScript does
  not.

## Python 1.4.1 delta, and what it means here

codeanalyzer-python 1.4.1 (#182, #185; design in its #177) changed the entrypoint pass in four
ways. Each is propagated below, and one of them exposed a defect in the TypeScript decorator
capture that has to be fixed first.

### Correction: `qualified_name` is syntactic

`TSDecorator.qualified_name` is documented as "checker-resolved FQN when available". It is not.
It is ts-morph's `Decorator.getFullName()` — the **written expression text** — and the builder
never consults the checker (`src/syntactic_analysis/builders.ts:178`). Measured:

| decorator as written | `qualified_name` emitted | resolution possible? |
| --- | --- | --- |
| `@Controller` from `@nestjs/common`, `--no-build` | `Controller` | no (not installed) |
| `@http.route` via `import * as http` | `http.route` | no |
| `@HttpGet` via `import { Get as HttpGet } from "./decorators"` | `HttpGet` | **yes, trivially** |

The last row is decisive: even when the checker could resolve it, the field is the alias as
typed. So TypeScript has no decorator resolution at all, and `qualified_name` is a second copy of
`name` with dots.

Two consequences. For entrypoints, every decorator match would be heuristic-grade regardless of
what a rule claims. For #143, the Neo4j `:TSDecorator` node merges on `qualified_name || name`, so a
project's local `@Get` and NestJS's `@Get` collapse into **one** node today.

**Fix (its own PR, ahead of the decorator matcher):** `qualified_name` becomes the import-table
resolution when the decorator's head is an imported binding, and is **absent** otherwise —
python's exact rule, "Jedi, else the import table, else `None`", minus the Jedi step TypeScript
does not have. The written spelling stays in `name`. This is a `fix`, not a breaking change — the
field was documented as resolved and never was — but it changes emitted values, so it ships alone
and says so.

### The import-table resolver

Derived from `TSImport` (`module`, `name`, `alias`, `import_kind`), per module:

| import | written | resolves to |
| --- | --- | --- |
| `import { Get } from "@nestjs/common"` | `Get` | `@nestjs/common.Get` |
| `import { Get as HttpGet } from "@nestjs/common"` | `HttpGet` | `@nestjs/common.Get` |
| `import * as http from "some-lib"` | `http.route` | `some-lib.route` |
| `import express from "express"` | `express.Router` | `express.default.Router` |

Package specifiers are kept verbatim — that is the spelling a rule names. Relative specifiers stay
relative; a rule for an in-project decorator is a user rule and can name the relative path.

In python this resolver is the *fallback* behind Jedi (every `--no-venv` run). In TypeScript it is
the **primary** mechanism: there is no checker path to fall back from, and building one is out of
scope — the import table already answers the question framework rules ask.

### The heuristic tier

Python added a top-level `heuristics:` block: framework-independent decorator rules matched on the
**written** spelling, no resolution, that run on every node regardless of `frameworks_detected`,
carry `confidence: heuristic` (forced by the loader), run **last**, and never add a record to a
node a framework rule already claimed. Its two shipped rules:

```yaml
heuristics:
  decorators:
    - id: heuristic.http-route
      match: "{route,*.route,*.*.route}"
      route: {from: positional, index: 0}
      methods: {from: keyword, name: methods}
    - id: heuristic.http-verb
      match: "{*,*.*}.{get,post,put,patch,delete,head,options,websocket}"
      route: {from: positional, index: 0}
      methods: {from: match_suffix}
```

This is the same mechanism the earlier draft of this spec arrived at independently for the
call-site matcher ("a syntactic L1 match at `confidence: heuristic`"). Python only needed it for
decorators. Express is a call, so TypeScript needs it for calls too. **Decision: one block, one set
of semantics, two matcher kinds.**

```yaml
heuristics:
  decorators: [...]   # python's two rules, verbatim
  calls:
    - id: heuristic.http-verb-call
      match: "{*,*.*}.{get,post,put,patch,delete,all,use}"
      route: {from: positional, index: 0}
      methods: {from: match_suffix}
      handler: {from: positional, index: last}   # the callable the request reaches
```

A `calls:` rule matches a call expression's callee as written (`app.get`, `router.post`). The
entrypoint record attaches to the **handler** callable — the thing invoked from outside — which
since #92 is a first-class node even when it is an inline arrow. `evidence` is the callee spelling;
`via` is the id of the module-scope call node, since that is what dispatches here. `use` is
included deliberately: middleware is reachable from outside just as a route is, and a consumer
that wants only routes filters on `http_methods`.

`calls:` is a cross-language vocabulary change. Python's loader rejects unknown keys by design
("fails loudly instead of loading clean and doing nothing", `rules.py:22`), so a shared rules file
with `calls:` is a hard error there until python accepts it as known-but-unused. Tracked in a
python issue (see "Cross-repo").

### The unresolved counter

Python's report now counts every decorator and base-class spelling that neither the resolver nor
the import table can name, excluding what is nameable without either: a builtin, a class declared
in the module, or a name whose head is an imported binding. It is "the counter that makes silence
visible; it was never written before" (`pipeline.py`).

Ported with one substitution: JS globals in place of python builtins — a fixed list (`Object`,
`Error`, `Promise`, `Array`, `Map`, `Set`, `Function`, `Symbol`, `Date`, `RegExp`, and the
`*Error` family), not `globalThis` at analysis time. Subscripts and generics are stripped before the
check, as python strips `Generic[T]`. Reported as `unresolved: { "<spelling>": n }`.

### Report to Neo4j

Python projects the report onto its Application node as `entrypoint_frameworks: string[]` and
`entrypoint_report_json: string` (sorted-key JSON, since Neo4j has no map type). Mirror exactly, on
`:TSApplication`. Additive; `SCHEMA_VERSION` unmoved.

### Not propagated

- **odoo** rules — no TypeScript counterpart.
- **`route` may be a list** (odoo's `@http.route(["/a", "/b"])`) — the first string wins. Harmless
  to support; not a shipped TypeScript rule needs it, so it is loader behaviour, not a design point.

### Cross-repo

One python issue: accept `heuristics.calls` in `rules.py`'s loader as a known key that python does
not act on, so one rules file loads in both analyzers. Filed alongside this amendment.

## Why #72 needs reframing

#72 is titled "entrypoint finders (Express/Angular routes)". That is two frameworks and no engine.
Building it as written would produce hardcoded detectors, no rules file, no confidence grading, no
coverage report, no user extensibility — and would then have to be rewritten to reach parity.

The unit of work is a **rules engine plus a shipped ruleset**, matching python's shape. Retitle #72
or close it in favour of a new issue.

## Caveats and known risks

- **Under-approximation is the designed failure mode, and it is invisible without the report.** Ship
  `TSEntrypointReport` in the same change as detection, never after. A framework the ruleset misses
  looks identical to a project with no entrypoints.
- **False positives are worse than misses here.** A locally defined `Controller` decorator in a
  project that does not use NestJS must not register. The stage-0 gate is what prevents it, so it is
  not optional and it is not an optimisation.
- **The call-site matcher is the weakest link** and should ship at `confidence: heuristic`. Express
  handlers are frequently registered through a variable (`const r = express.Router()`) or a helper,
  and a syntactic match will miss those. Say so in the report's `unresolved` counts.
- **File-convention rules are framework-version-sensitive** — Next.js moved from `pages/api` to
  `app/**/route.ts` between major versions. Rules must be able to express both without a code
  change, or the ruleset rots.
- **Not validated against a labelled corpus.** Python's ruleset was tuned against real projects;
  TypeScript's will need the same, and "it found some entrypoints on vscode" is not that.

## Decomposition (proposed — needs sign-off)

Tracking follows PR granularity; file each just-in-time.

0. **Fix `qualified_name`** — import-table resolution or absent. Its own PR, first: it changes
   emitted values and corrects #143's node-merge collapse, independently of entrypoints.
1. Schema + Neo4j projection (including the report on `:TSApplication`) + the level-free post-pass
   skeleton, emitting an empty report. Lands the contract; provably additive.
2. Stage-0 framework gate over `TSImport` ∪ `TSDependency`, with the report's
   `frameworks_detected`, and the unresolved counter.
3. Rules file format + loader + `--entrypoint-rules`, with the decorator matcher AND the
   `heuristics:` block (`decorators:` + `calls:`). Ships NestJS, Angular, and heuristic Express in
   one unit, because the heuristic tier is the same loader and the same match engine.
4. Base-class matcher over resolved heritage, with `dispatch:` and `via:`.
5. File-convention and manifest matchers — the remaining TypeScript-specific ones.

Units 0-3 are independently useful: a NestJS, Angular or Express codebase gets correct, gated,
reported entrypoints without file-convention or manifest matching existing.

## Open questions (as written at design time)

- Can `entrypoints` hang off a module (`TSModule`), or must a file-convention entrypoint resolve to
  a callable? Python's schema has no module-level entrypoints; adding them here would be a
  divergence in the shared vocabulary and should be raised with the sibling analyzers first.
- Do `confidence` values, `ruleset` spellings and the report shape become a **cross-language
  contract** written up in `canonical-schema.md`, rather than being coincidentally identical in two
  analyzers? Java will need the same vocabulary for Spring.
- Should the shipped rules file be a release asset (like `schema.json` already is), so consumers can
  diff which frameworks a given analyzer version covers?

## Decisions taken during implementation (units 2–5)

The open questions above were decided while building the units. Recorded here so the spec stays the
authority; the code and tests pin each one.

- **File-convention entrypoints attach to callables, never to a module.** `entrypoints` was NOT added
  to `TSModule`, so the shared vocabulary is untouched: a Next.js `route.ts` records on its exported
  `GET`/`POST` callables (matched on `is_exported` + `name`; a default export is detected from the
  declaration's source text, since `TSModule.exports` records only `export { }` and re-exports).
- **Manifest entrypoints (`package.json` `main`/`bin`) attach to the free functions the entry module
  calls at top level**, with `confidence: declared`, `evidence: package.json#<field>`, and `via` = the
  module id. "What runs when this file is executed" is its top-level calls; a path that resolves to no
  module, or a module with no such call, is counted in `unresolved` under `package.json#<field>:<path>`.
  Python has no analog, so no shared field was added for this.
- **Module-scope call sites are captured INTERNAL on `TSModule.call_sites`** (stripped from the wire in
  `emit.ts`; kept in the cache, because a warm run reuses cached modules verbatim and the calls tier
  must survive it). The `calls:` tier scans module-owned and callable-owned sites, each exactly once.
- **`via` for a callable-owned call site** is the owning callable's body-node id via `callBodyKeys`
  (so chained calls sharing a start position stay distinct); **for a module-owned site** it is
  `${mod.id}@L:C` — a well-formed ordinal id that names no wire node today, because modules have no
  `body{}`. Accepted as a locator; a later change may give modules a body.
- **The rules format has one `heuristics:` block with `decorators:` and `calls:`.** Same semantics
  for both (written spelling, every node, `heuristic` forced, runs last, never doubles). This is a
  cross-language vocabulary addition; python #187 tracks accepting `calls` as a known key.
- **`http_methods` never carries a non-HTTP token.** The verb set is python's seven dispatch verbs and
  `match_suffix` is filtered by it — deliberately stricter than python, whose suffix branch is
  unfiltered. So `app.use`, `app.all` and `@ws.websocket` yield `[]`. **Still open:** whether `app.all`
  (a route matching every method) should carry something; until decided, match on `evidence`/`rule`.
- **`TSDecorator.qualified_name` is the import-table resolution or absent** (#152), and the resolver
  is the primary mechanism, not a fallback — there is no checker tier.
- **Base-class resolution is per owning module**: during a transitive walk, an ancestor's written
  base is resolved through the ancestor's own import table, not the leaf class's.
- **The plan's "call_sites must never reach the cache" was wrong** and was not followed; see above.
- **The manifest matcher's disk fallback is exercised end-to-end with `--no-artifact-text`** (`artifactText:
  false`), not with `--no-repo-sections` as the plan first said: that flag lives on an unmerged branch, and
  `--no-artifact-text` produces the exact shape (`source: ""`) the fallback must handle. A missing
  `pages/api` default export is COUNTED under `<fileKey>#default`, never silent.
