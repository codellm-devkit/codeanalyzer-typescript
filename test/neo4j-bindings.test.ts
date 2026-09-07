/**
 * #182 — import/export bindings, callable parameters and unresolved config reads reach the graph
 * (spec: docs/design/specs/neo4j-bindings-parameters-config.md, decisions D1–D5).
 *
 * D1: `resolved_module` is the checker's answer (tsconfig `paths`, directory index, `.js` → `.ts`),
 *     absent for externals, builtins and spellings that resolve to nothing.
 * D2/D3: one TS_IMPORTS / TS_RE_EXPORTS edge per (module, target) aggregating every binding;
 *     externals land on the `<app>/@external/<root>` ghost; unresolved relative spellings are
 *     dropped from the graph (they survive in JSON); `exports_json` is the lossless carrier.
 * D4: `parameters_json` is python's encoding — the list verbatim, absent when empty.
 * D5: TS_READS_CONFIG_UNRESOLVED mirrors PY_READS_CONFIG_UNRESOLVED, `_k = key|reason`.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { project } from "../src/build/neo4j";
import type { EdgeRow, GraphRows } from "../src/build/neo4j/rows";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import type { TSAnalysis, TSCallable, TSModule } from "../src/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-bindings-"));
const w = (rel: string, lines: string[]) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), lines.join("\n"));
};
w("tsconfig.json", [
  JSON.stringify({
    compilerOptions: { target: "ES2020", module: "ESNext", moduleResolution: "node", baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } },
    include: ["src/**/*.ts"],
  }),
]);
w("src/lib/util.ts", [
  "export function helper(x: number, y?: string, ...rest: unknown[]): number { return x; }",
  "export const a = 1;",
]);
w("src/models/index.ts", ["export interface User { id: string }", "export type UserId = string;", "export class Robot {}"]);
w("src/x.ts", ["export const x = 1;", "export function noargs(): void {}"]);
w("src/side.ts", ['console.log("side");']);
w("src/index.ts", [
  'import { helper, a as aa } from "@lib/util";',
  'import { Robot, type User } from "./models";',
  'import type { UserId } from "./models";',
  'import { x } from "./x.js";',
  'import "./side";',
  'import { z } from "zod";',
  'import * as fs from "node:fs";',
  'import { gone } from "./missing";',
  'export * from "./models";',
  'export { helper as help, a } from "@lib/util";',
  'export { type User as U } from "./models";',
  "const local = 1;",
  "export { local as renamed };",
  "export function main(id: UserId, u?: User): number { return helper(x, undefined, id, u, fs, z, gone, aa, new Robot()); }",
]);
const opts = { input: dir, appName: "bd", analysisLevel: 1, noBuild: true, emit: "json" } as unknown as AnalysisOptions;

const res = await analyze(opts);
const app = (res.application as TSAnalysis).application;
const mod = (key: string): TSModule => app.symbol_table[key] as TSModule;
const index = mod("src/index.ts");
const rows: GraphRows = project(res.application as TSAnalysis);
const edgesOf = (type: string, from: string): EdgeRow[] => rows.edges.filter((e) => e.type === type && e.from.value === from);
const toMap = (edges: EdgeRow[]) => new Map(edges.map((e) => [e.to.value, e]));

describe("D1 resolved_module (JSON)", () => {
  const byModule = new Map(index.imports.map((i) => [i.module, i]));
  test("tsconfig paths alias, directory index and .js → .ts all resolve to the symbol-table key", () => {
    expect(byModule.get("@lib/util")?.resolved_module).toBe("src/lib/util.ts");
    expect(byModule.get("./models")?.resolved_module).toBe("src/models/index.ts");
    expect(byModule.get("./x.js")?.resolved_module).toBe("src/x.ts");
    expect(byModule.get("./side")?.resolved_module).toBe("src/side.ts");
  });
  test("externals, builtins and a missing relative target carry no resolved_module", () => {
    expect(byModule.get("zod")?.resolved_module).toBeUndefined();
    expect(byModule.get("node:fs")?.resolved_module).toBeUndefined();
    expect(byModule.get("./missing")?.resolved_module).toBeUndefined();
    expect(byModule.has("./missing")).toBe(true); // the spelling itself survives
  });
  test("re-exports resolve; a local export list has no module and no resolution", () => {
    const star = index.exports.find((e) => e.name === "*");
    expect(star?.module).toBe("./models");
    expect(star?.resolved_module).toBe("src/models/index.ts");
    expect(index.exports.find((e) => e.name === "helper")?.resolved_module).toBe("src/lib/util.ts");
    const renamed = index.exports.find((e) => e.alias === "renamed");
    expect(renamed?.module).toBeUndefined();
    expect(renamed?.resolved_module).toBeUndefined();
  });
});

describe("D2 TS_IMPORTS", () => {
  const imports = toMap(edgesOf("TS_IMPORTS", index.id));
  test("one edge per (importer, resolved module), aggregating every binding of that pair", () => {
    const models = imports.get(mod("src/models/index.ts").id);
    expect(models?.props).toEqual({ spellings: ["./models"], imported_names: ["Robot", "User", "UserId"], type_only_names: ["User", "UserId"] });
    const util = imports.get(mod("src/lib/util.ts").id);
    expect(util?.props).toEqual({ spellings: ["@lib/util"], imported_names: ["a", "helper"], aliases: ["aa"] });
    expect(imports.get(mod("src/x.ts").id)?.props).toEqual({ spellings: ["./x.js"], imported_names: ["x"] });
    // a side-effect import has no names: the edge still records the dependency
    expect(imports.get(mod("src/side.ts").id)?.props).toEqual({ spellings: ["./side"] });
  });
  test("externals and builtins land on the @external ghost; an unresolved relative spelling is dropped", () => {
    expect(imports.get(`${app.id}/@external/zod`)?.props).toEqual({ spellings: ["zod"], imported_names: ["z"] });
    expect(imports.get(`${app.id}/@external/node:fs`)?.props).toEqual({ spellings: ["node:fs"], imported_names: ["*"], aliases: ["fs"] });
    expect([...imports.keys()].some((k) => k.includes("missing"))).toBe(false);
    expect(imports.size).toBe(6);
    const ghost = rows.nodes.find((n) => n.value === `${app.id}/@external/node:fs`);
    expect(ghost?.labels).toContain("TSExternal");
    expect(ghost?.props.module).toBe("node:fs");
  });
});

describe("D3 exports", () => {
  test("TS_RE_EXPORTS aggregates per target, star included", () => {
    const re = toMap(edgesOf("TS_RE_EXPORTS", index.id));
    expect(re.get(mod("src/models/index.ts").id)?.props).toEqual({ spellings: ["./models"], exported_names: ["*", "User"], aliases: ["U"], type_only_names: ["User"] });
    expect(re.get(mod("src/lib/util.ts").id)?.props).toEqual({ spellings: ["@lib/util"], exported_names: ["a", "helper"], aliases: ["help"] });
    expect(re.size).toBe(2);
  });
  test("exports_json is the module's exports list verbatim, absent when empty", () => {
    const node = rows.nodes.find((n) => n.value === index.id);
    const parsed = JSON.parse(node?.props.exports_json as string);
    expect(parsed).toEqual(index.exports);
    expect(parsed).toHaveLength(5);
    expect(rows.nodes.find((n) => n.value === mod("src/side.ts").id)?.props.exports_json).toBeUndefined();
  });
});

describe("D4 parameters_json", () => {
  const callable = (m: TSModule, sig: string): TSCallable => Object.values(m.functions).find((c) => c.signature.endsWith(sig)) as TSCallable;
  test("python's encoding: the parameter list verbatim", () => {
    const helper = callable(mod("src/lib/util.ts"), ".helper");
    const node = rows.nodes.find((n) => n.value === helper.id);
    const parsed = JSON.parse(node?.props.parameters_json as string);
    expect(parsed).toEqual(helper.parameters);
    expect(parsed.map((p: { name: string }) => p.name)).toEqual(["x", "y", "rest"]);
    expect(parsed[1].is_optional).toBe(true);
    expect(parsed[2].is_rest).toBe(true);
  });
  test("absent, not '[]', on a callable without parameters", () => {
    const noargs = callable(mod("src/x.ts"), ".noargs");
    expect(rows.nodes.find((n) => n.value === noargs.id)?.props.parameters_json).toBeUndefined();
  });
});

describe("D5 TS_READS_CONFIG_UNRESOLVED", () => {
  const FIXTURE = path.resolve(import.meta.dir, "fixtures/artifacts-app");
  test("one edge per distinct (callee, key, reason), keyed key|reason, from the application", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-bindings-cfg-"));
    const r = await analyze({ input: FIXTURE, appName: "art", analysisLevel: 2, noBuild: true, emit: "json", eager: true, cacheDir } as unknown as AnalysisOptions);
    fs.rmSync(cacheDir, { recursive: true, force: true });
    const a = (r.application as TSAnalysis).application;
    expect(a.config_reads.length).toBeGreaterThan(0);
    const g = project(r.application as TSAnalysis);
    const edges = g.edges.filter((e) => e.type === "TS_READS_CONFIG_UNRESOLVED");
    const triples = new Set(a.config_reads.map((c) => `${c.callee}\0${c.key ?? ""}|${c.reason}`));
    expect(edges.length).toBe(triples.size);
    for (const e of edges) {
      expect(e.from.value).toBe(a.id);
      expect(e.key).toBe(`${e.props.key ?? ""}|${e.props.reason}`);
      expect(e.props.prov).toEqual(["literal"]);
    }
    // an env-root read targets the root's ghost; the ghost is a real node this run
    const envRead = a.config_reads.find((c) => c.callee === "process.env");
    if (envRead) {
      const ghostId = `${a.id}/@external/process.env`;
      expect(edges.some((e) => e.to.value === ghostId)).toBe(true);
      expect(g.nodes.find((n) => n.value === ghostId)?.labels).toContain("TSExternal");
    }
  });
});
