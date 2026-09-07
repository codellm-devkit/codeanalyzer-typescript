/**
 * #177 — declaration merging mints one id per FACET (spec: docs/design/specs/declaration-merging-ids.md).
 *
 * Value facets keep the bare id; a type sharing a value's name becomes `<id>#type`; a later type
 * facet of a type/type merge is keyed `Name#<kind>` in `types{}` and gets `<id>#<kind>`. Ids only
 * move on collision, heritage resolves to the right facet, and the graph never carries two kind
 * labels on one node.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { project } from "../src/build/neo4j";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import type { TSAnalysis, TSModule } from "../src/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-merge-"));
fs.mkdirSync(path.join(dir, "src"));
fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020" }, include: ["src/**/*.ts"] }));
fs.writeFileSync(path.join(dir, "src", "m.ts"), [
  "export const TableOption = () => 1;",
  "export interface TableOption { a: string }",
  "export type Dyn = string;",
  "export const Dyn = () => 2;",
  'export type TG = "d";',
  "export const TG = 3;",
  "export class C { m(): number { return 1; } }",
  "export interface C { x: number }",
  "export function f(): void {}",
  "export namespace f { export const y = 1; }",
  "export class D implements TableOption { a = 'x'; }",
  "export class E extends C {}",
  "export class Plain {}",
].join("\n"));

const opts = { input: dir, appName: "dm", analysisLevel: 2, noBuild: true, emit: "json", eager: true } as unknown as AnalysisOptions;
const res = await analyze(opts);
const app = res.application as TSAnalysis;
const mod = app.application.symbol_table["src/m.ts"] as TSModule;
const M = mod.id;

describe("#177 declaration merging", () => {
  test("value facets keep the bare id; the colliding type facet is #type", () => {
    expect(mod.functions.TableOption!.id).toBe(`${M}/TableOption`);
    expect(mod.types.TableOption!.id).toBe(`${M}/TableOption#type`);
    expect(mod.types.TableOption!.kind).toBe("interface");
    expect(mod.functions.Dyn!.id).toBe(`${M}/Dyn`);
    expect(mod.types.Dyn!.id).toBe(`${M}/Dyn#type`);
    expect(mod.fields.TG!.id).toBe(`${M}/TG`);
    expect(mod.types.TG!.id).toBe(`${M}/TG#type`);
    expect(mod.functions.f!.id).toBe(`${M}/f`);
    expect(mod.types.f!.id).toBe(`${M}/f#type`);
    expect(mod.types.f!.kind).toBe("namespace");
  });

  test("type/type merging keeps BOTH facets: the later kind is keyed and suffixed by its kind", () => {
    expect(mod.types.C!.kind).toBe("class");
    expect(mod.types.C!.id).toBe(`${M}/C`);
    expect(mod.types["C#interface"]!.kind).toBe("interface");
    expect(mod.types["C#interface"]!.id).toBe(`${M}/C#interface`);
    // the class facet's members hang off the bare id
    expect(Object.values(mod.types.C!.callables!)[0]!.id).toBe(`${M}/C/m`);
  });

  test("ids move only on collision; signatures never move", () => {
    expect(mod.types.Plain!.id).toBe(`${M}/Plain`);
    expect(mod.types.TableOption!.signature).toBe("src/m.TableOption");
    expect(mod.functions.TableOption!.signature).toBe("src/m.TableOption");
    expect(res.collisions).toEqual([]);
  });

  test("heritage resolves to the right facet", () => {
    expect(mod.types.D!.implements_ids).toEqual([`${M}/TableOption#type`]);
    expect(mod.types.E!.extends_ids).toEqual([`${M}/C`]);
  });

  test("the graph has one node per facet, kind and labels agreeing", () => {
    const rows = project(app);
    const kindLabels = (labels: string[]) => labels.filter((l) => l.startsWith("TS") && l !== "TSCanNode" && l !== "TSAnonymousCallable");
    for (const n of rows.nodes) expect(kindLabels(n.labels).length, `${n.value} ${n.labels.join(":")}`).toBeLessThanOrEqual(1);
    const by = (id: string) => rows.nodes.find((n) => n.value === id)!;
    expect(kindLabels(by(`${M}/TableOption`).labels)).toEqual(["TSCallable"]);
    expect(kindLabels(by(`${M}/TableOption#type`).labels)).toEqual(["TSInterface"]);
    expect(by(`${M}/TableOption#type`).props.kind).toBe("interface");
    expect(kindLabels(by(`${M}/C`).labels)).toEqual(["TSClass"]);
    expect(kindLabels(by(`${M}/C#interface`).labels)).toEqual(["TSInterface"]);
    expect(kindLabels(by(`${M}/TG`).labels)).toEqual(["TSField"]);
    expect(kindLabels(by(`${M}/TG#type`).labels)).toEqual(["TSTypeAlias"]);
    // both facets are declared by the module
    const declared = rows.edges.filter((e) => e.type === "TS_DECLARES" && e.from.value === M).map((e) => e.to.value);
    expect(declared).toContain(`${M}/C`);
    expect(declared).toContain(`${M}/C#interface`);
  });
});
