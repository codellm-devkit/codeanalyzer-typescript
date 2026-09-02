import { describe, expect, test } from "bun:test";
import { EAGER_PURGE, shouldForceFullUpsert } from "../src/build/neo4j/bolt";

describe("bolt version gate (#68)", () => {
  test("mismatch or absent stored version forces a full upsert", () => {
    expect(shouldForceFullUpsert("1.1.0", "2.0.0")).toBe(true);
    expect(shouldForceFullUpsert(null, "2.0.0")).toBe(true);
    expect(shouldForceFullUpsert("2.0.0", "2.0.0")).toBe(false);
  });
});

describe("--eager purge is scoped to this analyzer AND this app (#116)", () => {
  // The statement this replaces was `MATCH (n) WHERE n._module IS NOT NULL AND NOT n:CanNode
  // DETACH DELETE n`, deliberately unanchored so it would reach pre-2.0.0 nodes. But
  // codeanalyzer-python and codeanalyzer-java both set `_module` and neither applies `:CanNode`,
  // so that predicate described THEIR nodes exactly: pointing cants at a shared database deleted
  // the python and java graphs. It only failed loudly because the delete exhausted transaction
  // memory and rolled back.
  test("anchors on :CanNode, so a sibling analyzer's nodes can never match", () => {
    expect(EAGER_PURGE).toContain("MATCH (n:CanNode)");
    // The lethal shape: reaching nodes by the ABSENCE of our own marker.
    expect(EAGER_PURGE).not.toContain("NOT n:CanNode");
    expect(EAGER_PURGE).not.toContain("_module IS NOT NULL");
  });

  test("anchors on the application id, so another app in the same database survives", () => {
    expect(EAGER_PURGE).toContain("n.id STARTS WITH $prefix");
  });

  test("deletes in batches — one transaction over a whole app exhausts the memory cap", () => {
    expect(EAGER_PURGE).toContain("IN TRANSACTIONS OF");
  });
});
