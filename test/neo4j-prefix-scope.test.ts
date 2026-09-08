/**
 * Prefix scoping of destructive Neo4j statements (#140), no container needed. The container
 * suite proves the behaviour against a live store; this pins the pieces it is built from: the
 * helper that produces the prefix, the marker-label injection, `_module` never reaching a row's
 * props, and the shape of every destructive statement.
 *
 * With the application outermost, ONE prefix (`can://<app>/`) spans both language namespaces, so
 * every destructive statement is one statement anchored on one marker.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { analyze } from "../src/core";
import { EAGER_PURGE } from "../src/build/neo4j/bolt";
import { project, renderCypher, MARKER_LABELS } from "../src/build/neo4j";
import { RowBuilder, applicationPrefix, descendantPrefix, markersFor } from "../src/build/neo4j/rows";
import type { AnalysisOptions } from "../src/options";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/sample-app");
const opts = { input: FIXTURE, appName: "ps", analysisLevel: 1, eager: true, noBuild: true, emit: "neo4j", entrypointRules: null } as unknown as AnalysisOptions;

describe("can:// prefix scoping (#140)", () => {
  test("one /-terminated application prefix; anything that is not a bare app id is refused", () => {
    expect(applicationPrefix("can://app")).toBe("can://app/");
    expect(descendantPrefix("can://app/typescript/src/a.ts")).toBe("can://app/typescript/src/a.ts/");
    // A deeper id would silently narrow the scope to a subtree, so it is refused too.
    for (const bad of [null, undefined, "", "can://", "can://app/typescript", "app"]) {
      expect(() => applicationPrefix(bad as never)).toThrow(/refusing a destructive statement/);
    }
  });

  test("one marker spans every can:// id, artifacts included; JSCanNode rides along", () => {
    expect(markersFor("can://app/typescript/src/a.ts/f")).toEqual(["TSCanNode"]);
    expect(markersFor("can://app/javascript/src/a.js/f")).toEqual(["TSCanNode", "JSCanNode"]);
    // Artifacts and their config keys are marked, so the wipe reaches them: an unmarked artifact
    // is unreachable by every destructive statement and accumulates forever. The polyglot cost is
    // measured in artifacts.test.ts, not assumed here.
    expect(markersFor("can://app/artifact/package.json")).toEqual(["TSCanNode"]);
    expect(markersFor("can://app/artifact/.env@key/PAYMENT_HOST")).toEqual(["TSCanNode"]);
    // A node keyed on its own natural identity (:Package purl, :TSDecorator name) is never marked.
    expect(markersFor("pkg:npm/express")).toEqual([]);
    expect(markersFor("Get")).toEqual([]);
    // The language is read POSITIONALLY (segment 2), so an app NAMED after a language still works.
    expect(markersFor("can://javascript/typescript/src/a.ts/f")).toEqual(["TSCanNode"]);
    expect(markersFor("can://typescript/javascript/src/a.js/f")).toEqual(["TSCanNode", "JSCanNode"]);
  });

  test("RowBuilder lifts _module off the row and adds the markers for id-keyed can:// nodes", () => {
    const b = new RowBuilder();
    b.node(["CanNode", "TSCallable"], "id", "can://app/typescript/src/a.ts/f", { id: "x", _module: "src/a.ts", name: "f" });
    b.node(["CanNode", "TSCallable"], "id", "can://app/javascript/src/b.js/g", { id: "y", _module: "src/b.js", name: "g" });
    b.node(["Artifact"], "id", "can://app/artifact/package.json", { id: "z", path: "package.json" });
    b.node(["Package"], "id", "pkg:npm/express", { id: "pkg:npm/express", name: "express" });
    b.node(["TSDecorator"], "name", "Get", { name: "Get" });
    const rows = b.finish();
    const byValue = new Map(rows.nodes.map((n) => [n.value, n]));
    const ts = byValue.get("can://app/typescript/src/a.ts/f")!;
    expect(ts.labels).toEqual(["CanNode", "TSCallable", "TSCanNode"]);
    expect(ts.module).toBe("src/a.ts");
    expect("_module" in ts.props).toBe(false);
    expect(byValue.get("can://app/javascript/src/b.js/g")!.labels).toEqual(["CanNode", "TSCallable", "TSCanNode", "JSCanNode"]);
    expect(byValue.get("can://app/artifact/package.json")!.labels).toEqual(["Artifact", "TSCanNode"]);
    expect(byValue.get("pkg:npm/express")!.labels).toEqual(["Package"]);
    expect(byValue.get("Get")!.labels).toEqual(["TSDecorator"]);
  });

  test("a real projection: no row carries _module; every node under the app prefix carries TSCanNode", async () => {
    const rows = project((await analyze(opts)).application);
    expect(rows.nodes.some((n) => "_module" in n.props)).toBe(false);
    const owned = rows.nodes.filter((n) => n.value.startsWith("can://ps/"));
    expect(owned.length).toBeGreaterThan(10);
    // No can:// row is left unmarked, so no row is beyond the reach of the scoped delete.
    for (const n of owned) expect(n.labels).toContain("TSCanNode");
    expect(rows.nodes.filter((n) => n.module !== undefined).length).toBeGreaterThan(10);
    expect([...MARKER_LABELS]).toEqual(["TSCanNode", "JSCanNode"]);
  });

  test("every can:// node the projection emits sits under the one application prefix", async () => {
    // The property the flip exists for: one prefix reaches everything, in either namespace.
    const rows = project((await analyze(opts)).application);
    const can = rows.nodes.filter((n) => n.keyProp === "id" && n.value.startsWith("can://"));
    expect(can.length).toBeGreaterThan(10);
    for (const n of can) {
      expect(n.value === "can://ps" || n.value.startsWith("can://ps/")).toBe(true);
      expect(n.value.startsWith("can://typescript/")).toBe(false);
      expect(n.value.startsWith("can://javascript/")).toBe(false);
      expect(n.value.startsWith("can://artifact/")).toBe(false);
    }
  });

  test("two applications project as two distinct roots", async () => {
    // The multi-service failure mode. :Application already merges on `id` rather than on the
    // free-text --app-name, so this holds by construction — pinned here against regression, and
    // because the root's id is now the prefix every other id in the projection is scoped by.
    const a = project((await analyze({ ...opts, appName: "svc-quotes" })).application);
    const b = project((await analyze({ ...opts, appName: "svc-orders" })).application);
    const rootOf = (rows: ReturnType<typeof project>) => rows.nodes.find((n) => n.labels[0] === "Application")!;
    expect(rootOf(a).keyProp).toBe("id");
    expect(rootOf(a).value).toBe("can://svc-quotes");
    expect(rootOf(b).value).toBe("can://svc-orders");
    expect(rootOf(a).value).not.toBe(rootOf(b).value);
    // The root carries the index anchor, so the prefix-scoped delete can reach its subtree.
    expect(rootOf(a).labels).toContain("TSCanNode");
    // Neither application's prefix reaches the other's nodes.
    for (const n of b.nodes) expect(n.value.startsWith("can://svc-quotes/")).toBe(false);
  });

  test("every destructive statement anchors on a marker and a /-terminated prefix", async () => {
    expect(EAGER_PURGE).toMatch(/^MATCH \(n:TSCanNode\) WHERE n\.id STARTS WITH \$prefix/);
    expect(EAGER_PURGE).not.toContain("_module");
    const cypher = renderCypher(project((await analyze(opts)).application), "ps");
    // the snapshot wipe: ONE marker-scoped delete on a /-terminated prefix, then the app by equality
    expect(cypher).toContain("MATCH (x:TSCanNode) WHERE x.id STARTS WITH 'can://ps/' DETACH DELETE x;");
    expect(cypher).toContain("MATCH (a:Application {id: 'can://ps'}) DETACH DELETE a;");
    expect(cypher).not.toContain("JSCanNode) WHERE");
    expect(cypher).not.toContain("_module");
  });
});
