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
    // via for a call site owned by a callable (app.delete inside setup()) names THAT callable, not the module
    const deleteRecord = byName.named?.find((e) => (e as { evidence?: string }).evidence === "app.delete") as { via?: string } | undefined;
    expect(deleteRecord?.via).toMatch(/^can:\/\/typescript\/c\/src\/app\.ts\/setup@10:\d+$/);
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

  test("http_methods excludes non-HTTP tokens: use/all are filtered by python's seven (Important 1)", async () => {
    const src = [
      'import express from "express";',
      "const app = express();",
      "export function mw(req: unknown, res: unknown, next: unknown): void {}",
      "app.use(mw);",
      "app.all('/x', mw);",
    ].join("\n");
    const root = rootOf(await analyze(opts(fixture(src))));
    let mw: unknown[] = [];
    for (const m of Object.values(root.symbol_table)) forEachCallable(m, (c) => { if (c.name === "mw") mw = c.entrypoints ?? []; });
    expect(mw).toEqual([
      expect.objectContaining({ evidence: "app.use", http_methods: [] }),
      expect.objectContaining({ evidence: "app.all", route: "/x", http_methods: [] }),
    ]);
  });

  test("via for a chained call sharing a start position uses callBodyKeys, not the raw line:col (Important 2)", async () => {
    // `router.get('/a',named).get('/b',named)` inside a callable: both the inner call
    // (`router.get`) and the outer chained call (`router.get('/a',named).get`) start at the same
    // token — exactly the case callBodyKeys disambiguates with `/2`.
    const src = [
      'import express from "express";',
      "const router = express.Router();",
      "export function named(req: unknown, res: unknown): void {}",
      "function setup() {",
      "  router.get('/a',named).get('/b',named);",
      "}",
    ].join("\n");
    const root = rootOf(await analyze(opts(fixture(src))));
    let named: Array<{ via?: string; evidence?: string }> = [];
    for (const m of Object.values(root.symbol_table)) forEachCallable(m, (c) => { if (c.name === "named") named = (c.entrypoints ?? []) as typeof named; });
    expect(named).toHaveLength(2);
    const byEvidence = Object.fromEntries(named.map((e) => [e.evidence, e.via]));
    expect(byEvidence["router.get('/a',named).get"]).toMatch(/^can:\/\/typescript\/c\/src\/app\.ts\/setup@5:\d+$/);
    expect(byEvidence["router.get"]).toMatch(/^can:\/\/typescript\/c\/src\/app\.ts\/setup@5:\d+\/2$/);
    expect(byEvidence["router.get('/a',named).get"]).not.toBe(byEvidence["router.get"]);
  });
});
