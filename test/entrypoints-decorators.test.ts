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
    const local = [
      'import * as http from "unknown-http";',
      "function Controller(p: string): ClassDecorator { return () => undefined; }",
      "function Get(p?: string): MethodDecorator { return () => undefined; }",
      "function Post(): MethodDecorator { return () => undefined; }",
      "@Controller('/users')",
      "export class UsersController {",
      "  @Get(':id') show(): string { return ''; }",
      "  @Post() create(): string { return ''; }",
      "  @http.get('/x') viaNs(): string { return ''; }",
      "  helper(): void {}",
      "}",
    ].join("\n");
    const root = rootOf(await analyze(opts(fixture({ "src/u.ts": local }))));
    expect(root.entrypoint_report.frameworks_detected).toEqual([]);
    const n = byName(root);
    expect(n.UsersController?.entrypoints?.map((e) => e.framework)).toEqual([]);     // no framework, and no heuristic (Controller matches no heuristic rule)
    expect(n.show?.entrypoints).toEqual([]);                                        // bare @Get: no receiver, capitalised — matches no heuristic rule either
    expect(n.viaNs?.entrypoints?.[0]).toMatchObject({ framework: "heuristic", confidence: "heuristic", rule: "heuristic.http-verb",
      evidence: "http.get", route: "/x", http_methods: ["GET"] });
  });

  test("heuristic tier runs last and never doubles a node a framework rule claimed", async () => {
    // A genuine tier collision: `mine.get` resolves (import-table) to `mine.verb` (a user framework
    // rule) AND, as WRITTEN, matches the shipped `heuristic.http-verb` pattern. Without the
    // `if (node.entrypoints.length === 0)` guard in pipeline.ts, this node would carry both records.
    const dir = fixture({ "src/c.ts": 'import * as mine from "mine";\nexport class C { @mine.get(\'/x\') m(): string { return \'\'; } }' });
    const rules = path.join(dir, "r.yml");
    fs.writeFileSync(rules, "version: 1\nframeworks:\n  mine:\n    detect: [mine]\n    decorators:\n      - id: mine.verb\n        match: \"mine.{get,post}\"\n        route: {from: positional, index: 0}\n        methods: {from: match_suffix}\n");
    const n = byName(rootOf(await analyze(opts(dir, { entrypointRules: [rules] } as Partial<AnalysisOptions>))));
    expect(n.m?.entrypoints).toEqual([{ framework: "mine", confidence: "certain", rule: "mine.verb", ruleset: `user:${rules}`,
      evidence: "mine.get", route: "/x", http_methods: ["GET"] }]);
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
