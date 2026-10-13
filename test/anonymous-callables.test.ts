/**
 * Issue #92: an unnamed arrow / function expression is a callable in its own right.
 * It is tree-contained under its enclosing callable with a durable positional signature segment
 * (`<anon@line:col>`), carries its own body/cfg/cdg/ddg and formal-in vertices, and owns the call
 * sites that used to be attributed to the callable that merely encloses it.
 *
 * The acceptance case is the Express handler idiom: a request-rooted access path must reach the
 * sink call on the DDG, which was impossible while the handler had no graph at all.
 *
 * Spec: docs/design/specs/anonymous-callable-materialization.md
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import type { TSCallable, TSModule } from "../src/schema";
import type { TSSynthesizedNode } from "../src/schema/homing";
import { project } from "../src/build/neo4j";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/anon-app");

function options(level: number): AnalysisOptions {
  return {
    input: FIXTURE,
    output: null,
    emit: "json",
    appName: "anon-app",
    neo4jUri: null,
    neo4jUser: "neo4j",
    neo4jPassword: "",
    neo4jDatabase: null,
    analysisLevel: level,
    graphs: ["cfg", "dfg", "pdg", "sdg"],
    graphFieldDepth: 3,
    jobs: 1,
    targetFiles: null,
    skipTests: true,
    eager: true,
    noBuild: true,
    phantoms: true,
    cacheDir: null,
    verbosity: 0,
  } as unknown as AnalysisOptions;
}

const opts = options(4);
const { application, idBySig, collisions, dangling } = await analyze(opts);
const root = application.application;
const mod = root.symbol_table["src/routes.ts"] as TSModule;
const fns = mod.functions as Record<string, TSCallable>;

const login = fns["login"] as TSCallable;
const handler = (login.callables ?? {})["<anon@2:10>"] as TSCallable;

/** Edge lists are typed `unknown[]` on TSCallable until the body-node model lands (roadmap #2). */
type Edge = { src: string; dst: string; var?: string };
const edges = (xs: unknown[] | undefined): Edge[] => (xs ?? []) as Edge[];

describe("anonymous callables are first-class (issue #92)", () => {
  test("a returned arrow is tree-contained under its enclosing callable", () => {
    expect(handler).toBeDefined();
    expect(handler.kind).toBe("arrow");
    expect(handler.signature).toBe("src/routes.login.<anon@2:10>");
    expect(handler.id).toBe(`${login.id}/<anon@2:10>`);
  });

  test("its id is durable-tier and cannot collide with a body node at the same position", () => {
    // Statements/synthetics under `login` are addressed `<login-id>@line:col`; the arrow is a
    // containment segment, so the two namespaces stay disjoint even at identical coordinates.
    expect(handler.id.startsWith(`${login.id}@`)).toBe(false);
    expect(collisions).toEqual([]);
  });

  test("a variable-bound arrow keeps its own name — no <anon> segment", () => {
    expect((fns["named"] as TSCallable).signature).toBe("src/routes.named");
    expect(Object.keys(fns)).not.toContain("<anon@17:15>");
  });

  test("a bare arrow in a module-level expression statement is materialized", () => {
    const h = fns["<anon@13:20>"] as TSCallable;
    expect(h).toBeDefined();
    expect(h.kind).toBe("arrow");
    expect(edges(h.ddg).some((e) => e.var === "req.query.probe")).toBe(true);
  });

  test("nested anonymous callables chain their segments", () => {
    const outer = fns["outer"] as TSCallable;
    const first = Object.values(outer.callables ?? {})[0] as TSCallable;
    const second = Object.values(first.callables ?? {})[0] as TSCallable;
    expect(second.signature.match(/<anon@\d+:\d+>/g)).toHaveLength(2);
    expect(second.id.startsWith(first.id)).toBe(true);
  });

  test("call sites re-anchor from the enclosing callable to the arrow", () => {
    const calleeOf = (c: TSCallable): unknown[] =>
      Object.values(c.body ?? {}).filter((n) => n.kind === "call").map((n) => n.callee);
    expect(calleeOf(login)).toEqual([]);
    expect(calleeOf(handler)).toEqual([`${(fns["query"] as TSCallable).id}`]);

    const srcs = root.call_graph.map((e) => e.src);
    expect(srcs).toContain(handler.id);
    expect(srcs).not.toContain(login.id);
  });

  test("the handler carries its own graphs and formal-in vertices", () => {
    expect(Object.keys(handler.body)).toContain("@formal_in:0");
    expect(handler.body["@formal_in:0"]?.of).toBe("req");
    expect(edges(handler.cfg).length).toBeGreaterThan(0);
    expect(edges(handler.cdg).length).toBeGreaterThan(0);
  });

  test("EXP-001: the request-rooted access path reaches the sink call on the DDG", () => {
    const ddg = edges(handler.ddg);
    const tainted = ddg.find((e) => e.var === "req.body.email");
    expect(tainted).toBeDefined();

    // …and that definition flows onward to the statement holding the `query(...)` call.
    const callKey = Object.entries(handler.body).find(([, n]) => n.kind === "call")?.[0] as string;
    const reaches = new Set<string>([tainted?.dst as string]);
    for (let i = 0; i < ddg.length; i++) {
      for (const e of ddg) if (reaches.has(e.src)) reaches.add(e.dst);
    }
    expect(reaches.has(callKey)).toBe(true);
  });

  test("class property calls preserve initializer and constructor-assignment candidates", () => {
    const holder = mod.types["CallbackHolder"]?.callables?.["run"];
    if (!holder) throw new Error("CallbackHolder.run is missing");
    const targets = root.call_graph
      .filter((edge) => edge.src === holder.id)
      .map((edge) => edge.dst);
    expect(targets).toContain((fns["initializedCallback"] as TSCallable).id);
    expect(targets).toContain((fns["assignedCallback"] as TSCallable).id);

    const callbackCall = Object.values(holder.body).find(
      (node) => node.kind === "call" && node.method_name === "callback",
    );
    expect(callbackCall?.callee).toBeNull();
  });

  test("parameter properties and body-bearing constructor overloads resolve callbacks", () => {
    const assignedId = (fns["assignedCallback"] as TSCallable).id;
    for (const className of ["ParameterHolder", "OverloadedHolder"]) {
      const run = mod.types[className]?.callables?.["run"];
      if (!run) throw new Error(`${className}.run is missing`);
      expect(root.call_graph).toContainEqual(
        expect.objectContaining({ src: run.id, dst: assignedId }),
      );
    }
  });

  test("no call-graph endpoint dangles", () => {
    expect(dangling).toEqual([]);
  });

  test("synthesized_callables is a compatibility index onto the tree", () => {
    const index = (root.synthesized_callables ?? {}) as Record<string, TSSynthesizedNode>;
    expect(index[`${login.id}@2:10`]?.id).toBe(handler.id);
    // Every entry either points at a tree node or is a residual fallback node keyed by its own id.
    for (const [key, entry] of Object.entries(index)) {
      expect(key === entry.id || [...idBySig.values()].includes(entry.id)).toBe(true);
    }
  });

  test("the envelope declares schema 2.0.0", () => {
    expect(application.schema_version).toBe("2.0.0");
  });
});

describe("Neo4j projection of anonymous callables (issues #92, #75)", () => {
  const rows = project(application);
  const node = rows.nodes.find((n) => n.value === handler.id);

  test("one node carries both :TSCallable and :TSAnonymousCallable", () => {
    expect(node?.labels).toContain("TSCallable");
    expect(node?.labels).toContain("TSAnonymousCallable");
    expect(rows.nodes.filter((n) => n.value === handler.id)).toHaveLength(1);
  });

  test("it hangs off its enclosing callable by containment, so the snapshot wipe reaches it", () => {
    const decl = rows.edges.find((e) => e.type === "TS_DECLARES" && e.to.value === handler.id);
    expect(decl?.from.value).toBe(login.id);
  });

  test("no off-tree :TSAnonymousCallable node remains", () => {
    const anon = rows.nodes.filter((n) => n.labels.includes("TSAnonymousCallable"));
    expect(anon.length).toBeGreaterThan(0);
    for (const n of anon) {
      expect(rows.edges.some((e) => e.type === "TS_DECLARES" && e.to.value === n.value)).toBe(true);
    }
  });
});
