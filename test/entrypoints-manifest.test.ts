import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { entrypointsFromManifest } from "../src/entrypoints/matching";
import { loadRules } from "../src/entrypoints/rules";
import type { AnalysisOptions } from "../src/options";
import type { AnalysisInternal, TSApplication } from "../src/schema";
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

  // Important 1 (unit 5 review): `--no-artifact-text` stores `source: ""` on the artifact record,
  // not absence — `manifestOf`'s old `??` fallback treated "" as present and never fell through to
  // disk, silently disabling this whole tier. Same fixture/assertion as the first test above, run
  // with text capture off.
  test("--no-artifact-text still resolves the manifest tier via the disk fallback", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "x", main: "dist/index.js", bin: { cli: "./dist/cli.js" } }),
      "src/index.ts": "export function boot(): void {}\nboot();\nconsole.log('x');",
      "src/cli.ts": "import { boot } from './index';\nfunction run(): void { boot(); }\nrun();",
      "src/lib.ts": "export function unused(): void {}",
    });
    const root = rootOf(await analyze(opts(dir, { artifactText: false })));
    const eps = collect(root);
    expect(eps.boot).toEqual([{ framework: "manifest", confidence: "declared", rule: "manifest.main", ruleset: "shipped",
      evidence: "package.json#main", http_methods: [], via: expect.stringMatching(/src\/index\.ts$/) }]);
  });

  // Minor 3: a manifest that exists but fails to parse is counted, not silently dropped.
  test("a malformed package.json is counted as unresolved, and the pass otherwise completes", async () => {
    const dir = fixture({ "package.json": "{ not json", "src/a.ts": "export const x = 1;" });
    const root = rootOf(await analyze(opts(dir)));
    expect(root.entrypoint_report.unresolved).toEqual({ "package.json": 1 });
    expect(root.entrypoint_report.errors).toEqual([]);
  });

  // Amendment (noRepoSections doesn't exist on this branch): call entrypointsFromManifest directly
  // to exercise the disk-fallback path used when the artifact layer hasn't captured package.json.
  // Uses `res.internal` (the live tree) rather than the wire application: `call_sites` is
  // INTERNAL and stripped from the wire clone (src/schema/emit.ts `stripInternal`) — a
  // module-scope call has no `body{}` home to survive onto the wire at all.
  test("entrypointsFromManifest resolves main directly, independent of the artifact layer", async () => {
    const dir = fixture({ "package.json": JSON.stringify({ name: "x", main: "src/index.ts" }), "src/index.ts": "export function boot(): void {}\nboot();" });
    const res = await analyze(opts(dir));
    const app = { symbol_table: res.internal.symbol_table, artifacts: {} } as unknown as AnalysisInternal;
    const rules = loadRules([]);
    const unresolved = new Map<string, number>();
    const records = entrypointsFromManifest(app, dir, rules.manifest, (k) => unresolved.set(k, (unresolved.get(k) ?? 0) + 1));
    expect(records.some((r) => r.target.name === "boot" && r.ep.rule === "manifest.main")).toBe(true);
  });
});
