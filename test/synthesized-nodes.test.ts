/**
 * Issue #13: Jelly's synthesized anonymous-callback signatures must materialize as nodes, so their
 * CALLS edges resolve instead of being silently dropped by the MATCH-based Cypher writer.
 */
import { describe, expect, test } from "bun:test";
import { project } from "../src/build/neo4j";
import { CALL_DEP, type TSApplication, type TSCallable, type TSModule } from "../src/schema";

const ANON = "src/x.foo:<3:10>";

const callable = (signature: string, name: string): TSCallable => ({ signature, name }) as unknown as TSCallable;

const app: TSApplication = {
  symbol_table: { "src/x.ts": { functions: { foo: callable("src/x.foo", "foo") } } as unknown as TSModule },
  call_graph: [{ source: "src/x.foo", target: ANON, type: CALL_DEP, weight: 1, provenance: ["jelly"], tags: {} }],
  external_symbols: {},
  synthesized_callables: { [ANON]: { name: "<anonymous>", path: "src/x.ts", start_line: 3, start_column: 10 } },
};

describe("synthesized anonymous-callable nodes", () => {
  const rows = project(app, "t");

  test("emits an :Symbol:AnonymousCallable node for the synthesized signature", () => {
    const n = rows.nodes.find((n) => n.value === ANON);
    expect(n?.labels[0]).toBe("Symbol");
    expect(n?.labels).toContain("AnonymousCallable");
    expect(n?.props.start_line).toBe(3);
  });

  test("the CALLS edge to the anonymous callable survives (was silently dropped before)", () => {
    const e = rows.edges.find((e) => e.type === "CALLS" && e.to.value === ANON);
    expect(e?.from.value).toBe("src/x.foo");
  });

  test("a DECLARES edge links the host symbol to it (keeps it in the wiped subgraph)", () => {
    const e = rows.edges.find((e) => e.type === "DECLARES" && e.to.value === ANON);
    expect(e?.from.value).toBe("src/x.foo");
    expect(e?.from.label).toBe("Symbol");
  });
});
