/**
 * Issue #13 (schema v2): Jelly's synthesized anonymous-callback signatures must materialize as
 * graph nodes so their CALLS edges resolve instead of being silently dropped by the MATCH-based
 * Cypher writer. Under v2 they are homed as `:CanNode:TSAnonymousCallable` nodes with an ordinal
 * `<enclosing-callable-id>@<line>:<col>` id, and the call graph references that id.
 */
import { describe, expect, test } from "bun:test";
import { project } from "../src/build/neo4j";
import type { AnalysisOptions } from "../src/options";
import { CALL_DEP, type AnalysisInternal, type TSCallable, type TSModule, type TSSpan, finalizeAnalysis } from "../src/schema";

const ANON = "src/x.foo:<3:10>";
const SPAN: TSSpan = { start: [1, 1], end: [5, 1], bytes: [0, 10] };

const callable = (signature: string, name: string): TSCallable =>
  ({ signature, name, kind: "function", span: SPAN, parameters: [], call_sites: [], inner_callables: {}, inner_classes: {} }) as unknown as TSCallable;

const app: AnalysisInternal = {
  symbol_table: {
    "src/x.ts": {
      module_name: "src/x", source: "", span: SPAN,
      functions: { "src/x.foo": callable("src/x.foo", "foo") },
      classes: {}, interfaces: {}, enums: {}, type_aliases: {}, namespaces: {}, variables: [],
    } as unknown as TSModule,
  },
  call_graph: [{ source: "src/x.foo", target: ANON, type: CALL_DEP, weight: 1, provenance: ["defuse"], tags: {} }],
  external_symbols: {},
  synthesized_callables: { [ANON]: { name: "<anonymous>", path: "src/x.ts", start_line: 3, start_column: 10 } },
};

const opts = { appName: "t", input: "", analysisLevel: 2 } as unknown as AnalysisOptions;
const { application, idBySig } = finalizeAnalysis(app, null, opts);
const rows = project(application);

const fooId = idBySig.get("src/x.foo") as string;
const anonId = idBySig.get(ANON) as string;

describe("synthesized anonymous-callable nodes (schema v2)", () => {
  test("the anonymous callback is homed as an ordinal id under its enclosing callable", () => {
    expect(anonId).toBe(`${fooId}@3:10`);
  });

  test("emits a :CanNode:TSAnonymousCallable node for it", () => {
    const n = rows.nodes.find((n) => n.value === anonId);
    expect(n?.labels[0]).toBe("CanNode");
    expect(n?.labels).toContain("TSAnonymousCallable");
    expect(n?.props.start_line).toBe(3);
  });

  test("the CALLS edge to the anonymous callable resolves (was silently dropped before)", () => {
    const e = rows.edges.find((e) => e.type === "TS_CALLS" && e.to.value === anonId);
    expect(e?.from.value).toBe(fooId);
  });
});
