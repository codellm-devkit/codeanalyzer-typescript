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
| Express / Koa / Fastify | `app.get('/p', handler)` — a CALL, not a decorator | **call-site** |
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

- **Decorators are structured and checker-resolved** (#143, shipped in v1.2.0). `TSDecorator`
  carries `qualified_name`, the direct analog of the Jedi definition path python matches on, plus
  `positional_arguments` and `keyword_arguments` — which is exactly what `route: {from: positional,
  index: 0}` and `methods: {from: keyword, ...}` need. NestJS and Angular fall straight out.
- **Heritage is resolved** — `extends_ids`/`implements_ids` are `can://` ids, so python's
  `transitive: true` base matching is a graph walk here rather than a name match.
- **The framework gate has two ready sources** — `TSImport` per module and `TSDependency` from the
  artifact layer (which already records `provides_imports`, and `direct` to distinguish declared
  dependencies from lockfile transitives). Python had to parse manifests by regex; TypeScript does
  not.

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

1. Schema + Neo4j projection + the level-free post-pass skeleton, emitting an empty report. Lands
   the contract; provably additive.
2. Stage-0 framework gate over `TSImport` ∪ `TSDependency`, with the report's
   `frameworks_detected`.
3. Rules file format + loader + `--entrypoint-rules`, with the decorator matcher. Ships NestJS and
   Angular, which is the majority of decorator-declared TypeScript entrypoints.
4. Base-class matcher over resolved heritage, with `dispatch:` and `via:`.
5. Call-site, file-convention and manifest matchers — the TypeScript-specific ones, each with its
   own confidence grading.

Units 1-3 are independently useful: a NestJS or Angular codebase gets correct, gated, reported
entrypoints without any of the TypeScript-specific matchers existing.

## Open questions

- Can `entrypoints` hang off a module (`TSModule`), or must a file-convention entrypoint resolve to
  a callable? Python's schema has no module-level entrypoints; adding them here would be a
  divergence in the shared vocabulary and should be raised with the sibling analyzers first.
- Do `confidence` values, `ruleset` spellings and the report shape become a **cross-language
  contract** written up in `canonical-schema.md`, rather than being coincidentally identical in two
  analyzers? Java will need the same vocabulary for Spring.
- Should the shipped rules file be a release asset (like `schema.json` already is), so consumers can
  diff which frameworks a given analyzer version covers?
