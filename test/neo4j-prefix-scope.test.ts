/**
 * Prefix scoping of destructive Neo4j statements (#140), no container needed. The container
 * suite proves the behaviour against a live store; this pins the pieces it is built from: the
 * helpers that produce the prefixes, the marker-label injection, `_module` never reaching a row's
 * props, and the shape of every destructive statement.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { analyze } from "../src/core";
import { EAGER_PURGE, EAGER_PURGE_JS } from "../src/build/neo4j/bolt";
import { project, renderCypher, MARKER_LABELS } from "../src/build/neo4j";
import { RowBuilder, applicationPrefixes, descendantPrefix, markerFor } from "../src/build/neo4j/rows";
import type { AnalysisOptions } from "../src/options";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/sample-app");
const opts = { input: FIXTURE, appName: "ps", analysisLevel: 1, eager: true, noBuild: true, emit: "neo4j", entrypointRules: null } as unknown as AnalysisOptions;

describe("can:// prefix scoping (#140)", () => {
  test("prefixes are /-terminated per namespace, and an empty application is refused", () => {
    expect(applicationPrefixes("can://typescript/app")).toEqual({ ts: "can://typescript/app/", js: "can://javascript/app/" });
    expect(descendantPrefix("can://typescript/app/src/a.ts")).toBe("can://typescript/app/src/a.ts/");
    for (const bad of [null, undefined, "", "can://typescript/", "can://javascript/app", "app"]) {
      expect(() => applicationPrefixes(bad as never)).toThrow(/refusing a destructive statement/);
    }
  });

  test("the marker follows the id's namespace; ids outside both get none", () => {
    expect(markerFor("can://typescript/app/src/a.ts/f")).toBe("TSCanNode");
    expect(markerFor("can://javascript/app/src/a.js/f")).toBe("JSCanNode");
    expect(markerFor("can://artifact/app/package.json")).toBeNull();
    expect(markerFor("Get")).toBeNull();
  });

  test("RowBuilder lifts _module off the row and adds the marker for id-keyed can:// nodes", () => {
    const b = new RowBuilder();
    b.node(["CanNode", "TSCallable"], "id", "can://typescript/app/src/a.ts/f", { id: "x", _module: "src/a.ts", name: "f" });
    b.node(["CanNode", "TSCallable"], "id", "can://javascript/app/src/b.js/g", { id: "y", _module: "src/b.js", name: "g" });
    b.node(["Artifact"], "id", "can://artifact/app/package.json", { id: "z", path: "package.json" });
    b.node(["TSDecorator"], "name", "Get", { name: "Get" });
    const rows = b.finish();
    const byValue = new Map(rows.nodes.map((n) => [n.value, n]));
    const ts = byValue.get("can://typescript/app/src/a.ts/f")!;
    expect(ts.labels).toEqual(["CanNode", "TSCallable", "TSCanNode"]);
    expect(ts.module).toBe("src/a.ts");
    expect("_module" in ts.props).toBe(false);
    expect(byValue.get("can://javascript/app/src/b.js/g")!.labels).toContain("JSCanNode");
    expect(byValue.get("can://artifact/app/package.json")!.labels).toEqual(["Artifact"]);
    expect(byValue.get("Get")!.labels).toEqual(["TSDecorator"]);
  });

  test("a real projection: no row carries _module; every can://typescript node carries TSCanNode", async () => {
    const rows = project((await analyze(opts)).application);
    expect(rows.nodes.some((n) => "_module" in n.props)).toBe(false);
    const ts = rows.nodes.filter((n) => n.value.startsWith("can://typescript/"));
    expect(ts.length).toBeGreaterThan(10);
    for (const n of ts) expect(n.labels).toContain("TSCanNode");
    expect(rows.nodes.filter((n) => n.module !== undefined).length).toBeGreaterThan(10);
    expect([...MARKER_LABELS]).toEqual(["TSCanNode", "JSCanNode"]);
  });

  test("every destructive statement anchors on a marker and a /-terminated prefix", async () => {
    for (const stmt of [EAGER_PURGE, EAGER_PURGE_JS]) {
      expect(stmt).toMatch(/^MATCH \(n:(TS|JS)CanNode\) WHERE n\.id STARTS WITH \$prefix/);
      expect(stmt).not.toContain("_module");
    }
    const cypher = renderCypher(project((await analyze(opts)).application), "ps");
    // the snapshot wipe: two marker-scoped deletes on /-terminated prefixes, then the app node by equality
    expect(cypher).toContain("MATCH (x:TSCanNode) WHERE x.id STARTS WITH 'can://typescript/ps/' DETACH DELETE x;");
    expect(cypher).toContain("MATCH (x:JSCanNode) WHERE x.id STARTS WITH 'can://javascript/ps/' DETACH DELETE x;");
    expect(cypher).toContain("MATCH (a:Application {id: 'can://typescript/ps'}) DETACH DELETE a;");
    expect(cypher).not.toContain("_module");
  });
});
