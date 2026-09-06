/**
 * Body-node and parameter ids in analysis.json (#164; python #176/#180 parity).
 *
 * Two agreement properties, each pinned against the OTHER projection rather than against a
 * hand-typed string: every body node's `id` is exactly the key the Neo4j projection merges its
 * `:TSBodyNode` on, and every `parameters[i].id` is exactly the id of the L4 `@formal_in:i`
 * vertex that carries it. If either drifted, JSON consumers would compose a key that no graph
 * node has.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { analyze } from "../src/core";
import { project } from "../src/build/neo4j";
import { forEachCallable } from "../src/schema";
import { globalOrdinal } from "../src/schema/ids";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication, TSCallable } from "../src/schema";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/dataflow-app");
const opts = (analysisLevel: number) =>
  ({ input: FIXTURE, appName: "bi", analysisLevel, eager: true, noBuild: true, emit: "json",
     graphs: ["cfg", "dfg", "pdg", "sdg"], graphFieldDepth: 3, jobs: 1, skipTests: true, phantoms: true, entrypointRules: null }) as unknown as AnalysisOptions;
const rootOf = (r: { application: unknown }) => (r.application as { application: TSApplication }).application;
const callables = (root: TSApplication): TSCallable[] => { const out: TSCallable[] = []; for (const m of Object.values(root.symbol_table)) forEachCallable(m, (c) => out.push(c)); return out; };

describe("body-node and parameter ids (#164)", () => {
  test("L1: every call node and every parameter already carries its id", async () => {
    const cs = callables(rootOf(await analyze(opts(1))));
    let bodyNodes = 0, params = 0;
    for (const c of cs) {
      for (const [k, n] of Object.entries(c.body ?? {})) { bodyNodes++; expect(n.id).toBe(globalOrdinal(c.id, k)); }
      c.parameters.forEach((p, i) => { params++; expect(p.id).toBe(`${c.id}@formal_in:${i}`); });
    }
    expect(bodyNodes).toBeGreaterThan(0);
    expect(params).toBeGreaterThan(0);
  });

  test("L3: body-node ids equal the projected :TSBodyNode merge keys, per callable", async () => {
    const res = await analyze(opts(3));
    const root = rootOf(res);
    const rows = project(res.application);
    let checked = 0;
    for (const c of callables(root)) {
      const body = Object.entries(c.body ?? {});
      if (!body.length) continue;
      const emitted = new Set(rows.nodes.filter((n) => n.labels.includes("TSBodyNode") && n.value.startsWith(`${c.id}@`)).map((n) => n.value));
      expect(new Set(body.map(([, n]) => n.id))).toEqual(emitted);
      for (const [k, n] of body) {
        expect(n.id).toBe(globalOrdinal(c.id, k));
        if (n.kind === "call" && n.callee) expect(n.id).not.toBe(n.callee); // a call's id is never its target
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  });

  test("L4: parameters[i].id names the @formal_in:i vertex, in list order, and the vertex agrees", async () => {
    const cs = callables(rootOf(await analyze(opts(4))));
    let withVertices = 0;
    for (const fn of cs) {
      fn.parameters.forEach((p, i) => {
        expect(p.id).toBe(`${fn.id}@formal_in:${i}`);
        const vertex = fn.body?.[`@formal_in:${i}`];
        if (!vertex) return; // L4 only materialises formal_in for callables with a CFG
        expect(vertex.id).toBe(p.id);
        expect(vertex.of).toBe(p.name);
        withVertices++;
      });
    }
    expect(withVertices).toBeGreaterThan(0);
  });
});
