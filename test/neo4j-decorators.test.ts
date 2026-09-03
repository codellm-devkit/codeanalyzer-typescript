/**
 * Decorator projection (#82), mirroring python's `_project_decorator`. Decorators were captured in
 * the JSON as structured `TSDecorator` from the start but never reached Neo4j, so a query could
 * see `@Controller` in analysis.json and not in the graph.
 *
 * Two properties matter and neither is obvious from the row count: the decorator NODE is shared
 * (`@Get("/")` and `@Get("/:id")` are one node, merged on the resolved name), and the ARGUMENTS
 * are per-application, so they ride on the relationship rather than the node.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { project, renderCypher } from "../src/build/neo4j";
import { NODE_LABELS, REL_TYPES } from "../src/build/neo4j/schema";
import type { AnalysisOptions } from "../src/options";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-dec-"));
fs.mkdirSync(path.join(dir, "src"));
fs.writeFileSync(
  path.join(dir, "src", "a.ts"),
  [
    "function Controller(prefix: string): ClassDecorator { return () => undefined; }",
    "function Get(path: string): MethodDecorator { return () => undefined; }",
    "function Column(opts: { nullable: boolean }): PropertyDecorator { return () => undefined; }",
    "@Controller('/users')",
    "export class UserController {",
    "  @Column({ nullable: true }) name: string = '';",
    "  @Get('/:id') show(): string { return ''; }",
    "  @Get('/') list(): string { return ''; }",
    "}",
  ].join("\n"),
);
fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020", experimentalDecorators: true }, include: ["src/**/*.ts"] }));

const opts = {
  input: dir, appName: "d", analysisLevel: 1, noBuild: true, emit: "neo4j",
} as unknown as AnalysisOptions;

describe("neo4j decorator projection", () => {
  test("projects decorator nodes and applications, sharing the node across applications", async () => {
    const res = await analyze(opts);
    const rows = project(res.application);

    const decNodes = rows.nodes.filter((n) => n.labels.includes("TSDecorator"));
    // @Get is applied twice but is ONE node -- that is the merge-key behaviour, not a row count.
    expect(decNodes.map((n) => n.props.name).sort()).toEqual(["Column", "Controller", "Get"]);

    const apps = rows.edges.filter((e) => e.type === "TS_DECORATED_BY");
    expect(apps.length).toBe(4); // class + property + two methods

    // Arguments are per-application: the two @Get edges carry different positional arguments.
    const getArgs = apps
      .filter((e) => e.to.value === "Get")
      .map((e) => (e.props.positional_arguments as string[]).join(","))
      .sort();
    // positional_arguments are RAW source fragments, so the written quoting is preserved.
    expect(getArgs).toEqual(["'/'", "'/:id'"]);

    // Object-literal keyword args are flattened to a sorted-key JSON string (python encodes the
    // same field the same way, so the two projections stay diffable).
    const col = apps.find((e) => e.to.value === "Column");
    expect(col?.props.keyword_arguments_json).toBe('{"nullable":"true"}');

    // A property decorator reaches the field, not just the class.
    expect(apps.some((e) => e.from.value.endsWith("/UserController/name"))).toBe(true);
  });

  test("declared in the schema contract, so the conformance gate covers it", () => {
    const node = NODE_LABELS.find((n) => n.label === "TSDecorator");
    expect(node?.mergeLabel).toBe("TSDecorator");
    expect(node?.key).toBe("name");
    const rel = REL_TYPES.find((r) => r.type === "TS_DECORATED_BY");
    expect(rel?.to).toEqual(["TSDecorator"]);
    expect(rel?.from).toContain("TSField");
  });

  test("renders a MERGE on name, not on a can:// id", async () => {
    const cypher = renderCypher(project((await analyze(opts)).application), "d");
    expect(cypher).toContain("MERGE (n:TSDecorator {name: row.k})");
    expect(cypher).toContain("MATCH (b:TSDecorator {name: row.t})");
  });
});
