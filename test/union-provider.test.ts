/**
 * Unit tests for the union merge (issue #11): tsc + jelly edges and external symbols must be
 * combined — not discarded — with provenance preserved so consumers can still tell them apart.
 */
import { describe, expect, test } from "bun:test";
import type { CallGraphResult } from "../src/semantic_analysis";
import { mergeCallGraphs } from "../src/semantic_analysis";
import { CALL_DEP, type TSCallEdge } from "../src/schema";

const edge = (source: string, target: string, provenance: string[], extra: Partial<TSCallEdge> = {}): TSCallEdge => ({
  source,
  target,
  type: CALL_DEP,
  weight: 1,
  provenance,
  tags: {},
  ...extra,
});

const result = (edges: TSCallEdge[], external: CallGraphResult["external_symbols"] = {}): CallGraphResult => ({
  edges,
  external_symbols: external,
});

describe("mergeCallGraphs", () => {
  test("keeps jelly-only edges (the bug: they used to be dropped)", () => {
    const tsc = result([edge("a", "b", ["tsc"])]);
    const jelly = result([edge("c", "d", ["jelly"])]);
    const merged = mergeCallGraphs(tsc, jelly);
    const keys = merged.edges.map((e) => `${e.source}->${e.target}`).sort();
    expect(keys).toEqual(["a->b", "c->d"]);
  });

  test("an edge found by both carries both provenances and summed weight", () => {
    const tsc = result([edge("a", "b", ["tsc"], { weight: 2 })]);
    const jelly = result([edge("a", "b", ["jelly"], { weight: 3 })]);
    const merged = mergeCallGraphs(tsc, jelly);
    expect(merged.edges).toHaveLength(1);
    expect(merged.edges[0].provenance.sort()).toEqual(["jelly", "tsc"]);
    expect(merged.edges[0].weight).toBe(5);
  });

  test("merges external symbols from both, tsc winning on conflict", () => {
    const tsc = result([], { "pkg.foo": { name: "foo", module: "pkg" } });
    const jelly = result([], {
      "pkg.foo": { name: "FOO-jelly", module: "pkg" },
      "pkg.bar": { name: "bar", module: "pkg" },
    });
    const merged = mergeCallGraphs(tsc, jelly);
    expect(Object.keys(merged.external_symbols).sort()).toEqual(["pkg.bar", "pkg.foo"]);
    expect(merged.external_symbols["pkg.foo"].name).toBe("foo"); // base (tsc) wins
  });

  test("does not mutate the input results", () => {
    const tsc = result([edge("a", "b", ["tsc"])]);
    const jelly = result([edge("a", "b", ["jelly"])]);
    mergeCallGraphs(tsc, jelly);
    expect(tsc.edges[0].provenance).toEqual(["tsc"]);
    expect(tsc.edges[0].weight).toBe(1);
  });
});
