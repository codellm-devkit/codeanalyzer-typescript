/**
 * Entrypoint contract (#153, unit 1 of #72): the fields exist at every -a before any detector does.
 *
 * Three properties, none of which a "fields are present" check would catch on its own: they are
 * stamped on CLASSES and callables but never on interfaces/enums (python stamps PyClass); they are
 * identical across levels AND across a warm cache, because the pass is per-run like heritage and
 * the cached tree deliberately lacks them; and the Neo4j report is sorted-key JSON so it diffs
 * against python's.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { project } from "../src/build/neo4j";
import { NODE_LABELS } from "../src/build/neo4j/schema";
import { forEachCallable, forEachType } from "../src/schema";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication } from "../src/schema";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-ep-"));
fs.mkdirSync(path.join(dir, "src"));
fs.writeFileSync(
  path.join(dir, "src", "a.ts"),
  [
    "export interface Shape { area(): number; }",
    "export enum Kind { A, B }",
    "export class Circle implements Shape { area(): number { return helper(1); } }",
    "export function helper(x: number): number { return x * 2; }",
    "export const top = helper(3);",
  ].join("\n"),
);
fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020" }, include: ["src/**/*.ts"] }));

const opts = (analysisLevel: number, eager: boolean) =>
  ({
    input: dir, appName: "ep", analysisLevel, eager, noBuild: true, emit: "json",
    graphs: ["cfg", "dfg", "pdg", "sdg"], graphFieldDepth: 3, jobs: 1, skipTests: true, phantoms: true,
  }) as unknown as AnalysisOptions;

const rootOf = (r: { application: unknown }) => (r.application as { application: TSApplication }).application;

/** Every stamped entrypoint field, keyed by id — what must be invariant across levels. */
function stamped(root: TSApplication): Record<string, unknown> {
  const out: Record<string, unknown> = { __report: root.entrypoint_report };
  for (const mod of Object.values(root.symbol_table)) {
    forEachCallable(mod, (c) => { out[c.id] = { entrypoints: c.entrypoints, is_entrypoint: c.is_entrypoint }; });
    forEachType(mod, (t) => { out[t.id] = { kind: t.kind, entrypoints: t.entrypoints, is_entrypoint: t.is_entrypoint }; });
  }
  return out;
}

describe("entrypoint contract (unit 1)", () => {
  test("classes and callables carry the empty fields; interfaces and enums carry neither", async () => {
    const root = rootOf(await analyze(opts(1, true)));
    const s = stamped(root);
    const byKind = (k: string) => Object.values(s).filter((v) => (v as { kind?: string }).kind === k) as Array<Record<string, unknown>>;

    for (const c of byKind("class")) expect(c).toMatchObject({ entrypoints: [], is_entrypoint: false });
    for (const i of [...byKind("interface"), ...byKind("enum")]) {
      expect("is_entrypoint" in i && i.is_entrypoint !== undefined).toBe(false);
      expect(i.entrypoints).toBeUndefined();
    }
    // callables — including the module-scope <anon> and the implicit ones — all stamped
    const callables = Object.entries(s).filter(([k, v]) => k !== "__report" && !("kind" in (v as object)));
    expect(callables.length).toBeGreaterThan(1);
    for (const [, v] of callables) expect(v).toEqual({ entrypoints: [], is_entrypoint: false });
  });

  test("the report is present and empty at the root", async () => {
    const root = rootOf(await analyze(opts(1, true)));
    expect(root.entrypoint_report).toEqual({ frameworks_detected: [], rulesets: ["shipped"], unresolved: {}, errors: [] });
  });

  test("identical at every -a, including across a warm cache", async () => {
    // L1 cold, then L2-L4 warm: the cached tree lacks these fields, so this is what proves the pass
    // re-stamps per run rather than relying on the builder.
    const l1 = stamped(rootOf(await analyze(opts(1, true))));
    for (const level of [2, 3, 4]) {
      expect(stamped(rootOf(await analyze(opts(level, false))))).toEqual(l1);
    }
  });

  test("Neo4j: report on the application node, flags on class and callable, nothing on interface", async () => {
    const res = await analyze(opts(1, true));
    const rows = project(res.application);
    const app = rows.nodes.find((n) => n.labels.includes("TSApplication"));
    expect(app?.props.entrypoint_frameworks).toEqual([]);
    expect(app?.props.entrypoint_report_json).toBe('{"errors":[],"frameworks_detected":[],"rulesets":["shipped"],"unresolved":{}}');

    const cls = rows.nodes.find((n) => n.labels.includes("TSClass"));
    expect(cls?.props).toMatchObject({ is_entrypoint: false, entrypoint_frameworks: [] });
    const fn = rows.nodes.find((n) => n.labels.includes("TSCallable"));
    expect(fn?.props).toMatchObject({ is_entrypoint: false, entrypoint_frameworks: [] });
    const iface = rows.nodes.find((n) => n.labels.includes("TSInterface"));
    expect(iface).toBeDefined();
    expect("is_entrypoint" in (iface?.props ?? {})).toBe(false);
  });

  test("declared in the schema contract on exactly the labels that carry them", () => {
    const has = (label: string, prop: string) => prop in (NODE_LABELS.find((n) => n.label === label)?.properties ?? {});
    expect(has("TSApplication", "entrypoint_report_json")).toBe(true);
    expect(has("TSApplication", "entrypoint_frameworks")).toBe(true);
    expect(has("TSClass", "is_entrypoint")).toBe(true);
    expect(has("TSCallable", "is_entrypoint")).toBe(true);
    expect(has("TSInterface", "is_entrypoint")).toBe(false);
    expect(has("TSEnum", "is_entrypoint")).toBe(false);
  });
});
