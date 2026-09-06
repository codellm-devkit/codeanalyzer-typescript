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
    let cls: { id: string; entrypoints?: unknown[]; callables?: Record<string, unknown> } | undefined; const methods: Record<string, unknown[]> = {};
    for (const m of Object.values(root.symbol_table)) { forEachType(m, (t) => { if (t.name === "Users") cls = t; }); forEachCallable(m, (c) => { methods[c.name] = c.entrypoints ?? []; }); }
    // Task 6 decision #3: cls.callables is keyed by plain method name ("get"), confirmed here — see task-6-report.md.
    expect(Object.keys(cls?.callables ?? {})).toEqual(["get", "other", "constructor"]);
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
