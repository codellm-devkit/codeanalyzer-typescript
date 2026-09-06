/**
 * Decorator identity fields (#151). `qualified_name` was documented as checker-resolved and was
 * actually ts-morph's `getFullName()` — the written text — so `import { Get as HttpGet }` emitted
 * `HttpGet` even though resolution was trivial. Now: `name` is the spelling as WRITTEN, and
 * `qualified_name` is the import-table resolution or ABSENT. Python's rule, minus the Jedi tier.
 *
 * The absent case matters as much as the resolved ones: a same-file decorator must NOT get a
 * fabricated qualified name, or the entrypoint pass's unresolved counter has nothing to count and
 * the Neo4j :TSDecorator merge collapses a local `@Get` with a library's.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { importTable, resolveWritten } from "../src/syntactic_analysis/importResolver";
import type { AnalysisOptions } from "../src/options";
import type { TSDecorator, TSImport } from "../src/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-decq-"));
fs.mkdirSync(path.join(dir, "src"));
fs.writeFileSync(
  path.join(dir, "src", "decorators.ts"),
  [
    "export function Controller(p: string): ClassDecorator { return () => undefined; }",
    "export function Get(p: string): MethodDecorator { return () => undefined; }",
  ].join("\n"),
);
fs.writeFileSync(
  path.join(dir, "src", "c.ts"),
  [
    'import { Controller, Get as HttpGet } from "./decorators";',
    'import * as http from "some-lib";',
    'import Dflt from "some-default";',
    "function Local(): ClassDecorator { return () => undefined; }",
    "@Controller('/u')",
    "@Local()",
    "export class C {",
    "  @HttpGet('/x') a(): string { return ''; }",
    "  @http.route('/y') b(): string { return ''; }",
    "  @Dflt.deco() c(): string { return ''; }",
    "}",
  ].join("\n"),
);
fs.writeFileSync(
  path.join(dir, "tsconfig.json"),
  JSON.stringify({ compilerOptions: { target: "ES2020", experimentalDecorators: true }, include: ["src/**/*.ts"] }),
);
const opts = { input: dir, appName: "dq", analysisLevel: 1, noBuild: true, emit: "json" } as unknown as AnalysisOptions;

/** Every decorator in the tree, keyed by written name. */
function allDecorators(o: unknown, out = new Map<string, TSDecorator>()): Map<string, TSDecorator> {
  if (Array.isArray(o)) for (const v of o) allDecorators(v, out);
  else if (o && typeof o === "object") {
    const rec = o as Record<string, unknown>;
    for (const d of (rec.decorators as TSDecorator[] | undefined) ?? []) out.set(d.name, d);
    for (const v of Object.values(rec)) allDecorators(v, out);
  }
  return out;
}

describe("decorator qualified_name (#151)", () => {
  test("import table maps local bindings to module-qualified prefixes", () => {
    const imports: TSImport[] = [
      { module: "@nestjs/common", name: "Get", is_type_only: false, import_kind: "named" } as TSImport,
      { module: "@nestjs/common", name: "Post", alias: "HttpPost", is_type_only: false, import_kind: "named" } as TSImport,
      { module: "some-lib", name: "*", alias: "http", is_type_only: false, import_kind: "namespace" } as TSImport,
      { module: "express", name: "express", is_type_only: false, import_kind: "default" } as TSImport,
    ];
    const t = importTable(imports);
    expect(resolveWritten(t, "Get")).toBe("@nestjs/common.Get");
    expect(resolveWritten(t, "HttpPost")).toBe("@nestjs/common.Post"); // alias mapped BACK to the export
    expect(resolveWritten(t, "http.route")).toBe("some-lib.route");
    expect(resolveWritten(t, "express.Router")).toBe("express.default.Router");
    expect(resolveWritten(t, "Local")).toBeUndefined();
    expect(resolveWritten(t, "Local.x")).toBeUndefined();
  });

  test("emits the written spelling in name and the import-table resolution in qualified_name", async () => {
    const res = await analyze(opts);
    const d = allDecorators((res.application as { application: unknown }).application);

    expect(d.get("Controller")?.qualified_name).toBe("./decorators.Controller");
    // alias: the written spelling is the alias, the resolution is the EXPORTED name
    expect(d.get("HttpGet")?.qualified_name).toBe("./decorators.Get");
    // namespace import: `name` is the full dotted spelling, not the last segment
    expect(d.has("http.route")).toBe(true);
    expect(d.has("route")).toBe(false);
    expect(d.get("http.route")?.qualified_name).toBe("some-lib.route");
    // default import used as a namespace
    expect(d.get("Dflt.deco")?.qualified_name).toBe("some-default.default.deco");
  });

  test("a same-file decorator has NO qualified_name, not a fabricated one", async () => {
    const d = allDecorators(((await analyze(opts)).application as { application: unknown }).application);
    const local = d.get("Local");
    expect(local).toBeDefined();
    expect("qualified_name" in (local as object)).toBe(false);
  });
});
