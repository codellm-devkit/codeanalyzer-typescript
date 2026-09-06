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
  frameworks: { nestjs: { name: "nestjs", detect: ["@nestjs/common"], decorators: [], bases: [], files: [], calls: [] },
                celery: { name: "celery", detect: ["celery"], decorators: [], bases: [], files: [], calls: [] } },
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
    const rules: RuleSet = { ...EMPTY_RULES, frameworks: { flask: { name: "flask", detect: ["Flask"], decorators: [], bases: [], files: [], calls: [] } } };
    const app = { symbol_table: { "a.ts": { imports: [{ module: "flask", name: "Flask", is_type_only: false, import_kind: "named" }] } }, dependencies: [] } as never;
    expect([...detectedFrameworks(app, rules)]).toEqual(["flask"]);
  });

  test("the report records frameworks_detected and an unresolved decorator/base counter", async () => {
    const dir = fixture({
      "src/a.ts": [
        'import { Controller } from "unknown-lib";',
        "declare const Mystery: any;",
        "@Controller('/u') @Mystery() export class A extends Unknowable {}",
        "export class B extends Error {}",           // builtin: nameable, not counted
        "export class Local {}",
        "export class C extends Local {}",           // declared in module: not counted
      ].join("\n"),
    });
    const root = rootOf(await analyze(opts(dir)));
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
