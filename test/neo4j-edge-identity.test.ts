/**
 * Relationship-identity discriminant (issue #70): a plain endpoint-pair MERGE collapses
 * legitimately-distinct edges of one type between the same two nodes — the DDG carries one edge
 * per variable (plus the prov split), and a conditional's true/false CFG_NEXT pair shares its
 * endpoints. Discriminated families MERGE on `{_k: row.k}` so each survives; undiscriminated
 * families keep the plain endpoint-pair MERGE.
 */
import { describe, expect, test } from "bun:test";
import { renderCypher } from "../src/build/neo4j";
import { RowBuilder } from "../src/build/neo4j/rows";

function twoVarDdgRows() {
  const b = new RowBuilder();
  const a = b.node(["CanNode", "TSBodyNode"], "id", "can://ts/app/f.ts/f()@1:0", {});
  const c = b.node(["CanNode", "TSBodyNode"], "id", "can://ts/app/f.ts/f()@2:0", {});
  b.edge("TS_DDG", a, c, { var: "x", prov: ["reaching-defs"] }, "x|reaching-defs");
  b.edge("TS_DDG", a, c, { var: "y", prov: ["reaching-defs"] }, "y|reaching-defs");
  b.edge("TS_CDG", a, c); // undiscriminated control family stays a plain MERGE
  return b.finish();
}

describe("edge identity discriminant (_k)", () => {
  test("per-var DDG edges between one endpoint pair both survive rendering", () => {
    const cypher = renderCypher(twoVarDdgRows(), "app");
    expect(cypher).toContain("MERGE (a)-[r:TS_DDG {_k: row.k}]->(b)");
    expect(cypher).toContain("k: 'x|reaching-defs'");
    expect(cypher).toContain("k: 'y|reaching-defs'");
  });

  test("undiscriminated families keep the plain endpoint-pair MERGE", () => {
    const cypher = renderCypher(twoVarDdgRows(), "app");
    expect(cypher).toContain("MERGE (a)-[r:TS_CDG]->(b)");
    expect(cypher).not.toContain("MERGE (a)-[r:TS_CDG {_k");
  });

  test("row model carries the discriminant only when set", () => {
    const rows = twoVarDdgRows();
    const ddg = rows.edges.filter((e) => e.type === "TS_DDG");
    const cdg = rows.edges.filter((e) => e.type === "TS_CDG");
    expect(ddg.map((e) => e.key).sort()).toEqual(["x|reaching-defs", "y|reaching-defs"]);
    expect(cdg[0].key).toBeUndefined();
    // distinct identity per (type, endpoints, key): nothing deduplicates the pair
    expect(ddg.length).toBe(2);
  });
});

test("row sorting preserves composite-key collation across prefix values", () => {
  const builder = new RowBuilder();
  const target = builder.node(["CanNode"], "id", "target", {});
  const file = builder.node(["CanNode"], "id", "file", {});
  const nested = builder.node(["CanNode"], "id", "file/<anon>", {});
  const slash = builder.node(["CanNode"], "id", "file/x", {});

  builder.edge("TS_CALLS", file, target);
  builder.edge("TS_CALLS", nested, target);
  builder.edge("TS_CALLS", slash, target);

  expect(builder.finish().edges.map((edge) => edge.from.value)).toEqual([
    "file/<anon>",
    "file/x",
    "file",
  ]);
});
