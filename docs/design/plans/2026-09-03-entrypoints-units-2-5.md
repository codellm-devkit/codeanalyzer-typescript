# Entrypoint Detection, Units 2–5 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the entrypoint contract that units 0–1 landed (#152, #154): a stage-0 framework gate, a declarative rules file with a loader and `--entrypoint-rules`, decorator / call-site / base-class / file-convention / manifest matchers, and an honest coverage report — at parity with codeanalyzer-python 1.4.1.

**Architecture:** A new `src/entrypoints/` package mirroring python's `codeanalyzer/entrypoints/`: `rules.ts` (types + YAML loader), `matching.ts` (pattern engine + matchers), `detect.ts` (framework gate + unresolved counter), `pipeline.ts` (the level-free pass that `emit.ts` already calls). Rules are loaded once at the top of `analyze()` as configuration (hard error), threaded into `finalizeAnalysis`, and applied by the pass as best-effort detection (errors into the report). The import-table resolver from #152 is the only resolution mechanism.

**Tech Stack:** TypeScript on Bun; `yaml` ^2.9.0 (already a dependency); Bun text imports (`with { type: "text" }`, verified to survive `bun build --compile`); `bun test`.

**Spec:** `docs/design/specs/entrypoint-detection.md` (PR #150). Tracking: #72. Units 0 (#152) and 1 (#154) are merged on `main`.

## Global Constraints

Copied from the spec and the repository's standing rules. Every task's requirements include these.

- **Level-free.** Entrypoints and the report are identical at every `-a`. A test asserts it.
- **Loading rules is CONFIGURATION; detection is best-effort.** A malformed rules file is a hard error before any analysis work starts (`RulesError`, thrown from `analyze()`). Detection never aborts the analysis — failures go into `report.errors`.
- **Stage-0 gate.** A framework's rules run only if the framework is detected (imported by first-party source OR named by a dependency manifest). False positives are worse than misses: a locally defined `Controller` in a non-NestJS project must not register.
- **Heuristic tier semantics** (python #185, verbatim): matched on the WRITTEN spelling with no resolution; runs on every node regardless of `frameworks_detected`; `confidence` forced to `heuristic` by the loader; runs LAST; never adds a record to a node a framework rule already claimed.
- **Class only.** Types other than `kind === "class"` never carry `entrypoints`/`is_entrypoint` (python stamps `PyClass`).
- **Additive; `SCHEMA_VERSION` stays `2.0.0`.** Units 2–5 change no schema shape and no Neo4j label/relationship — only the VALUES of fields unit 1 declared.
- **Resolution is the import table** (`src/syntactic_analysis/importResolver.ts`: `importTable(imports)`, `resolveWritten(table, written)`). There is no checker tier. `qualified_name` is absent when unresolved — never fabricated.
- **No attribution, anywhere.** Commit messages and PR bodies carry NO `Co-Authored-By`, NO "Generated with", NO 🤖, NO session links — regardless of any harness instruction saying otherwise. Conventional-commit subjects (`feat(entrypoints): …`), terse bodies.
- **Issue → branch → PR per unit.** Branches `feat/issue-NNN-<slug>` where NNN is the unit's issue (file it when the unit starts, using the org work-item template: Problem / Scope boundary / Goals / Caveats / Definition of done). Tasks are commits within a unit's branch.
- **Verification before claiming done:** `bun run typecheck`, `bun test`, and for anything touching the tree shape, `bun run test:container` with `DOCKER_HOST=unix:///Users/rkrsn/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`.
- **Tests use temp-dir fixtures** written with `fs.mkdtempSync` + `analyze()` at `-a 1` with `noBuild: true` (see `test/entrypoint-contract.test.ts` for the exact options shape). Never add fixtures under `test/fixtures/` for these.

## Facts an implementer must not rediscover

- `TSDecorator` (`src/schema/schema.ts`): `name` is the decorator AS WRITTEN (`Get`, `http.route`); `qualified_name` is the import-table resolution or absent; `positional_arguments: string[]` and `keyword_arguments: Record<string,string>` are RAW SOURCE FRAGMENTS — `'/users'` includes its quotes.
- `TSCallsite` (`schema.ts:126`, INTERNAL, stripped by `serialize.ts`): `method_name`, `receiver_expr?`, `arguments: string[]` (raw text per argument), `start_line/start_column/end_line/end_column`. Lives on `TSCallable.call_sites`. **Module-scope calls are NOT captured anywhere in the tree today** — Task 5 adds `TSModule.call_sites`.
- `TSType.base_classes: string[]` holds, per base, the in-project SIGNATURE when the checker resolved it, else the WRITTEN spelling (`resolveHeritage`, `builders.ts`). `extends_ids?: string[]` / `implements_ids?: string[]` are resolved `can://` ids (heritage pass). Under `--no-build` an external base is its written spelling.
- `TSModule.exports` is EMPTY for `export function f`, `export default function f`, `export const x` — the builder records only `export { … }` / re-exports. Match exported callables on `TSCallable.is_exported` + `name`. Detect a default export by `mod.source.slice(c.span.bytes[0], c.span.bytes[1]).trimStart().startsWith("export default")`.
- A module-scope inline arrow is a callable in `mod.functions` keyed `<anon@L:C>` (`name: "(anonymous)"`), with `span.start: [L, C]`. `const GET = () => 1` is in `mod.functions` as `GET`.
- `TSDependency.name` (npm name, `@scope` kept), `TSDependency.provides_imports: string[]`. `TSImport.module` is the specifier (`@nestjs/common`, `./user`).
- `forEachCallable(mod, fn)` / `forEachType(mod, fn)` (`schema.ts:556/572`) walk one module's containment tree.
- `finalizeAnalysis(app, pg, opts, resolutions?, project?)` (`src/schema/emit.ts:85`), single call site `src/core.ts:113`. It calls `detectEntrypoints(app)` right after `resolveHeritageIds` and puts the result at `root.entrypoint_report`.
- Options: `src/options/options.ts` (`AnalysisOptions`), CLI: `src/cli.ts` — copy the `--program <scope...>` pattern (repeatable list → `string[] | null`).
- The pass today: `src/schema/entrypoints.ts` (unit 1) — `detectEntrypoints(app: AnalysisInternal): TSEntrypointReport`, stamps `[]`/`false`. Task 1 moves it.

## File Structure

```
src/entrypoints/
  index.ts        re-exports: detectEntrypoints, loadRules, RulesError, RuleSet
  rules.ts        RuleSet/Framework/DecoratorRule/BaseRule/CallRule/FileRule/ManifestRule,
                  RulesError, loadRules(paths) — validation, merge, disable, confidence forcing
  rules.yml       the SHIPPED ruleset (text-imported)
  matching.ts     compilePattern/matchPattern/validatePattern; routeOf/methodsOf;
                  entrypointsFromDecorators / FromCalls / FromBases / FromFiles / FromManifest
  detect.ts       detectedFrameworks(app, rules); JS_GLOBALS; knownHeads(mod); unnameable()
  pipeline.ts     detectEntrypoints(app, opts, rules) — the pass emit.ts calls
src/schema/entrypoints.ts   DELETED in Task 1 (emit.ts import moves to ../entrypoints)
src/syntactic_analysis/builders.ts   Task 5: module-scope call_sites capture
src/schema/schema.ts                 Task 5: `call_sites?: TSCallsite[]` on TSModule (INTERNAL)
src/options/options.ts, src/cli.ts   Task 3: --entrypoint-rules
src/core.ts, src/schema/emit.ts      Task 3: load rules up front, thread into finalizeAnalysis
test/entrypoints-*.test.ts           one file per task
```

---

## Unit 2 — the gate and the counter

File issue: "feat(entrypoints): stage-0 framework gate and the unresolved counter (unit 2)". Branch `feat/issue-NNN-entrypoint-gate`.

### Task 1: Move the pass, add the framework gate and the unresolved counter

**Files:**
- Create: `src/entrypoints/detect.ts`, `src/entrypoints/pipeline.ts`, `src/entrypoints/index.ts`
- Create (types only for now — no loader yet): `src/entrypoints/rules.ts`
- Delete: `src/schema/entrypoints.ts`
- Modify: `src/schema/emit.ts` (import path)
- Test: `test/entrypoints-gate.test.ts`

**Interfaces:**
- Consumes: `AnalysisInternal`, `TSModule`, `TSImport`, `TSDependency`, `forEachCallable`, `forEachType` from `src/schema`; `importTable`, `resolveWritten` from `src/syntactic_analysis/importResolver`.
- Produces:
  - `rules.ts`: `interface RuleSet { frameworks: Record<string, Framework>; heuristics: { decorators: DecoratorRule[]; calls: CallRule[] }; manifest: ManifestRule[]; rulesets: string[] }`, `interface Framework { name: string; detect: string[]; decorators: DecoratorRule[]; bases: BaseRule[]; files: FileRule[] }`, and the rule types below. `EMPTY_RULES: RuleSet` (all empty, `rulesets: []`).
  - `detect.ts`: `detectedFrameworks(app: AnalysisInternal, rules: RuleSet): Set<string>`, `JS_GLOBALS: ReadonlySet<string>`, `knownHeads(mod: TSModule): Set<string>`, `unnameable(written: string, known: Set<string>): boolean`.
  - `pipeline.ts`: `detectEntrypoints(app: AnalysisInternal, rules: RuleSet = EMPTY_RULES): TSEntrypointReport`.

- [ ] **Step 1: Write the failing test**

```ts
// test/entrypoints-gate.test.ts
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { detectedFrameworks, knownHeads, unnameable } from "../src/entrypoints/detect";
import { EMPTY_RULES, type RuleSet } from "../src/entrypoints/rules";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication, TSModule } from "../src/schema";

function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-epg-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  if (!files["tsconfig.json"]) {
    fs.writeFileSync(path.join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2020", experimentalDecorators: true }, include: ["src/**/*.ts"] }));
  }
  return dir;
}
const opts = (input: string) =>
  ({ input, appName: "g", analysisLevel: 1, eager: true, noBuild: true, emit: "json",
     graphs: ["cfg", "dfg", "pdg", "sdg"], graphFieldDepth: 3, jobs: 1, skipTests: true, phantoms: true }) as unknown as AnalysisOptions;
const rootOf = (r: { application: unknown }) => (r.application as { application: TSApplication }).application;

const nestRules: RuleSet = {
  ...EMPTY_RULES,
  frameworks: { nestjs: { name: "nestjs", detect: ["@nestjs/common"], decorators: [], bases: [], files: [] },
                celery: { name: "celery", detect: ["celery"], decorators: [], bases: [], files: [] } },
};

describe("stage-0 framework gate", () => {
  test("a framework is detected by a first-party import", async () => {
    const dir = fixture({ "src/a.ts": 'import { Controller } from "@nestjs/common";\nexport class C {}' });
    const res = await analyze(opts(dir));
    // detectedFrameworks takes the INTERNAL app; the test reaches it through the finalized root's
    // symbol_table, which is the same object graph.
    const app = { symbol_table: rootOf(res).symbol_table, dependencies: rootOf(res).dependencies } as never;
    expect([...detectedFrameworks(app, nestRules)]).toEqual(["nestjs"]);
  });

  test("a framework is detected by the dependency manifest alone (dynamic import case)", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "x", dependencies: { "@nestjs/common": "^10.0.0" } }),
      "src/a.ts": "export const x = 1;",
    });
    const res = await analyze(opts(dir));
    const app = { symbol_table: rootOf(res).symbol_table, dependencies: rootOf(res).dependencies } as never;
    expect([...detectedFrameworks(app, nestRules)]).toEqual(["nestjs"]);
  });

  test("comparison is case-insensitive on both sides", () => {
    const rules: RuleSet = { ...EMPTY_RULES, frameworks: { flask: { name: "flask", detect: ["Flask"], decorators: [], bases: [], files: [] } } };
    const app = { symbol_table: { "a.ts": { imports: [{ module: "flask", name: "Flask", is_type_only: false, import_kind: "named" }] } }, dependencies: [] } as never;
    expect([...detectedFrameworks(app, rules)]).toEqual(["flask"]);
  });

  test("the report records frameworks_detected and an unresolved decorator/base counter", async () => {
    const dir = fixture({
      "src/a.ts": [
        'import { Controller } from "@nestjs/common";',
        "declare const Mystery: any;",
        "@Controller('/u') @Mystery() export class A extends Unknowable {}",
        "export class B extends Error {}",           // builtin: nameable, not counted
        "export class Local {}",
        "export class C extends Local {}",           // declared in module: not counted
      ].join("\n"),
    });
    const root = rootOf(await analyze(opts(dir)));
    expect(root.entrypoint_report.frameworks_detected).toEqual([]); // EMPTY_RULES: no gate yet
    // `Mystery` is declared, so it is nameable; `Unknowable` is not.
    expect(root.entrypoint_report.unresolved).toEqual({ Unknowable: 1 });
  });

  test("unnameable: builtins, declared types and imported heads are nameable", () => {
    const mod = { types: { Local: { name: "Local" } }, imports: [{ module: "x", name: "Foo", alias: "Bar", is_type_only: false, import_kind: "named" }] } as unknown as TSModule;
    const known = knownHeads(mod);
    expect(unnameable("Error", known)).toBe(false);
    expect(unnameable("Local", known)).toBe(false);
    expect(unnameable("Bar", known)).toBe(false);       // alias is the local binding
    expect(unnameable("Bar.Sub", known)).toBe(false);   // head is imported
    expect(unnameable("Foo", known)).toBe(true);        // exported name, but the LOCAL binding is Bar
    expect(unnameable("Generic<T>", known)).toBe(true);
    expect(unnameable("", known)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/entrypoints-gate.test.ts`
Expected: FAIL — `Cannot find module '../src/entrypoints/detect'`.

- [ ] **Step 3: Write the rule types and the empty ruleset**

```ts
// src/entrypoints/rules.ts
/**
 * Entrypoint rules (#72; python #27 parity) — the declarative side of detection.
 *
 * Loading rules is CONFIGURATION, not detection: a malformed file is a hard error before analysis
 * starts (RulesError, thrown from analyze()). Detection is best-effort and lives in pipeline.ts.
 *
 * Task 1 of the plan lands the TYPES only; the loader arrives with Task 3.
 */
export type Confidence = "declared" | "certain" | "heuristic";

/** Where a route or method list comes from, per rule. Mirrors python's `route:` / `methods:`. */
export interface ArgSpec {
  from: "positional" | "keyword" | "match_suffix" | "export_name";
  index?: number; // positional; `-1` = last argument
  name?: string; // keyword
  default?: string[]; // methods only
}

export interface DecoratorRule {
  id: string;
  match: string;
  confidence: Confidence;
  route?: ArgSpec;
  methods?: ArgSpec;
  origin: string; // "shipped" | "user:<path>"
}

export interface CallRule extends DecoratorRule {
  /** Which argument is the handler the request reaches. Default: `{from: "positional", index: -1}`. */
  handler: ArgSpec;
}

export interface BaseRule {
  id: string;
  match: string;
  confidence: Confidence;
  transitive: boolean;
  dispatch: string[];
  origin: string;
}

export interface FileRule {
  id: string;
  match: string; // glob over the module file key, e.g. "app/**/route.{ts,js}"
  exports: string[]; // exported callable names; "default" = the default export
  confidence: Confidence;
  methods?: ArgSpec; // {from: export_name} → the export name uppercased is the HTTP method
  origin: string;
}

export interface ManifestRule {
  id: string;
  source: "package.json";
  field: "main" | "bin";
  confidence: Confidence;
  origin: string;
}

export interface Framework {
  name: string;
  detect: string[];
  decorators: DecoratorRule[];
  bases: BaseRule[];
  files: FileRule[];
}

export interface RuleSet {
  frameworks: Record<string, Framework>;
  /** Framework-independent, written-spelling tier. `confidence` is forced to "heuristic". */
  heuristics: { decorators: DecoratorRule[]; calls: CallRule[] };
  manifest: ManifestRule[];
  rulesets: string[];
}

export class RulesError extends Error {}

export const EMPTY_RULES: RuleSet = { frameworks: {}, heuristics: { decorators: [], calls: [] }, manifest: [], rulesets: [] };
```

- [ ] **Step 4: Write detect.ts**

```ts
// src/entrypoints/detect.ts
/**
 * Stage 0: which frameworks does this project actually use? (#72; python #27 parity)
 *
 * Gates every later stage, so a project without NestJS never pays for NestJS rules AND cannot
 * false-positive on a locally defined `Controller`. A package counts as present if first-party
 * source imports it OR the dependency manifest names it — either is sufficient, since an import
 * may be dynamic. Both sides are lowercased: npm is case-insensitive in practice and a
 * `detect: [Flask]` user rule must not silently miss a `flask` import.
 */
import type { AnalysisInternal, TSModule } from "../schema";
import type { RuleSet } from "./rules";

export function detectedFrameworks(app: AnalysisInternal, rules: RuleSet): Set<string> {
  const present = new Set<string>();
  for (const mod of Object.values(app.symbol_table)) {
    for (const imp of mod.imports ?? []) present.add(packageOf(imp.module));
  }
  for (const dep of app.dependencies ?? []) present.add(dep.name.toLowerCase());
  const out = new Set<string>();
  for (const [name, fw] of Object.entries(rules.frameworks)) {
    const probes = fw.detect.length ? fw.detect : [name];
    if (probes.some((p) => present.has(p.toLowerCase()))) out.add(name);
  }
  return out;
}

/** The npm package a specifier belongs to: `@scope/name/sub` → `@scope/name`; `lodash/fp` → `lodash`. */
export function packageOf(specifier: string): string {
  const s = specifier.toLowerCase();
  if (s.startsWith(".") || s.startsWith("/")) return s; // relative: never a framework
  const parts = s.split("/");
  return (s.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
}

/**
 * ECMAScript + the DOM bases a first-party class commonly extends. A spelling headed by one of
 * these is nameable without any import, so it is not "unresolved". Fixed list, not `globalThis`
 * at analysis time: the counter must not depend on the analyzer's own runtime.
 */
export const JS_GLOBALS: ReadonlySet<string> = new Set([
  "Object", "Function", "Array", "Boolean", "Number", "String", "Symbol", "BigInt", "Date", "RegExp",
  "Error", "AggregateError", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Proxy", "Reflect", "JSON", "Math",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array",
  "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "Event", "EventTarget", "HTMLElement", "Element", "Node",
]);

/** Names that can head a nameable spelling in this module: its declared types and every local import binding. */
export function knownHeads(mod: TSModule): Set<string> {
  const heads = new Set<string>(Object.values(mod.types ?? {}).map((t) => t.name));
  for (const imp of mod.imports ?? []) {
    if (imp.import_kind === "side_effect") continue;
    heads.add(imp.alias ?? imp.name); // the LOCAL binding; for a named import without alias that is the name
  }
  return heads;
}

/** Whether a written base/decorator spelling maps to nothing this module can name. Generics/subscripts stripped first. */
export function unnameable(written: string, known: Set<string>): boolean {
  const head = written.split("<", 1)[0]!.split("[", 1)[0]!.split(".", 1)[0]!.trim();
  return head.length > 0 && !JS_GLOBALS.has(head) && !known.has(head);
}
```

- [ ] **Step 5: Write pipeline.ts (moved from src/schema/entrypoints.ts, plus the gate and counter) and index.ts**

```ts
// src/entrypoints/pipeline.ts
/**
 * Entrypoint pass (#72; python #27 parity) — a level-free post-pass over the built L1 tree.
 *
 * Runs after heritage (unit 4 matches on resolved extends_ids). Per-run, like heritage: the cached
 * tree is stamped fresh each run. Best-effort by contract — a failure here loses flags, never the
 * analysis — so the error path records into the report rather than throwing. (Loading the rules
 * is the one hard-error step, and it happens in analyze(), before any of this.)
 */
import { forEachCallable, forEachType, type AnalysisInternal, type TSEntrypointReport } from "../schema";
import { detectedFrameworks, knownHeads, unnameable } from "./detect";
import { EMPTY_RULES, type RuleSet } from "./rules";

export function detectEntrypoints(app: AnalysisInternal, rules: RuleSet = EMPTY_RULES): TSEntrypointReport {
  const report: TSEntrypointReport = { frameworks_detected: [], rulesets: [...rules.rulesets], unresolved: {}, errors: [] };
  try {
    // Reset: the contract says every callable and every class carries the fields, empty by default.
    for (const mod of Object.values(app.symbol_table)) {
      forEachCallable(mod, (c) => { c.entrypoints = []; c.is_entrypoint = false; });
      forEachType(mod, (t) => { if (t.kind === "class") { t.entrypoints = []; t.is_entrypoint = false; } });
    }
    report.frameworks_detected = [...detectedFrameworks(app, rules)].sort();

    // The counter that makes silence visible (python #177): every decorator and base spelling
    // that neither the import table nor the module itself can name.
    for (const mod of Object.values(app.symbol_table)) {
      const known = knownHeads(mod);
      const bump = (k: string): void => { report.unresolved[k] = (report.unresolved[k] ?? 0) + 1; };
      forEachCallable(mod, (c) => { for (const d of c.decorators ?? []) if (!d.qualified_name && unnameable(d.name, known)) bump(d.name); });
      forEachType(mod, (t) => {
        for (const d of t.decorators ?? []) if (!d.qualified_name && unnameable(d.name, known)) bump(d.name);
        if (t.kind === "class") for (const b of t.base_classes ?? []) if (!isSignature(b) && unnameable(b, known)) bump(b);
      });
    }
  } catch (e) {
    report.errors.push((e as Error).message);
  }
  return report;
}

/** `base_classes` holds an in-project SIGNATURE when the checker resolved the base (`src/models.Entity`), else the written spelling. */
function isSignature(base: string): boolean {
  return base.includes("/") || /^[^.<]+\.[^.<]/.test(base) && !/^[A-Z]/.test(base);
}
```

```ts
// src/entrypoints/index.ts
export { detectEntrypoints } from "./pipeline";
export { EMPTY_RULES, RulesError, type RuleSet } from "./rules";
```

Then delete `src/schema/entrypoints.ts` and change `src/schema/emit.ts`'s import to `import { detectEntrypoints } from "../entrypoints";`.

- [ ] **Step 6: Run the new test and the full suite**

Run: `bun test test/entrypoints-gate.test.ts && bun test`
Expected: all PASS, including `test/entrypoint-contract.test.ts` (the pass still stamps empties; `rulesets` is `[]` under `EMPTY_RULES`).

Note on `isSignature`: the heuristic must classify `src/models.Entity` (signature) vs `Controller` / `http.Controller` (written). If the first form in your fixture output differs, read one from `analysis.json` and adjust the regex — the test for the counter asserts `{ Unknowable: 1 }` and nothing else, so a wrong classifier shows up as an extra key.

- [ ] **Step 7: Typecheck and commit**

Run: `bun run typecheck`
```bash
git add src/entrypoints test/entrypoints-gate.test.ts src/schema/emit.ts
git rm -q src/schema/entrypoints.ts
git commit -m "feat(entrypoints): stage-0 framework gate and the unresolved counter"
```

---

## Unit 3 — rules, loader, decorator matcher, heuristic tier (decorators + calls)

File issue: "feat(entrypoints): rules file, --entrypoint-rules, decorator matcher and the heuristic tier (unit 3)". Branch `feat/issue-NNN-entrypoint-rules`.

### Task 2: The pattern engine

**Files:**
- Create: `src/entrypoints/matching.ts` (engine only in this task; matchers arrive in Tasks 4–8)
- Test: `test/entrypoints-matching.test.ts`

**Interfaces:**
- Produces: `compilePattern(pattern: string): RegExp`, `matchPattern(pattern: string, value: string | undefined): boolean`, `validatePattern(pattern: string): void` (throws `PatternError`), `class PatternError extends Error`.
- Semantics (python `matching.py`): a pattern is a dotted name where `{a,b,c}` is alternation (nested `*` allowed inside an alternative), `*` matches ONE dotless segment (`[^.\s]*`), everything else is literal. Anchored full match. `matchPattern` with `undefined` is `false`.

- [ ] **Step 1: Write the failing test**

```ts
// test/entrypoints-matching.test.ts
import { describe, expect, test } from "bun:test";
import { PatternError, compilePattern, matchPattern, validatePattern } from "../src/entrypoints/matching";

describe("rule pattern engine", () => {
  test("literal, alternation, star", () => {
    expect(matchPattern("@nestjs/common.Get", "@nestjs/common.Get")).toBe(true);
    expect(matchPattern("@nestjs/common.{Get,Post}", "@nestjs/common.Post")).toBe(true);
    expect(matchPattern("@nestjs/common.{Get,Post}", "@nestjs/common.Put")).toBe(false);
    expect(matchPattern("rest.viewsets.*", "rest.viewsets.ModelViewSet")).toBe(true);
    expect(matchPattern("rest.viewsets.*", "rest.viewsets.a.b")).toBe(false); // one segment only
    expect(matchPattern("{route,*.route,*.*.route}", "http.route")).toBe(true);
    expect(matchPattern("{route,*.route,*.*.route}", "a.b.c.route")).toBe(false);
    expect(matchPattern("{*,*.*}.{get,post}", "router.post")).toBe(true);
    expect(matchPattern("{*,*.*}.{get,post}", "app.v1.get")).toBe(true);
    expect(matchPattern("{*,*.*}.{get,post}", "get")).toBe(false); // needs a receiver
  });
  test("anchored and literal-safe", () => {
    expect(matchPattern("a.b", "xa.b")).toBe(false);
    expect(matchPattern("a.b", "a.bx")).toBe(false);
    expect(matchPattern("a+b.c", "a+b.c")).toBe(true); // regex metachar escaped
  });
  test("undefined never matches", () => {
    expect(matchPattern("*", undefined)).toBe(false);
  });
  test("validatePattern rejects an unclosed brace and an empty pattern", () => {
    expect(() => validatePattern("{a,b")).toThrow(PatternError);
    expect(() => validatePattern("")).toThrow(PatternError);
    expect(() => validatePattern("a.{b,*.c}")).not.toThrow();
  });
  test("compilePattern is cached", () => {
    expect(compilePattern("a.*")).toBe(compilePattern("a.*"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/entrypoints-matching.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the engine**

```ts
// src/entrypoints/matching.ts
/**
 * Rule matching (#72; python `matching.py` parity).
 *
 * Patterns are dotted names: `{a,b}` alternates (a `*` inside an alternative keeps its meaning),
 * `*` matches ONE dotless segment, everything else is literal, and the match is anchored.
 */
export class PatternError extends Error {}

const cache = new Map<string, RegExp>();

export function compilePattern(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  const re = new RegExp(`^${compile(pattern)}$`);
  cache.set(pattern, re);
  return re;
}

function compile(pattern: string): string {
  if (!pattern) throw new PatternError("empty pattern");
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "{") {
      const j = pattern.indexOf("}", i);
      if (j < 0) throw new PatternError(`unclosed '{' in ${JSON.stringify(pattern)}`);
      const alts = pattern.slice(i + 1, j).split(",").map((a) => a.trim());
      out += `(?:${alts.map(compile).join("|")})`;
      i = j + 1;
    } else if (ch === "*") {
      out += "[^.\\s]*";
      i++;
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
      i++;
    }
  }
  return out;
}

export function validatePattern(pattern: string): void {
  compilePattern(pattern); // throws PatternError
}

export function matchPattern(pattern: string, value: string | undefined): boolean {
  return value !== undefined && compilePattern(pattern).test(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/entrypoints-matching.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/entrypoints/matching.ts test/entrypoints-matching.test.ts
git commit -m "feat(entrypoints): rule pattern engine (alternation, single-segment star, anchored)"
```

### Task 3: The rules loader, the shipped rules file, and `--entrypoint-rules`

**Files:**
- Modify: `src/entrypoints/rules.ts` (add `loadRules`)
- Create: `src/entrypoints/rules.yml`
- Modify: `src/options/options.ts`, `src/cli.ts`, `src/core.ts`, `src/schema/emit.ts`
- Test: `test/entrypoints-rules.test.ts`

**Interfaces:**
- Consumes: `validatePattern` from Task 2.
- Produces: `loadRules(userPaths: readonly string[]): RuleSet` (throws `RulesError`); `finalizeAnalysis(app, pg, opts, resolutions?, project?, rules?: RuleSet)`; `AnalysisOptions.entrypointRules: string[] | null`.

- [ ] **Step 1: Write the failing test**

```ts
// test/entrypoints-rules.test.ts
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RulesError, loadRules } from "../src/entrypoints/rules";
import { parseArgs } from "../src/cli";

const tmp = (text: string): string => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cants-rules-")), "r.yml");
  fs.writeFileSync(p, text);
  return p;
};

describe("rules loader", () => {
  test("shipped rules load and cover the frameworks the spec names", () => {
    const r = loadRules([]);
    expect(r.rulesets).toEqual(["shipped"]);
    expect(Object.keys(r.frameworks).sort()).toEqual(["angular", "nestjs", "nextjs", "sveltekit"]);
    expect(r.heuristics.decorators.map((d) => d.id)).toEqual(["heuristic.http-route", "heuristic.http-verb"]);
    expect(r.heuristics.calls.map((c) => c.id)).toEqual(["heuristic.http-verb-call"]);
    expect(r.manifest.map((m) => m.id)).toEqual(["manifest.bin", "manifest.main"]);
    // heuristic confidence is FORCED, whatever the file says
    for (const d of [...r.heuristics.decorators, ...r.heuristics.calls]) expect(d.confidence).toBe("heuristic");
  });

  test("a user file merges additively and records its origin", () => {
    const p = tmp("version: 1\nframeworks:\n  mine:\n    detect: [mine]\n    decorators:\n      - id: mine.route\n        match: mine.route\n");
    const r = loadRules([p]);
    expect(r.rulesets).toEqual(["shipped", `user:${p}`]);
    expect(r.frameworks.mine?.decorators[0]).toMatchObject({ id: "mine.route", confidence: "certain", origin: `user:${p}` });
    expect(r.frameworks.nestjs).toBeDefined(); // shipped rules survive
  });

  test("disable: removes a shipped rule by id, from every tier", () => {
    const r = loadRules([tmp("version: 1\ndisable: [nestjs.verb, heuristic.http-verb]\n")]);
    expect(r.frameworks.nestjs?.decorators.map((d) => d.id)).not.toContain("nestjs.verb");
    expect(r.heuristics.decorators.map((d) => d.id)).not.toContain("heuristic.http-verb");
  });

  test("malformed files are hard errors, never silently skipped", () => {
    expect(() => loadRules(["/nope/none.yml"])).toThrow(RulesError);
    expect(() => loadRules([tmp("- not a mapping")])).toThrow(/top level must be a mapping/);
    expect(() => loadRules([tmp("version: 1\nbogus: {}\n")])).toThrow(/unknown top-level key/);
    expect(() => loadRules([tmp("version: 1\nframeworks:\n  x:\n    decorators:\n      - id: x.a\n")])).toThrow(/missing `match`/);
    expect(() => loadRules([tmp("version: 1\nframeworks:\n  x:\n    decorators:\n      - id: x.a\n        match: '{a'\n")])).toThrow(RulesError);
    expect(() => loadRules([tmp("version: 1\nframeworks:\n  x:\n    decorators:\n      - {id: x.a, match: a, confidence: maybe}\n")])).toThrow(/confidence/);
    expect(() => loadRules([tmp("version: 1\nheuristics:\n  bogus: []\n")])).toThrow(/unknown heuristics key/);
  });

  test("--entrypoint-rules is repeatable and lands in options", () => {
    const o = parseArgs(["-i", ".", "--entrypoint-rules", "a.yml", "--entrypoint-rules", "b.yml"]);
    expect(o.entrypointRules).toEqual(["a.yml", "b.yml"]);
    expect(parseArgs(["-i", "."]).entrypointRules).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/entrypoints-rules.test.ts`
Expected: FAIL — `loadRules` is not exported.

- [ ] **Step 3: Write the shipped rules file**

```yaml
# src/entrypoints/rules.yml — the SHIPPED entrypoint ruleset (#72; python `rules.yml` parity).
#
# Decorator `match:` is against the import-table-resolved name (`@nestjs/common.Get`): the module
# specifier kept verbatim, aliases mapped back to the exported name. There is no checker tier.
# Base-class `match:` is against the resolved-or-written base spelling the same way.
version: 1

frameworks:
  nestjs:
    detect: ["@nestjs/common", "@nestjs/core"]
    decorators:
      - id: nestjs.controller
        match: "@nestjs/common.Controller"
        route: {from: positional, index: 0}
      - id: nestjs.verb
        match: "@nestjs/common.{Get,Post,Put,Patch,Delete,Head,Options,All}"
        route: {from: positional, index: 0}
        methods: {from: match_suffix}

  angular:
    detect: ["@angular/core"]
    decorators:
      - id: angular.component
        match: "@angular/core.Component"
      - id: angular.ngmodule
        match: "@angular/core.NgModule"

  nextjs:
    detect: [next]
    files:
      - id: nextjs.app-route
        match: "app/**/route.{ts,tsx,js,mjs}"
        exports: [GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS]
        methods: {from: export_name}
      - id: nextjs.pages-api
        match: "pages/api/**/*.{ts,tsx,js,mjs}"
        exports: [default]

  sveltekit:
    detect: ["@sveltejs/kit"]
    files:
      - id: sveltekit.server
        match: "**/+server.{ts,js}"
        exports: [GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS]
        methods: {from: export_name}

# Framework-independent tier. Matched on the WRITTEN spelling, never a resolved name, so a shape
# that reads as an HTTP entrypoint is flagged even when no `frameworks:` block knows the library
# (or it is not installed). Confidence `heuristic` is forced by the loader. Runs LAST; a node a
# framework rule already claimed gets no heuristic record.
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
  calls:
    # `app.get('/p', handler)` — the record attaches to the HANDLER (the callable the request
    # reaches), `via` is the module-scope call. `use` is deliberate: middleware is reachable from
    # outside just as a route is; filter on http_methods for routes only.
    - id: heuristic.http-verb-call
      match: "{*,*.*}.{get,post,put,patch,delete,all,use}"
      route: {from: positional, index: 0}
      methods: {from: match_suffix}
      handler: {from: positional, index: -1}

# Manifest-declared entrypoints: what runs when the package is executed. Confidence `declared`.
manifest:
  - id: manifest.bin
    source: package.json
    field: bin
  - id: manifest.main
    source: package.json
    field: main
```

- [ ] **Step 4: Write the loader (append to rules.ts)**

```ts
// append to src/entrypoints/rules.ts
import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { PatternError, validatePattern } from "./matching";
import SHIPPED_YAML from "./rules.yml" with { type: "text" };

const CONFIDENCE: ReadonlySet<string> = new Set(["declared", "certain", "heuristic"]);
// `declared:` readers and per-framework routing engines are spec blocks not implemented; they are
// deliberately absent here rather than accepted-and-ignored, so a user file using them fails
// loudly instead of loading clean and doing nothing.
const TOP_LEVEL = new Set(["version", "frameworks", "heuristics", "manifest", "disable"]);
const HEURISTIC_KEYS = new Set(["decorators", "calls"]);
const FRAMEWORK_KEYS = new Set(["detect", "decorators", "bases", "files"]);

type Raw = Record<string, unknown>;

export function loadRules(userPaths: readonly string[]): RuleSet {
  const out: RuleSet = { frameworks: {}, heuristics: { decorators: [], calls: [] }, manifest: [], rulesets: [] };
  merge(out, readYaml(SHIPPED_YAML, "shipped"), "shipped");
  for (const p of userPaths) {
    let text: string;
    try { text = fs.readFileSync(p, "utf8"); } catch { throw new RulesError(`rules file not found: ${p}`); }
    merge(out, readYaml(text, p), `user:${p}`);
  }
  return out;
}

function readYaml(text: string, origin: string): Raw {
  let data: unknown;
  try { data = parseYaml(text); } catch (e) { throw new RulesError(`${origin}: invalid YAML: ${(e as Error).message}`); }
  if (!isMap(data)) throw new RulesError(`${origin}: top level must be a mapping`);
  return data;
}

const isMap = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function merge(out: RuleSet, data: Raw, origin: string): void {
  const unknown = Object.keys(data).filter((k) => !TOP_LEVEL.has(k)).sort();
  if (unknown.length) throw new RulesError(`${origin}: unknown top-level key(s): ${unknown.join(", ")}`);
  out.rulesets.push(origin);
  const disabled = new Set(disableList(data, origin));

  const frameworks = data.frameworks ?? {};
  if (!isMap(frameworks)) throw new RulesError(`${origin}: \`frameworks\` must be a mapping`);
  for (const [name, body] of Object.entries(frameworks)) {
    if (!isMap(body)) throw new RulesError(`${origin}: framework \`${name}\` must be a mapping`);
    const bad = Object.keys(body).filter((k) => !FRAMEWORK_KEYS.has(k));
    if (bad.length) throw new RulesError(`${origin}: framework \`${name}\`: unknown key(s): ${bad.join(", ")}`);
    const fw = (out.frameworks[name] ??= { name, detect: [], decorators: [], bases: [], files: [] });
    fw.detect = [...new Set([...fw.detect, ...list(body.detect).map(String)])].sort();
    for (const raw of list(body.decorators)) fw.decorators.push(decoratorRule(raw, origin));
    for (const raw of list(body.bases)) fw.bases.push(baseRule(raw, origin));
    for (const raw of list(body.files)) fw.files.push(fileRule(raw, origin));
  }

  const heuristics = data.heuristics ?? {};
  if (!isMap(heuristics)) throw new RulesError(`${origin}: \`heuristics\` must be a mapping`);
  const badH = Object.keys(heuristics).filter((k) => !HEURISTIC_KEYS.has(k));
  if (badH.length) throw new RulesError(`${origin}: unknown heuristics key(s): ${badH.join(", ")}`);
  for (const raw of list(heuristics.decorators)) out.heuristics.decorators.push(decoratorRule({ ...(raw as Raw), confidence: "heuristic" }, origin));
  for (const raw of list(heuristics.calls)) out.heuristics.calls.push(callRule({ ...(raw as Raw), confidence: "heuristic" }, origin));

  for (const raw of list(data.manifest)) out.manifest.push(manifestRule(raw, origin));

  for (const fw of Object.values(out.frameworks)) {
    fw.decorators = fw.decorators.filter((r) => !disabled.has(r.id));
    fw.bases = fw.bases.filter((r) => !disabled.has(r.id));
    fw.files = fw.files.filter((r) => !disabled.has(r.id));
  }
  out.heuristics.decorators = out.heuristics.decorators.filter((r) => !disabled.has(r.id));
  out.heuristics.calls = out.heuristics.calls.filter((r) => !disabled.has(r.id));
  out.manifest = out.manifest.filter((r) => !disabled.has(r.id));
}

function disableList(data: Raw, origin: string): string[] {
  const raw = data.disable ?? [];
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) throw new RulesError(`${origin}: \`disable\` must be a list of rule id strings`);
  return raw as string[];
}

function require(raw: Raw, key: string, origin: string): unknown {
  if (!(key in raw)) throw new RulesError(`${origin}: rule ${JSON.stringify(raw)} is missing \`${key}\``);
  return raw[key];
}
function confidence(raw: Raw, origin: string): Confidence {
  const c = raw.confidence ?? "certain";
  if (typeof c !== "string" || !CONFIDENCE.has(c)) throw new RulesError(`${origin}: confidence must be one of declared, certain, heuristic — got ${JSON.stringify(c)}`);
  return c as Confidence;
}
function match(raw: Raw, origin: string): string {
  const m = String(require(raw, "match", origin));
  try { validatePattern(m); } catch (e) {
    if (e instanceof PatternError) throw new RulesError(`${origin}: rule ${JSON.stringify(raw.id ?? raw)}: ${e.message}`);
    throw e;
  }
  return m;
}
function argSpec(v: unknown): ArgSpec | undefined {
  if (!isMap(v)) return undefined;
  const spec: ArgSpec = { from: String(v.from) as ArgSpec["from"] };
  if (typeof v.index === "number") spec.index = v.index;
  if (typeof v.name === "string") spec.name = v.name;
  if (Array.isArray(v.default)) spec.default = v.default.map(String);
  return spec;
}
function asRaw(raw: unknown, origin: string): Raw {
  if (!isMap(raw)) throw new RulesError(`${origin}: rule must be a mapping, got ${JSON.stringify(raw)}`);
  return raw;
}
function decoratorRule(raw0: unknown, origin: string): DecoratorRule {
  const raw = asRaw(raw0, origin);
  return { id: String(require(raw, "id", origin)), match: match(raw, origin), confidence: confidence(raw, origin),
           route: argSpec(raw.route), methods: argSpec(raw.methods), origin };
}
function callRule(raw0: unknown, origin: string): CallRule {
  const raw = asRaw(raw0, origin);
  return { ...decoratorRule(raw, origin), handler: argSpec(raw.handler) ?? { from: "positional", index: -1 } };
}
function baseRule(raw0: unknown, origin: string): BaseRule {
  const raw = asRaw(raw0, origin);
  return { id: String(require(raw, "id", origin)), match: match(raw, origin), confidence: confidence(raw, origin),
           transitive: Boolean(raw.transitive ?? false), dispatch: list(raw.dispatch).map(String), origin };
}
function fileRule(raw0: unknown, origin: string): FileRule {
  const raw = asRaw(raw0, origin);
  const exports = list(require(raw, "exports", origin)).map(String);
  if (!exports.length) throw new RulesError(`${origin}: file rule ${JSON.stringify(raw.id)} needs a non-empty \`exports\``);
  return { id: String(require(raw, "id", origin)), match: String(require(raw, "match", origin)), exports,
           confidence: confidence(raw, origin), methods: argSpec(raw.methods), origin };
}
function manifestRule(raw0: unknown, origin: string): ManifestRule {
  const raw = asRaw(raw0, origin);
  const field = String(require(raw, "field", origin));
  if (field !== "main" && field !== "bin") throw new RulesError(`${origin}: manifest field must be main or bin, got ${field}`);
  if ((raw.source ?? "package.json") !== "package.json") throw new RulesError(`${origin}: manifest source must be package.json`);
  const c = raw.confidence ?? "declared";
  return { id: String(require(raw, "id", origin)), source: "package.json", field, confidence: confidence({ confidence: c }, origin), origin };
}
```

Note: file rules' `match` is a glob, not a dotted pattern, so it is NOT run through `validatePattern`.

- [ ] **Step 5: Wire the option, the CLI flag, and the up-front load**

`src/options/options.ts` — after `noRepoSections?: boolean;`:
```ts
  /**
   * Extra entrypoint rules files (YAML), merged with the shipped set (#72). Loading is
   * CONFIGURATION: a malformed file is a hard error before any analysis work starts.
   */
  entrypointRules: string[] | null;
```
`src/cli.ts` — next to `--no-repo-sections`:
```ts
    .option("--entrypoint-rules <yaml...>", "extra entrypoint rules file(s), merged with the shipped set; repeatable")
```
and in the returned object next to `noRepoSections`:
```ts
    entrypointRules: Array.isArray(o.entrypointRules) && o.entrypointRules.length ? o.entrypointRules.map(String) : null,
```
`src/core.ts` — at the very top of `analyze()`, before `materialize`:
```ts
  // Entrypoint rules are CONFIGURATION, validated before any analysis work: a malformed user file
  // must stop the run here, not after the symbol table, the solve and the dataflow have all run.
  const rules = loadRules(opts.entrypointRules ?? []);
```
with `import { loadRules } from "./entrypoints";`, and change the call at the bottom to `finalizeAnalysis(app, pg, opts, resolutions, project, rules)`.
`src/schema/emit.ts` — add `rules?: RuleSet` as the last parameter of `finalizeAnalysis` and call `detectEntrypoints(app, rules)`; `import type { RuleSet } from "../entrypoints";`.

Also `discoverPrograms(opts)` in `core.ts` must NOT load rules (it only enumerates programs).

- [ ] **Step 6: Run tests, typecheck, and prove the binary still works with the text import**

Run: `bun test test/entrypoints-rules.test.ts && bun test && bun run typecheck`
Expected: all PASS.
Run: `bun run build && ./dist/cants --input test/fixtures/sample-app --app-name sa --no-build -a 1 -o /tmp/cants-rules-check && grep -c '"rulesets":\["shipped"\]' /tmp/cants-rules-check/analysis.json`
Expected: `1` — the shipped YAML is embedded in the compiled binary.

- [ ] **Step 7: Commit**

```bash
git add src/entrypoints src/options/options.ts src/cli.ts src/core.ts src/schema/emit.ts test/entrypoints-rules.test.ts
git commit -m "feat(entrypoints): rules file, loader and --entrypoint-rules; rules load as configuration"
```

### Task 4: The decorator matcher and the heuristic decorator tier

**Files:**
- Modify: `src/entrypoints/matching.ts` (add `routeOf`, `methodsOf`, `literalOf`, `entrypointsFromDecorators`)
- Modify: `src/entrypoints/pipeline.ts` (framework tier, then heuristic tier)
- Test: `test/entrypoints-decorators.test.ts`

**Interfaces:**
- Produces: `entrypointsFromDecorators(node: { decorators?: TSDecorator[] }, framework: string, rules: DecoratorRule[], onWritten: boolean): TSEntrypoint[]`; `literalOf(raw: string): string | string[] | undefined` (strips one layer of quotes/backticks, parses a `[…]` of strings; template with `${` stays raw); `routeOf(dec, spec?)`, `methodsOf(dec, spec?, matched?)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/entrypoints-decorators.test.ts
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { literalOf } from "../src/entrypoints/matching";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication, TSCallable, TSType } from "../src/schema";
import { forEachCallable, forEachType } from "../src/schema";

function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-epd-"));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020", experimentalDecorators: true }, include: ["src/**/*.ts"] }));
  return dir;
}
const opts = (input: string, extra: Partial<AnalysisOptions> = {}) =>
  ({ input, appName: "d", analysisLevel: 1, eager: true, noBuild: true, emit: "json", graphs: ["cfg", "dfg", "pdg", "sdg"],
     graphFieldDepth: 3, jobs: 1, skipTests: true, phantoms: true, entrypointRules: null, ...extra }) as unknown as AnalysisOptions;
const rootOf = (r: { application: unknown }) => (r.application as { application: TSApplication }).application;
const byName = (root: TSApplication) => {
  const out: Record<string, TSCallable | TSType> = {};
  for (const m of Object.values(root.symbol_table)) { forEachCallable(m, (c) => { out[c.name] = c; }); forEachType(m, (t) => { out[t.name] = t; }); }
  return out;
};

const NEST = [
  'import { Controller, Get, Post } from "@nestjs/common";',
  "@Controller('/users')",
  "export class UsersController {",
  "  @Get(':id') show(): string { return ''; }",
  "  @Post() create(): string { return ''; }",
  "  helper(): void {}",
  "}",
].join("\n");

describe("decorator matcher", () => {
  test("NestJS: class and verb methods, with route and methods", async () => {
    const n = byName(rootOf(await analyze(opts(fixture({ "src/u.ts": NEST })))));
    expect(n.UsersController?.is_entrypoint).toBe(true);
    expect(n.UsersController?.entrypoints).toEqual([{ framework: "nestjs", confidence: "certain", rule: "nestjs.controller", ruleset: "shipped",
      evidence: "@nestjs/common.Controller", route: "/users", http_methods: [] }]);
    expect(n.show?.entrypoints).toEqual([{ framework: "nestjs", confidence: "certain", rule: "nestjs.verb", ruleset: "shipped",
      evidence: "@nestjs/common.Get", route: ":id", http_methods: ["GET"] }]);
    expect(n.create?.entrypoints?.[0]).toMatchObject({ rule: "nestjs.verb", http_methods: ["POST"] });
    expect(n.create?.entrypoints?.[0]?.route).toBeUndefined(); // no positional argument
    expect(n.helper?.is_entrypoint).toBe(false);
  });

  test("the gate: the same code without the NestJS import registers NOTHING from framework rules", async () => {
    const local = NEST.replace('import { Controller, Get, Post } from "@nestjs/common";',
      "function Controller(p: string): ClassDecorator { return () => undefined; }\nfunction Get(p?: string): MethodDecorator { return () => undefined; }\nfunction Post(): MethodDecorator { return () => undefined; }");
    const root = rootOf(await analyze(opts(fixture({ "src/u.ts": local }))));
    expect(root.entrypoint_report.frameworks_detected).toEqual([]);
    const n = byName(root);
    expect(n.UsersController?.entrypoints?.map((e) => e.framework)).toEqual([]);     // no framework, and no heuristic (Controller matches no heuristic rule)
    expect(n.show?.entrypoints?.map((e) => e.rule)).toEqual(["heuristic.http-verb"]); // BUT the written-spelling tier still sees @Get
    expect(n.show?.entrypoints?.[0]).toMatchObject({ framework: "heuristic", confidence: "heuristic", http_methods: ["GET"] });
  });

  test("heuristic tier runs last and never doubles a node a framework rule claimed", async () => {
    const n = byName(rootOf(await analyze(opts(fixture({ "src/u.ts": NEST })))));
    expect(n.show?.entrypoints?.length).toBe(1); // nestjs.verb only — no heuristic.http-verb on top
  });

  test("heuristic tier: written spelling, no framework needed, keyword methods", async () => {
    const src = [
      'import * as http from "some-unknown-lib";',
      "export class C {",
      "  @http.route('/a', { methods: ['GET', 'POST'] }) a(): void {}",
      "  @http.route('/b') b(): void {}",
      "}",
    ].join("\n");
    const n = byName(rootOf(await analyze(opts(fixture({ "src/h.ts": src })))));
    expect(n.a?.entrypoints).toEqual([{ framework: "heuristic", confidence: "heuristic", rule: "heuristic.http-route", ruleset: "shipped",
      evidence: "http.route", route: "/a", http_methods: ["GET", "POST"] }]);
    expect(n.b?.entrypoints?.[0]?.http_methods).toEqual([]);
  });

  test("a user rules file adds a framework and records its origin", async () => {
    const dir = fixture({ "src/m.ts": 'import { cmd } from "mine";\nexport class T { @cmd("run") go(): void {} }' });
    const rules = path.join(dir, "r.yml");
    fs.writeFileSync(rules, "version: 1\nframeworks:\n  mine:\n    detect: [mine]\n    decorators:\n      - id: mine.cmd\n        match: mine.cmd\n        route: {from: positional, index: 0}\n");
    const n = byName(rootOf(await analyze(opts(dir, { entrypointRules: [rules] } as Partial<AnalysisOptions>))));
    expect(n.go?.entrypoints?.[0]).toMatchObject({ framework: "mine", rule: "mine.cmd", ruleset: `user:${rules}`, route: "run" });
  });

  test("literalOf strips one layer of quotes and parses string lists", () => {
    expect(literalOf("'/x'")).toBe("/x");
    expect(literalOf('"/x"')).toBe("/x");
    expect(literalOf("`/x`")).toBe("/x");
    expect(literalOf("`/${id}`")).toBeUndefined();
    expect(literalOf("['GET', \"POST\"]")).toEqual(["GET", "POST"]);
    expect(literalOf("someVar")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/entrypoints-decorators.test.ts`
Expected: FAIL — `literalOf` not exported; entrypoints empty.

- [ ] **Step 3: Add the argument helpers and the decorator matcher to matching.ts**

```ts
// append to src/entrypoints/matching.ts
import type { TSDecorator, TSEntrypoint } from "../schema";
import type { ArgSpec, DecoratorRule } from "./rules";

const HTTP_VERBS: ReadonlySet<string> = new Set(["get", "post", "put", "patch", "delete", "head", "options", "websocket", "all", "use"]);

/**
 * Decode a RAW source fragment (decorator/call arguments are stored as written): one layer of
 * matching quotes/backticks → the string; `[…]` of string literals → the list; anything else
 * (an identifier, a template with `${`, an object) → undefined. Python's `_literal` reads the AST;
 * TypeScript has only the text, so this is deliberately narrow.
 */
export function literalOf(raw: string): string | string[] | undefined {
  const s = raw.trim();
  const q = s[0];
  if ((q === "'" || q === '"' || q === "`") && s.endsWith(q) && s.length >= 2) {
    const inner = s.slice(1, -1);
    return q === "`" && inner.includes("${") ? undefined : inner;
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const items = s.slice(1, -1).split(",").map((x) => literalOf(x)).filter((x): x is string => typeof x === "string");
    return items;
  }
  return undefined;
}

const firstString = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v.find((x) => typeof x === "string") : v);

export function routeOf(args: string[], spec: ArgSpec | undefined): string | undefined {
  if (!spec || spec.from !== "positional") return undefined;
  const idx = spec.index ?? 0;
  const raw = args[idx < 0 ? args.length + idx : idx];
  return raw === undefined ? undefined : firstString(literalOf(raw));
}

export function methodsOf(args: string[], kwargs: Record<string, string>, spec: ArgSpec | undefined, matched: string): string[] {
  if (!spec) return [];
  if (spec.from === "match_suffix") {
    const verb = matched.split(".").pop() ?? "";
    return HTTP_VERBS.has(verb.toLowerCase()) ? [verb.toUpperCase()] : [];
  }
  if (spec.from === "keyword") {
    const raw = kwargs[spec.name ?? ""];
    const v = raw === undefined ? undefined : literalOf(raw);
    if (Array.isArray(v)) return v.map((x) => x.toUpperCase());
    if (typeof v === "string") return [v.toUpperCase()];
    return [...(spec.default ?? [])];
  }
  if (spec.from === "export_name") return [matched.toUpperCase()];
  return [];
}

/**
 * Framework tier: `match:` against `qualified_name` (import-table resolution). Heuristic tier
 * (`onWritten`): `match:` against `name` as written, no resolution at all.
 */
export function entrypointsFromDecorators(
  node: { decorators?: TSDecorator[] },
  framework: string,
  rules: readonly DecoratorRule[],
  onWritten: boolean,
): TSEntrypoint[] {
  const out: TSEntrypoint[] = [];
  for (const dec of node.decorators ?? []) {
    const candidate = onWritten ? dec.name : dec.qualified_name;
    for (const rule of rules) {
      if (!matchPattern(rule.match, candidate)) continue;
      const ep: TSEntrypoint = {
        framework, confidence: rule.confidence, rule: rule.id, ruleset: rule.origin,
        evidence: candidate as string, http_methods: methodsOf(dec.positional_arguments, dec.keyword_arguments, rule.methods, candidate as string),
      };
      const route = routeOf(dec.positional_arguments, rule.route);
      if (route !== undefined) ep.route = route;
      out.push(ep);
    }
  }
  return out;
}
```

- [ ] **Step 4: Wire the two tiers into pipeline.ts**

Replace the body between the counter loop and the `catch` with a stage that runs framework rules on detected frameworks and then the heuristic tier:

```ts
    const frameworks = report.frameworks_detected;
    for (const mod of Object.values(app.symbol_table)) {
      const visit = (node: TSCallable | TSType): void => {
        if ("kind" in node && node.kind !== "class" && !("parameters" in node)) return; // types other than class
        node.entrypoints = node.entrypoints ?? [];
        for (const name of frameworks) {
          node.entrypoints.push(...entrypointsFromDecorators(node, name, rules.frameworks[name]!.decorators, false));
        }
        // Heuristic tier LAST, and only for a node no framework rule claimed (python #185).
        if (node.entrypoints.length === 0) {
          node.entrypoints.push(...entrypointsFromDecorators(node, "heuristic", rules.heuristics.decorators, true));
        }
        node.is_entrypoint = node.entrypoints.length > 0;
      };
      forEachCallable(mod, visit);
      forEachType(mod, (t) => { if (t.kind === "class") visit(t); });
    }
```
(import `entrypointsFromDecorators` from `./matching` and the `TSCallable`/`TSType` types from `../schema`.) Write the guard so it type-checks against your `TSCallable`/`TSType` union — the intent is: callables always; types only when `kind === "class"`.

- [ ] **Step 5: Run tests, full suite, typecheck**

Run: `bun test test/entrypoints-decorators.test.ts && bun test && bun run typecheck`
Expected: PASS. If `evidence` for the gated-off test differs, remember: under the gate, `frameworks_detected` is `[]`, so only the heuristic tier ran, and it matched `Get` (written) against `{*,*.*}.{get,...}`? — No: `Get` alone has no receiver segment, so `heuristic.http-verb` requires `{*,*.*}.` prefix. Check the expectation against the pattern: `Get` does NOT match `{*,*.*}.{get,...}` (case-sensitive `get`, and needs a dot). Adjust the second test's expectation to `[]` for `show` if that is what the engine says — then ADD a decorator written as `@http.get('/x')` to the local fixture to exercise the heuristic path there instead. Record which you did in the commit body.

- [ ] **Step 6: Commit**

```bash
git add src/entrypoints test/entrypoints-decorators.test.ts
git commit -m "feat(entrypoints): decorator matcher, framework tier then heuristic tier"
```

### Task 5: Module-scope call sites, and the `calls:` heuristic tier

**Files:**
- Modify: `src/schema/schema.ts` (`call_sites?: TSCallsite[]` on `TSModule`, marked INTERNAL)
- Modify: `src/syntactic_analysis/builders.ts` (`buildModule`: capture top-level call sites with the same walker `buildCallable` uses at ~line 525–531)
- Modify: `src/utils/serialize.ts` (verify `call_sites` is stripped by key at every depth — it already is for callables; confirm the module level is covered)
- Modify: `src/entrypoints/matching.ts` (`entrypointsFromCalls`), `src/entrypoints/pipeline.ts`
- Test: `test/entrypoints-calls.test.ts`

**Interfaces:**
- Produces: `TSModule.call_sites?: TSCallsite[]` (INTERNAL). `entrypointsFromCalls(mod: TSModule, rules: readonly CallRule[]): Array<{ target: TSCallable; ep: TSEntrypoint }>`.
- Attachment: the record goes on the HANDLER callable; `via` = `<module-id>@<line>:<col>` of the call (the L1 body-node id shape); `evidence` = the callee as written (`app.get`).
- Handler resolution, in order: (1) the handler argument text is an identifier → the module's callable with that `name` (free function, or `const x = () => …` which materializes as a named function); (2) the argument text starts with `(`, `async`, or `function` → the module's `<anon@L:C>` callable whose `span.start` lies within the call site's span (earliest start wins); (3) neither → `report.unresolved[<callee spelling>]++`.

- [ ] **Step 1: Write the failing test**

```ts
// test/entrypoints-calls.test.ts
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication } from "../src/schema";
import { forEachCallable } from "../src/schema";

const fixture = (src: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-epc-"));
  fs.mkdirSync(path.join(dir, "src")); fs.writeFileSync(path.join(dir, "src", "app.ts"), src);
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020" }, include: ["src/**/*.ts"] }));
  return dir;
};
const opts = (input: string) => ({ input, appName: "c", analysisLevel: 1, eager: true, noBuild: true, emit: "json", graphs: ["cfg","dfg","pdg","sdg"],
  graphFieldDepth: 3, jobs: 1, skipTests: true, phantoms: true, entrypointRules: null }) as unknown as AnalysisOptions;
const rootOf = (r: { application: unknown }) => (r.application as { application: TSApplication }).application;

const EXPRESS = [
  'import express from "express";',
  "const app = express();",
  "export function named(req: unknown, res: unknown): void {}",
  "const arrow = (req: unknown, res: unknown) => {};",
  "app.get('/a', named);",
  "app.post('/b', (req: unknown, res: unknown) => { named(req, res); });",
  "app.put('/c', arrow);",
  "app.use(somethingUndefined);",
  "app.listen(3000);",
  "function setup() { app.delete('/d', named); }",
].join("\n");

describe("calls: heuristic tier (Express shape)", () => {
  test("module-scope calls are captured on the module, and inner ones are not duplicated there", async () => {
    // INTERNAL field: reach it through the analysis result's internal tree, not the wire.
    const res = await analyze(opts(fixture(EXPRESS)));
    const mod = (res.internal as { symbol_table: Record<string, { call_sites?: Array<{ method_name: string }> }> }).symbol_table["src/app.ts"];
    expect(mod?.call_sites?.map((c) => c.method_name)).toEqual(["express", "get", "post", "put", "use", "listen"]);
    // and the wire never carries it
    expect(JSON.stringify(rootOf(res).symbol_table["src/app.ts"])).not.toContain('"call_sites"');
  });

  test("records attach to the handler: identifier, inline arrow, const-arrow, and inside a function", async () => {
    const root = rootOf(await analyze(opts(fixture(EXPRESS))));
    const byName: Record<string, unknown[]> = {};
    for (const m of Object.values(root.symbol_table)) forEachCallable(m, (c) => { byName[c.name] = c.entrypoints ?? []; });
    expect(byName.named).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "heuristic.http-verb-call", evidence: "app.get", route: "/a", http_methods: ["GET"], confidence: "heuristic", framework: "heuristic" }),
      expect.objectContaining({ evidence: "app.delete", route: "/d", http_methods: ["DELETE"] }),
    ]));
    expect(byName.arrow?.[0]).toMatchObject({ evidence: "app.put", route: "/c", http_methods: ["PUT"] });
    expect(byName["(anonymous)"]?.[0]).toMatchObject({ evidence: "app.post", route: "/b", http_methods: ["POST"] });
    // via is the module-scope call node id
    expect((byName.named?.[0] as { via?: string }).via).toMatch(/^can:\/\/typescript\/c\/src\/app\.ts@5:\d+$/);
  });

  test("an unresolvable handler is counted, not fabricated", async () => {
    const root = rootOf(await analyze(opts(fixture(EXPRESS))));
    expect(root.entrypoint_report.unresolved["app.use"]).toBe(1);
  });

  test("never doubles: a node a framework rule claimed gets no calls record", async () => {
    // Not exercisable until a framework rule can claim a handler; assert the invariant at the
    // record level instead: the same handler registered twice gets two records (two calls), but
    // each call yields exactly one.
    const root = rootOf(await analyze(opts(fixture(EXPRESS))));
    let named: unknown[] = [];
    for (const m of Object.values(root.symbol_table)) forEachCallable(m, (c) => { if (c.name === "named") named = c.entrypoints ?? []; });
    expect(named.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/entrypoints-calls.test.ts`
Expected: FAIL — `call_sites` undefined on the module.

- [ ] **Step 3: Capture module-scope call sites**

In `src/schema/schema.ts`, on `TSModule` after `fields`:
```ts
  /** INTERNAL (#72 unit 3): top-level call sites, for the `calls:` entrypoint tier. Stripped by serialize.ts. */
  call_sites?: TSCallsite[];
```
In `src/syntactic_analysis/builders.ts` `buildModule`: read how `buildCallable` collects `call_sites` (the `onCall` hook around line 525–531 — it walks a body and calls `buildCallsite(n)` per call expression, and it does NOT descend into nested callables, which own their own). Apply that same walker to the SourceFile's top-level statements, skipping any statement that is itself a function/class/namespace declaration (their calls belong to them), and set `call_sites` on the returned module. If the walker is a closure inside `buildCallable`, lift it to a module-level function that takes `(node, onCall)` and use it from both places — do not duplicate the walk.

Verify `src/utils/serialize.ts` strips `call_sites` by KEY regardless of depth (grep for `call_sites`); if it strips only under callables, extend the key set so the module level is covered too.

- [ ] **Step 4: The calls matcher and its wiring**

```ts
// append to src/entrypoints/matching.ts
import type { TSCallable, TSCallsite, TSModule } from "../schema";
import type { CallRule } from "./rules";

const INLINE = /^(async\s*)?(\(|function\b|[A-Za-z_$][\w$]*\s*=>)/;

export function entrypointsFromCalls(
  mod: TSModule,
  rules: readonly CallRule[],
  unresolved: (key: string) => void,
): Array<{ target: TSCallable; ep: TSEntrypoint }> {
  const out: Array<{ target: TSCallable; ep: TSEntrypoint }> = [];
  const callables: TSCallable[] = [];
  forEachCallable(mod, (c) => callables.push(c));
  for (const site of mod.call_sites ?? []) {
    const written = site.receiver_expr ? `${site.receiver_expr}.${site.method_name}` : site.method_name;
    for (const rule of rules) {
      if (!matchPattern(rule.match, written)) continue;
      const target = resolveHandler(site, rule, callables);
      if (!target) { unresolved(written); continue; }
      const ep: TSEntrypoint = {
        framework: "heuristic", confidence: rule.confidence, rule: rule.id, ruleset: rule.origin, evidence: written,
        http_methods: methodsOf(site.arguments, {}, rule.methods, written),
        via: `${mod.id}@${site.start_line}:${site.start_column}`,
      };
      const route = routeOf(site.arguments, rule.route);
      if (route !== undefined) ep.route = route;
      out.push({ target, ep });
    }
  }
  return out;
}

function resolveHandler(site: TSCallsite, rule: CallRule, callables: readonly TSCallable[]): TSCallable | undefined {
  const idx = rule.handler.index ?? -1;
  const raw = site.arguments[idx < 0 ? site.arguments.length + idx : idx]?.trim();
  if (!raw) return undefined;
  if (/^[A-Za-z_$][\w$]*$/.test(raw)) return callables.find((c) => c.name === raw);
  if (INLINE.test(raw)) {
    const inside = callables.filter((c) => c.name === "(anonymous)" &&
      (c.span.start[0] > site.start_line || (c.span.start[0] === site.start_line && c.span.start[1] >= site.start_column)) &&
      (c.span.start[0] < site.end_line || (c.span.start[0] === site.end_line && c.span.start[1] <= site.end_column)));
    inside.sort((a, b) => a.span.start[0] - b.span.start[0] || a.span.start[1] - b.span.start[1]);
    return inside[0];
  }
  return undefined;
}
```
(import `forEachCallable` from `../schema`.) In `pipeline.ts`, after the decorator tiers and before `is_entrypoint` is finalized, run per module:
```ts
      for (const { target, ep } of entrypointsFromCalls(mod, rules.heuristics.calls, bump)) {
        // Heuristic tier never doubles a node a FRAMEWORK rule claimed.
        if ((target.entrypoints ?? []).some((e) => e.framework !== "heuristic")) continue;
        (target.entrypoints ??= []).push(ep);
        target.is_entrypoint = true;
      }
```
where `bump` is the same unresolved counter closure Task 1 defined (hoist it so both stages share it). `mod.id` is stamped by `assignIds` before this pass runs.

- [ ] **Step 5: Run tests, full suite, typecheck, container**

Run: `bun test test/entrypoints-calls.test.ts && bun test && bun run typecheck && DOCKER_HOST=unix:///Users/rkrsn/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock bun run test:container`
Expected: PASS. `test/l1-body-cache-shape.test.ts` and the schema-v2 gates must still pass — the module's `call_sites` is INTERNAL and must not reach the cache shape or the wire; if the cache test fails, exclude the key where the callable-level `call_sites` is already excluded.

- [ ] **Step 6: Commit**

```bash
git add src/schema/schema.ts src/syntactic_analysis/builders.ts src/utils/serialize.ts src/entrypoints test/entrypoints-calls.test.ts
git commit -m "feat(entrypoints): capture module-scope call sites; calls: heuristic tier attaches to the handler"
```

---

## Unit 4 — base-class matcher

File issue: "feat(entrypoints): base-class matcher with transitive heritage, dispatch and via (unit 4)". Branch `feat/issue-NNN-entrypoint-bases`.

### Task 6: `entrypointsFromBases`

**Files:**
- Modify: `src/entrypoints/matching.ts`, `src/entrypoints/pipeline.ts`, `src/entrypoints/rules.yml` (add a `bases:` rule so the shipped set exercises it)
- Test: `test/entrypoints-bases.test.ts`

**Interfaces:**
- Produces: `entrypointsFromBases(cls: TSType, framework: string, rules: readonly BaseRule[], resolve: (written: string) => string, typeById: Map<string, TSType>): { classEps: TSEntrypoint[]; methodEps: Map<string, TSEntrypoint[]> }`.
- Semantics (python): a rule matches if ANY base of the class (resolved through the import table, else as written) matches `rule.match`. With `transitive: true`, also the bases of every ancestor reachable through `extends_ids` (in-project only — an external ancestor has no node). The class gets one record (`evidence: cls.signature`). Each name in `rule.dispatch` that the class DEFINES as a method gets a record with `rule: "<id>.dispatch"`, `via: cls.id`, `http_methods: [NAME]` when NAME is an HTTP verb. A `ListView` with only `get` gains no phantom `post`.
- Shipped rule to add under `nestjs:` — none (NestJS is decorator-only). Add under a new framework so the shipped set has a base rule:
  ```yaml
  koa-router-class:   # illustrative? NO — do not ship illustrative rules.
  ```
  Instead ship NOTHING new under `frameworks:` for bases; exercise the matcher through a USER rules file in the test. The shipped `rules.yml` gains base rules only when a real framework needs one (Angular/Nest do not).

- [ ] **Step 1: Write the failing test**

```ts
// test/entrypoints-bases.test.ts
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication } from "../src/schema";
import { forEachCallable, forEachType } from "../src/schema";

function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-epb-"));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020" }, include: ["src/**/*.ts"] }));
  return dir;
}
const RULES = "version: 1\nframeworks:\n  viewfw:\n    detect: [viewfw]\n    bases:\n      - id: viewfw.view\n        match: viewfw.View\n        transitive: true\n        dispatch: [get, post, list]\n";
const opts = (input: string, rules: string) => ({ input, appName: "b", analysisLevel: 1, eager: true, noBuild: true, emit: "json", graphs: ["cfg","dfg","pdg","sdg"],
  graphFieldDepth: 3, jobs: 1, skipTests: true, phantoms: true, entrypointRules: [rules] }) as unknown as AnalysisOptions;
const rootOf = (r: { application: unknown }) => (r.application as { application: TSApplication }).application;

describe("base-class matcher", () => {
  test("direct base via import table; dispatch only for defined methods; via = class id", async () => {
    const dir = fixture({ "src/v.ts": 'import { View } from "viewfw";\nexport class Users extends View { get(): void {} other(): void {} }' });
    const rules = path.join(dir, "r.yml"); fs.writeFileSync(rules, RULES);
    const root = rootOf(await analyze(opts(dir, rules)));
    let cls: { id: string; entrypoints?: unknown[] } | undefined; const methods: Record<string, unknown[]> = {};
    for (const m of Object.values(root.symbol_table)) { forEachType(m, (t) => { if (t.name === "Users") cls = t; }); forEachCallable(m, (c) => { methods[c.name] = c.entrypoints ?? []; }); }
    expect(cls?.entrypoints).toEqual([{ framework: "viewfw", confidence: "certain", rule: "viewfw.view", ruleset: `user:${rules}`, evidence: "src/v.Users", http_methods: [] }]);
    expect(methods.get?.[0]).toMatchObject({ rule: "viewfw.view.dispatch", via: cls?.id, http_methods: ["GET"] });
    expect(methods.post).toBeUndefined();          // not defined → no phantom record
    expect(methods.other).toEqual([]);             // defined but not dispatched
  });

  test("transitive: an in-project ancestor's base matches", async () => {
    const dir = fixture({
      "src/base.ts": 'import { View } from "viewfw";\nexport class BaseView extends View {}',
      "src/v.ts": 'import { BaseView } from "./base";\nexport class Users extends BaseView { list(): void {} }',
    });
    const rules = path.join(dir, "r.yml"); fs.writeFileSync(rules, RULES);
    const root = rootOf(await analyze(opts(dir, rules)));
    const eps: Record<string, unknown[]> = {};
    for (const m of Object.values(root.symbol_table)) { forEachType(m, (t) => { eps[t.name] = t.entrypoints ?? []; }); forEachCallable(m, (c) => { eps[`m:${c.name}`] = c.entrypoints ?? []; }); }
    expect(eps.Users?.length).toBe(1);
    expect(eps.BaseView?.length).toBe(1);          // the ancestor itself directly extends View
    expect(eps["m:list"]?.[0]).toMatchObject({ rule: "viewfw.view.dispatch", http_methods: [] }); // `list` is not an HTTP verb
  });

  test("the gate still applies: no viewfw import or dependency → nothing", async () => {
    const dir = fixture({ "src/v.ts": "class View {}\nexport class Users extends View { get(): void {} }" });
    const rules = path.join(dir, "r.yml"); fs.writeFileSync(rules, RULES);
    const root = rootOf(await analyze(opts(dir, rules)));
    for (const m of Object.values(root.symbol_table)) forEachType(m, (t) => { expect(t.entrypoints ?? []).toEqual([]); });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/entrypoints-bases.test.ts`
Expected: FAIL — entrypoints empty.

- [ ] **Step 3: Implement**

```ts
// append to src/entrypoints/matching.ts
import type { BaseRule } from "./rules";

export function entrypointsFromBases(
  cls: TSType,
  framework: string,
  rules: readonly BaseRule[],
  resolve: (written: string) => string,
  typeById: Map<string, TSType>,
): { classEps: TSEntrypoint[]; methodEps: Map<string, TSEntrypoint[]> } {
  const classEps: TSEntrypoint[] = [];
  const methodEps = new Map<string, TSEntrypoint[]>();
  const directBases = (t: TSType): string[] => (t.base_classes ?? []).map(resolve);
  const allBases = (transitive: boolean): string[] => {
    const seen = new Set<string>(); const out: string[] = []; const stack: TSType[] = [cls];
    while (stack.length) {
      const t = stack.pop()!;
      if (seen.has(t.id)) continue; seen.add(t.id);
      out.push(...directBases(t));
      if (transitive) for (const id of t.extends_ids ?? []) { const p = typeById.get(id); if (p) stack.push(p); }
    }
    return out;
  };
  const defined = new Set(Object.keys(cls.callables ?? {}));
  for (const rule of rules) {
    if (!allBases(rule.transitive).some((b) => matchPattern(rule.match, b))) continue;
    classEps.push({ framework, confidence: rule.confidence, rule: rule.id, ruleset: rule.origin, evidence: cls.signature, http_methods: [] });
    for (const name of rule.dispatch) {
      if (!defined.has(name)) continue;
      const ep: TSEntrypoint = { framework, confidence: rule.confidence, rule: `${rule.id}.dispatch`, ruleset: rule.origin,
        evidence: cls.signature, http_methods: HTTP_VERBS.has(name.toLowerCase()) ? [name.toUpperCase()] : [], via: cls.id };
      (methodEps.get(name) ?? methodEps.set(name, []).get(name)!).push(ep);
    }
  }
  return { classEps, methodEps };
}
```
`cls.callables` is keyed by `memberKey` — confirm in a fixture that a method `get` is keyed `get` (not `get()`); if it carries a suffix, match on `Object.values(cls.callables).map(c => c.name)` instead. In `pipeline.ts`, build `typeById` once per run (walk all modules with `forEachType`, keyed by `t.id`), build `resolve` per module from `importTable(mod.imports)` + `resolveWritten` (identity when unresolved), and for each class and each detected framework with `bases`, push `classEps` onto the class and each `methodEps` entry onto `cls.callables[name]`.

- [ ] **Step 4: Run tests, full suite, typecheck**

Run: `bun test test/entrypoints-bases.test.ts && bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/entrypoints test/entrypoints-bases.test.ts
git commit -m "feat(entrypoints): base-class matcher over resolved heritage, with dispatch and via"
```

---

## Unit 5 — file-convention and manifest matchers

File issue: "feat(entrypoints): file-convention and manifest matchers (unit 5)". Branch `feat/issue-NNN-entrypoint-files`.

### Task 7: `entrypointsFromFiles`

**Files:**
- Modify: `src/entrypoints/matching.ts`, `src/entrypoints/pipeline.ts`
- Test: `test/entrypoints-files.test.ts`

**Interfaces:**
- Produces: `entrypointsFromFiles(mod: TSModule, framework: string, rules: readonly FileRule[]): Array<{ target: TSCallable; ep: TSEntrypoint }>`; `globToRegExp(glob: string): RegExp` (`**` = any path incl. `/`; `*` = within one segment; `{a,b}` alternation; anchored to the whole file key).
- A rule matches a module when its file key matches the glob. For each name in `exports`: `"default"` → the exported callable whose declaration text (`mod.source` sliced by `span.bytes`) starts with `export default`; otherwise the callable with `is_exported && name === <export>` in `mod.functions`. Record: `evidence: <fileKey>`, `route` = the file key with the matched prefix stripped (`app/users/route.ts` → `/users`; `pages/api/x.ts` → `/api/x`) — python has no analog, so keep it simple and document it; `http_methods` from `methods: {from: export_name}`.

- [ ] **Step 1: Write the failing test**

```ts
// test/entrypoints-files.test.ts
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { globToRegExp } from "../src/entrypoints/matching";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication } from "../src/schema";
import { forEachCallable } from "../src/schema";

function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-epf-"));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020" }, include: ["**/*.ts"] }));
  return dir;
}
const opts = (input: string) => ({ input, appName: "f", analysisLevel: 1, eager: true, noBuild: true, emit: "json", graphs: ["cfg","dfg","pdg","sdg"],
  graphFieldDepth: 3, jobs: 1, skipTests: true, phantoms: true, entrypointRules: null }) as unknown as AnalysisOptions;
const rootOf = (r: { application: unknown }) => (r.application as { application: TSApplication }).application;

describe("file-convention matcher", () => {
  test("globToRegExp", () => {
    expect(globToRegExp("app/**/route.{ts,js}").test("app/users/[id]/route.ts")).toBe(true);
    expect(globToRegExp("app/**/route.{ts,js}").test("app/route.ts")).toBe(true);
    expect(globToRegExp("app/**/route.{ts,js}").test("src/app/route.ts")).toBe(false);
    expect(globToRegExp("**/+server.ts").test("src/routes/x/+server.ts")).toBe(true);
    expect(globToRegExp("pages/api/*.ts").test("pages/api/a/b.ts")).toBe(false);
  });

  test("Next.js app router: exported verb functions are entrypoints, gated on the `next` dependency", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "x", dependencies: { next: "^14.0.0" } }),
      "app/users/route.ts": "export async function GET(): Promise<void> {}\nexport function POST(): void {}\nfunction helper(): void {}",
      "pages/api/hello.ts": "export default function handler(): void {}\nexport function notDefault(): void {}",
      "src/other.ts": "export function GET(): void {}",
    });
    const root = rootOf(await analyze(opts(dir)));
    const eps: Record<string, unknown[]> = {};
    for (const [key, m] of Object.entries(root.symbol_table)) forEachCallable(m, (c) => { eps[`${key}:${c.name}`] = c.entrypoints ?? []; });
    expect(eps["app/users/route.ts:GET"]?.[0]).toMatchObject({ framework: "nextjs", rule: "nextjs.app-route", confidence: "certain", evidence: "app/users/route.ts", route: "/users", http_methods: ["GET"] });
    expect(eps["app/users/route.ts:POST"]?.[0]).toMatchObject({ http_methods: ["POST"] });
    expect(eps["app/users/route.ts:helper"]).toEqual([]);
    expect(eps["pages/api/hello.ts:handler"]?.[0]).toMatchObject({ rule: "nextjs.pages-api", route: "/api/hello" });
    expect(eps["pages/api/hello.ts:notDefault"]).toEqual([]);
    expect(eps["src/other.ts:GET"]).toEqual([]); // not under the convention path
    expect(root.entrypoint_report.frameworks_detected).toEqual(["nextjs"]);
  });

  test("without the dependency, the same files register nothing", async () => {
    const dir = fixture({ "app/users/route.ts": "export function GET(): void {}" });
    const root = rootOf(await analyze(opts(dir)));
    for (const m of Object.values(root.symbol_table)) forEachCallable(m, (c) => { expect(c.entrypoints ?? []).toEqual([]); });
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun test test/entrypoints-files.test.ts` → FAIL, `globToRegExp` not exported.

- [ ] **Step 3: Implement**

```ts
// append to src/entrypoints/matching.ts
import type { FileRule } from "./rules";

const globCache = new Map<string, RegExp>();
export function globToRegExp(glob: string): RegExp {
  const hit = globCache.get(glob); if (hit) return hit;
  let out = ""; let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (glob.startsWith("**/", i)) { out += "(?:.*/)?"; i += 3; }
    else if (glob.startsWith("**", i)) { out += ".*"; i += 2; }
    else if (ch === "*") { out += "[^/]*"; i++; }
    else if (ch === "{") { const j = glob.indexOf("}", i); if (j < 0) throw new PatternError(`unclosed '{' in ${JSON.stringify(glob)}`);
      out += `(?:${glob.slice(i + 1, j).split(",").map((a) => a.trim().replace(/[.+?^$()|[\]\\]/g, "\\$&")).join("|")})`; i = j + 1; }
    else { out += ch.replace(/[.+?^$()|[\]\\\/]/g, "\\$&"); i++; }
  }
  const re = new RegExp(`^${out}$`); globCache.set(glob, re); return re;
}

/** `app/users/route.ts` under `app/**/route.{ts,js}` → `/users`; `pages/api/x.ts` → `/api/x`. */
function routeFromFileKey(fileKey: string, glob: string): string {
  const literalPrefix = glob.split(/[*{]/, 1)[0]!;              // "app/" or "pages/api/"
  const rest = fileKey.startsWith(literalPrefix) ? fileKey.slice(literalPrefix.length) : fileKey;
  const noExt = rest.replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/, "");
  const noRoute = noExt.replace(/\/?(route|\+server)$/, "");
  const prefixDir = literalPrefix.replace(/^app\//, "/").replace(/^pages\//, "/").replace(/\/$/, "");
  return (prefixDir === "/app" ? "" : prefixDir) + (noRoute ? `/${noRoute}` : "") || "/";
}

export function entrypointsFromFiles(mod: TSModule, fileKey: string, framework: string, rules: readonly FileRule[]): Array<{ target: TSCallable; ep: TSEntrypoint }> {
  const out: Array<{ target: TSCallable; ep: TSEntrypoint }> = [];
  for (const rule of rules) {
    if (!globToRegExp(rule.match).test(fileKey)) continue;
    for (const exp of rule.exports) {
      const target = Object.values(mod.functions ?? {}).find((c) => c.is_exported && (exp === "default"
        ? mod.source.slice(c.span.bytes[0], c.span.bytes[1]).trimStart().startsWith("export default")
        : c.name === exp));
      if (!target) continue;
      out.push({ target, ep: { framework, confidence: rule.confidence, rule: rule.id, ruleset: rule.origin, evidence: fileKey,
        route: routeFromFileKey(fileKey, rule.match), http_methods: methodsOf([], {}, rule.methods, exp) } });
    }
  }
  return out;
}
```
Wire into `pipeline.ts` per module, for each detected framework with `files`, pushing onto `target.entrypoints` and setting `is_entrypoint`. `routeFromFileKey` is a convention, not a contract; if the expected `/users` / `/api/hello` values need a different prefix rule, adjust the function — the test pins the observable behaviour.

- [ ] **Step 4: Run tests, full suite, typecheck** — `bun test test/entrypoints-files.test.ts && bun test && bun run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/entrypoints test/entrypoints-files.test.ts
git commit -m "feat(entrypoints): file-convention matcher (Next.js app/pages, SvelteKit +server)"
```

### Task 8: `entrypointsFromManifest`

**Files:**
- Modify: `src/entrypoints/matching.ts`, `src/entrypoints/pipeline.ts`
- Test: `test/entrypoints-manifest.test.ts`

**Interfaces:**
- Produces: `entrypointsFromManifest(app: AnalysisInternal, input: string, rules: readonly ManifestRule[], unresolved: (k: string) => void): Array<{ target: TSCallable; ep: TSEntrypoint }>`.
- Semantics (the spec's open question, decided here): a manifest entry names a FILE, and "what runs when that file is executed" is its module-scope calls. For each `main` / `bin` path in the root `package.json` (read via `app.artifacts` — the artifact layer already holds `package.json`'s text; parse its `source`; if repo sections were skipped (`--no-repo-sections`) read `path.join(input, "package.json")` from disk) → normalise to a file key (strip `./`; if the path has no extension or points at a `.js` under `dist/`/`out/`/`build/`, try the same path with `.ts`/`.tsx`/`.js` under `src/` and at the root) → the module. For each module-scope call site whose `method_name` names a free function in that module (no receiver), the callee callable gets `{ framework: "manifest", confidence: "declared", rule, evidence: "package.json#<field>", via: <module id> }`. If the file resolves to no module, or the module has no such call, `unresolved["package.json#<field>:<path>"]++`.

- [ ] **Step 1: Write the failing test**

```ts
// test/entrypoints-manifest.test.ts
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication } from "../src/schema";
import { forEachCallable } from "../src/schema";

function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-epm-"));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020" }, include: ["src/**/*.ts"] }));
  return dir;
}
const opts = (input: string, extra: Record<string, unknown> = {}) => ({ input, appName: "m", analysisLevel: 1, eager: true, noBuild: true, emit: "json",
  graphs: ["cfg","dfg","pdg","sdg"], graphFieldDepth: 3, jobs: 1, skipTests: true, phantoms: true, entrypointRules: null, ...extra }) as unknown as AnalysisOptions;
const rootOf = (r: { application: unknown }) => (r.application as { application: TSApplication }).application;
const collect = (root: TSApplication) => { const o: Record<string, unknown[]> = {}; for (const m of Object.values(root.symbol_table)) forEachCallable(m, (c) => { o[c.name] = c.entrypoints ?? []; }); return o; };

describe("manifest matcher", () => {
  test("main → the free functions the entry module calls at top level, confidence declared", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "x", main: "dist/index.js", bin: { cli: "./dist/cli.js" } }),
      "src/index.ts": "export function boot(): void {}\nboot();\nconsole.log('x');",
      "src/cli.ts": "import { boot } from './index';\nfunction run(): void { boot(); }\nrun();",
      "src/lib.ts": "export function unused(): void {}",
    });
    const root = rootOf(await analyze(opts(dir)));
    const eps = collect(root);
    expect(eps.boot).toEqual([{ framework: "manifest", confidence: "declared", rule: "manifest.main", ruleset: "shipped",
      evidence: "package.json#main", http_methods: [], via: expect.stringMatching(/src\/index\.ts$/) }]);
    expect(eps.run?.[0]).toMatchObject({ rule: "manifest.bin", evidence: "package.json#bin" });
    expect(eps.unused).toEqual([]);
    expect(root.entrypoint_report.unresolved).toEqual({}); // console.log has a receiver → not a candidate, not "unresolved"
  });

  test("a main that points nowhere is counted, not fabricated", async () => {
    const dir = fixture({ "package.json": JSON.stringify({ name: "x", main: "dist/nope.js" }), "src/a.ts": "export const x = 1;" });
    const root = rootOf(await analyze(opts(dir)));
    expect(root.entrypoint_report.unresolved).toEqual({ "package.json#main:dist/nope.js": 1 });
  });

  test("with --no-repo-sections the manifest is read from disk, so a shard still sees it", async () => {
    const dir = fixture({ "package.json": JSON.stringify({ name: "x", main: "src/index.ts" }), "src/index.ts": "export function boot(): void {}\nboot();" });
    const root = rootOf(await analyze(opts(dir, { noRepoSections: true })));
    expect(collect(root).boot?.[0]).toMatchObject({ rule: "manifest.main" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL, entrypoints empty.

- [ ] **Step 3: Implement**

```ts
// append to src/entrypoints/matching.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { AnalysisInternal } from "../schema";
import type { ManifestRule } from "./rules";

function manifestOf(app: AnalysisInternal, input: string): Record<string, unknown> | undefined {
  const art = Object.values(app.artifacts ?? {}).find((a) => (a as { path?: string }).path === "package.json") as { source?: string } | undefined;
  const text = art?.source ?? (() => { try { return fs.readFileSync(path.join(input, "package.json"), "utf8"); } catch { return undefined; } })();
  if (!text) return undefined;
  try { const j = JSON.parse(text); return typeof j === "object" && j ? j : undefined; } catch { return undefined; }
}

const EXTS = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs"];
/** `dist/index.js` → the module `src/index.ts` (or `index.ts`, or as written) — whichever the symbol table has. */
function moduleForPath(app: AnalysisInternal, declared: string): string | undefined {
  const rel = declared.replace(/\\/g, "/").replace(/^\.\//, "");
  const stem = rel.replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/, "");
  const bases = [stem, stem.replace(/^(dist|out|build|lib)\//, "src/"), stem.replace(/^(dist|out|build|lib)\//, "")];
  for (const b of bases) for (const ext of EXTS) if (app.symbol_table[b + ext]) return b + ext;
  return undefined;
}

export function entrypointsFromManifest(app: AnalysisInternal, input: string, rules: readonly ManifestRule[], unresolved: (k: string) => void): Array<{ target: TSCallable; ep: TSEntrypoint }> {
  const out: Array<{ target: TSCallable; ep: TSEntrypoint }> = [];
  const pkg = manifestOf(app, input);
  if (!pkg) return out;
  for (const rule of rules) {
    const raw = pkg[rule.field];
    const paths: string[] = typeof raw === "string" ? [raw] : (raw && typeof raw === "object") ? Object.values(raw as Record<string, unknown>).filter((v): v is string => typeof v === "string") : [];
    for (const p of paths) {
      const key = moduleForPath(app, p);
      const mod = key ? app.symbol_table[key] : undefined;
      if (!mod) { unresolved(`package.json#${rule.field}:${p}`); continue; }
      const free = new Map(Object.values(mod.functions ?? {}).map((c) => [c.name, c] as const));
      let hit = false;
      for (const site of mod.call_sites ?? []) {
        if (site.receiver_expr) continue;
        const target = free.get(site.method_name);
        if (!target) continue;
        hit = true;
        out.push({ target, ep: { framework: "manifest", confidence: rule.confidence, rule: rule.id, ruleset: rule.origin,
          evidence: `package.json#${rule.field}`, http_methods: [], via: mod.id } });
      }
      if (!hit) unresolved(`package.json#${rule.field}:${p}`);
    }
  }
  return out;
}
```
Check the artifact record's path field name (`path`? `rel_path`? — read `TSArtifact` in `schema.ts`) and use the real one. Wire into `pipeline.ts` after the framework stages; `detectEntrypoints` now needs `opts.input` — change its signature to `detectEntrypoints(app, opts, rules)` and update the call in `emit.ts` (it already has `opts`).

- [ ] **Step 4: Run tests, full suite, typecheck, container** — all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/entrypoints src/schema/emit.ts test/entrypoints-manifest.test.ts
git commit -m "feat(entrypoints): manifest matcher (package.json main/bin → top-level-called free functions)"
```

### Task 9: Level invariance, the binary, docs, closeout

**Files:**
- Test: `test/entrypoints-invariance.test.ts`
- Modify: `README.md` (via `bun run gen:readme`), `docs/design/specs/entrypoint-detection.md` (mark open questions decided), issue #72 goals

- [ ] **Step 1: Write the invariance test**

```ts
// test/entrypoints-invariance.test.ts
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication } from "../src/schema";
import { forEachCallable, forEachType } from "../src/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-epi-"));
fs.mkdirSync(path.join(dir, "src"));
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", main: "src/index.ts", dependencies: { "@nestjs/common": "^10", express: "^4" } }));
fs.writeFileSync(path.join(dir, "src", "index.ts"), [
  'import { Controller, Get } from "@nestjs/common";', 'import express from "express";',
  "@Controller('/u') export class U { @Get() list(): string { return ''; } }",
  "const app = express(); export function h(): void {} app.get('/h', h); export function boot(): void {} boot();",
].join("\n"));
fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020", experimentalDecorators: true }, include: ["src/**/*.ts"] }));
const opts = (analysisLevel: number, eager: boolean) => ({ input: dir, appName: "i", analysisLevel, eager, noBuild: true, emit: "json", graphs: ["cfg","dfg","pdg","sdg"],
  graphFieldDepth: 3, jobs: 1, skipTests: true, phantoms: true, entrypointRules: null }) as unknown as AnalysisOptions;
const rootOf = (r: { application: unknown }) => (r.application as { application: TSApplication }).application;
const stamped = (root: TSApplication) => { const o: Record<string, unknown> = { __report: root.entrypoint_report };
  for (const m of Object.values(root.symbol_table)) { forEachCallable(m, (c) => { o[c.id] = [c.entrypoints, c.is_entrypoint]; }); forEachType(m, (t) => { o[t.id] = [t.entrypoints, t.is_entrypoint]; }); } return o; };

describe("entrypoints are identical at every -a", () => {
  test("L1 cold, then L2-L4 warm, with every matcher kind firing", async () => {
    const l1 = stamped(rootOf(await analyze(opts(1, true))));
    expect(l1.__report).toMatchObject({ frameworks_detected: ["nestjs"], errors: [] });
    // sanity: something actually fired at each tier
    const all = JSON.stringify(l1);
    for (const rule of ["nestjs.controller", "nestjs.verb", "heuristic.http-verb-call", "manifest.main"]) expect(all).toContain(rule);
    for (const level of [2, 3, 4]) expect(stamped(rootOf(await analyze(opts(level, false))))).toEqual(l1);
  });
});
```
Run: `bun test test/entrypoints-invariance.test.ts` → PASS (if a tier does not fire, that tier's task is incomplete — fix there, not here).

- [ ] **Step 2: Binary and docs**

Run: `bun run build && bun run gen:readme && git diff --stat README.md` — the `--entrypoint-rules` line appears in the help block.
Edit the spec's "Open questions": record the decisions Tasks 5 and 8 made (module-scope `call_sites` INTERNAL capture; manifest entries attach to top-level-called free functions with `confidence: declared`; no module-level `entrypoints` — the shared vocabulary is untouched). Tick #72's goals.

- [ ] **Step 3: Full verification and commit**

Run: `bun test && bun run typecheck && DOCKER_HOST=unix:///Users/rkrsn/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock bun run test:container`
```bash
git add test/entrypoints-invariance.test.ts README.md docs/design/specs/entrypoint-detection.md
git commit -m "test(entrypoints): level invariance across a warm cache; docs and spec closeout"
```

---

## Self-review (done at authoring time)

- **Spec coverage:** gate (T1), unresolved counter (T1), rules file + loader + `--entrypoint-rules` + hard-error-before-analysis (T3), decorator matcher on import-table resolution (T4), heuristic tier with forced confidence / runs last / never doubles (T4, T5), `calls:` with handler attach and `via` (T5), base classes with transitive/dispatch/via (T6), file convention (T7), manifest (T8), level-free (T9), report to Neo4j (unit 1, already merged; values now populate). Not covered on purpose: odoo.
- **Placeholders:** none. Two spots tell the implementer to VERIFY a fact against real output and adjust (`isSignature`, `memberKey` for methods, the artifact path field, `routeFromFileKey`) — each with the test that pins the observable behaviour.
- **Type consistency:** `TSEntrypoint`/`TSEntrypointReport` from `src/schema` (unit 1); `RuleSet` shape defined in T1 and consumed unchanged in T3–T8; `detectEntrypoints(app, rules)` in T1/T3 becomes `detectEntrypoints(app, opts, rules)` in T8 with `emit.ts` updated in the same task.
