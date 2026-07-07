/**
 * Schema-v2 L1 emission gate: the v1 in-memory model transformed to the canonical additive-CPG
 * tree (canonical-schema.md) must have the right envelope, well-formed unique `can://` ids, a
 * byte-slice-able `source` per module (get_method_body), namespaces as container nodes, free
 * bindings as module `fields{}`, and `body` `call` nodes at L1 — while remaining a superset of
 * every v1 symbol-table fact.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication } from "../src/schema";
import { type V2Callable, type V2Module, type V2Type, toV2Detailed } from "../src/schema/v2";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/sample-app");

function options(): AnalysisOptions {
  return {
    input: FIXTURE,
    output: null,
    emit: "json",
    appName: null,
    neo4jUri: null,
    neo4jUser: "neo4j",
    neo4jPassword: "",
    neo4jDatabase: null,
    analysisLevel: 1,
    graphs: ["cfg", "dfg", "pdg", "sdg"],
    graphFieldDepth: 3,
    jobs: 1,
    targetFiles: null,
    skipTests: true,
    eager: true,
    noBuild: true,
    phantoms: true,
    callGraphProvider: "tsc",
    cacheDir: null,
    verbosity: 0,
  };
}

async function run(): Promise<TSApplication> {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-v2-test-"));
  try {
    return await analyze({ ...options(), cacheDir });
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

const v1 = await run();
const { application: v2, idBySig, collisions } = toV2Detailed(v1, { ...options(), input: FIXTURE });
const root = v2.application;
const st = root.symbol_table;

/** Every id in the tree, in walk order, for uniqueness + well-formedness checks. */
function allIds(): string[] {
  const out: string[] = [];
  const walkCallable = (c: V2Callable): void => {
    out.push(c.id);
    for (const cc of Object.values(c.callables ?? {})) walkCallable(cc);
    for (const t of Object.values(c.types ?? {})) walkType(t);
  };
  const walkType = (t: V2Type): void => {
    out.push(t.id);
    for (const c of Object.values(t.callables ?? {})) walkCallable(c);
    for (const f of Object.values(t.fields ?? {})) out.push(f.id);
    for (const st2 of Object.values(t.types ?? {})) walkType(st2);
    for (const fn of Object.values(t.functions ?? {})) walkCallable(fn);
  };
  for (const m of Object.values(st) as V2Module[]) {
    out.push(m.id);
    for (const t of Object.values(m.types)) walkType(t);
    for (const c of Object.values(m.functions)) walkCallable(c);
    for (const f of Object.values(m.fields)) out.push(f.id);
  }
  return out;
}

describe("schema v2 — L1 envelope", () => {
  test("root envelope matches the canonical shape", () => {
    expect(v2.schema_version).toBe("2.0.0");
    expect(v2.language).toBe("typescript");
    expect(v2.max_level).toBe(1);
    expect(Object.keys(root).sort()).toEqual(["call_graph", "id", "kind", "param_in", "param_out", "symbol_table"]);
    expect(root.id).toBe("can://typescript/sample-app");
    expect(root.kind).toBe("application");
  });

  test("edge lists are empty at L1 (populated at L2/L4)", () => {
    expect(root.call_graph).toEqual([]);
    expect(root.param_in).toEqual([]);
    expect(root.param_out).toEqual([]);
  });

  test("symbol_table keys are project-relative POSIX paths", () => {
    for (const key of Object.keys(st)) {
      expect(path.isAbsolute(key)).toBe(false);
      expect(key.includes("..")).toBe(false);
      expect(key).not.toContain("\\");
    }
  });
});

describe("schema v2 — L1 identity", () => {
  test("every can:// id is unique and well-formed", () => {
    const ids = allIds();
    expect(collisions).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("can://typescript/sample-app/")).toBe(true);
  });

  test("module ids derive from the file key", () => {
    for (const [key, m] of Object.entries(st) as [string, V2Module][]) {
      expect(m.id).toBe(`can://typescript/sample-app/${key}`);
      expect(m.kind).toBe("module");
    }
  });
});

describe("schema v2 — L1 source & spans (get_method_body)", () => {
  test("each module carries its full source", () => {
    for (const m of Object.values(st) as V2Module[]) expect(typeof m.source).toBe("string");
  });

  test("a callable's span.bytes slices its declaration out of module.source", () => {
    const svc = st["src/services.ts"];
    const fn = svc.functions.makeGuestName;
    expect(fn.kind).toBe("function");
    const slice = svc.source.slice(fn.span!.bytes[0], fn.span!.bytes[1]);
    expect(slice).toContain("makeGuestName");
  });
});

describe("schema v2 — L1 tree shape", () => {
  test("a namespace is a container node with types{} and functions{} (Gap A)", () => {
    const ns = st["src/util.ts"].types.StringUtil;
    expect(ns.kind).toBe("namespace");
    expect(Object.keys(ns.types ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(ns.functions ?? {}).length).toBeGreaterThan(0);
    expect(ns.callables).toBeUndefined();
  });

  test("enum members and class attributes are field nodes (Gap B analog)", () => {
    const role = st["src/models.ts"].types.Role;
    expect(role.kind).toBe("enum");
    expect(Object.keys(role.fields ?? {})).toContain("Admin");
    for (const f of Object.values(role.fields ?? {})) expect(f.kind).toBe("field");
  });

  test("a callable's body holds L1 call nodes keyed by line:col with callee null", () => {
    const create = st["src/services.ts"].types.UserService.callables?.create as V2Callable;
    const keys = Object.keys(create.body);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k).toMatch(/^\d+:\d+(\/\d+)?$/);
    for (const node of Object.values(create.body)) {
      expect(node.kind).toBe("call");
      expect(node.callee).toBeNull();
    }
  });
});

describe("schema v2 — L1 superset", () => {
  test("every v1 callable/type signature has a v2 id", () => {
    const v1sigs = new Set<string>();
    const addType = (t: { signature: string; methods?: Record<string, { signature: string }> }): void => {
      v1sigs.add(t.signature);
      for (const m of Object.values(t.methods ?? {})) v1sigs.add(m.signature);
    };
    for (const m of Object.values(v1.symbol_table)) {
      for (const t of Object.values(m.classes)) addType(t);
      for (const t of Object.values(m.interfaces)) addType(t);
      for (const t of Object.values(m.enums)) v1sigs.add(t.signature);
      for (const t of Object.values(m.type_aliases)) v1sigs.add(t.signature);
      for (const fn of Object.values(m.functions)) v1sigs.add(fn.signature);
    }
    const missing = [...v1sigs].filter((s) => !idBySig.has(s));
    expect(missing).toEqual([]);
  });
});

// ---- L2: call graph -------------------------------------------------------------------------
async function runL2(): Promise<TSApplication> {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-v2-l2-"));
  try {
    return await analyze({ ...options(), analysisLevel: 2, cacheDir });
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}
const v1L2 = await runL2();
const { application: v2L2, idBySig: idsL2, dangling: danglingL2 } = toV2Detailed(v1L2, { ...options(), analysisLevel: 2, input: FIXTURE });
const rootL2 = v2L2.application;
const knownIds = new Set(idsL2.values());

describe("schema v2 — L2 call graph", () => {
  test("max_level is 2 and the root gains external/synth maps", () => {
    expect(v2L2.max_level).toBe(2);
    expect(rootL2.external_symbols).toBeDefined();
    expect(rootL2.synthesized_callables).toBeDefined();
  });

  test("edges are {src,dst,prov,weight} with can:// ids, no dangling endpoints", () => {
    expect(rootL2.call_graph.length).toBeGreaterThan(0);
    expect(danglingL2).toEqual([]);
    for (const e of rootL2.call_graph) {
      expect(Object.keys(e).sort()).toEqual(["dst", "prov", "src", "weight"]);
      expect(knownIds.has(e.src)).toBe(true);
      expect(knownIds.has(e.dst)).toBe(true);
    }
  });

  test("body call-node callees are backfilled to a known id (null → id refinement)", () => {
    let sawBackfill = false;
    const scan = (c: V2Callable): void => {
      for (const b of Object.values(c.body)) {
        if (b.kind === "call" && b.callee != null) {
          sawBackfill = true;
          expect(knownIds.has(b.callee as string)).toBe(true);
        }
      }
      for (const cc of Object.values(c.callables ?? {})) scan(cc);
    };
    for (const m of Object.values(rootL2.symbol_table)) {
      for (const t of Object.values(m.types)) {
        for (const c of Object.values(t.callables ?? {})) scan(c);
        for (const fn of Object.values(t.functions ?? {})) scan(fn);
      }
      for (const fn of Object.values(m.functions)) scan(fn);
    }
    expect(sawBackfill).toBe(true);
  });

  test("external symbols are homed under @external as kind:external", () => {
    for (const [id, ext] of Object.entries(rootL2.external_symbols ?? {})) {
      expect(id).toContain("/@external/");
      expect((ext as { kind: string }).kind).toBe("external");
    }
  });
});

// ---- L3/L4: dataflow into the tree ----------------------------------------------------------
const DF_FIXTURE = path.resolve(import.meta.dir, "fixtures/dataflow-app");
function dfOptions(level: 3 | 4): AnalysisOptions {
  return { ...options(), input: DF_FIXTURE, analysisLevel: level, graphs: level >= 4 ? ["cfg", "dfg", "pdg", "sdg"] : ["cfg", "dfg", "pdg"] };
}
async function runDF(level: 3 | 4): Promise<TSApplication> {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), `cants-v2-l${level}-`));
  try {
    return await analyze({ ...dfOptions(level), cacheDir });
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

/** Every callable node in the tree (module/type/namespace/nested recursion). */
function allCallables(root: { symbol_table: Record<string, V2Module> }): V2Callable[] {
  const out: V2Callable[] = [];
  const wc = (c: V2Callable): void => {
    out.push(c);
    for (const cc of Object.values(c.callables ?? {})) wc(cc);
    for (const t of Object.values(c.types ?? {})) wt(t);
  };
  const wt = (t: V2Type): void => {
    for (const c of Object.values(t.callables ?? {})) wc(c);
    for (const st of Object.values(t.types ?? {})) wt(st);
    for (const fn of Object.values(t.functions ?? {})) wc(fn);
  };
  for (const m of Object.values(root.symbol_table)) {
    for (const t of Object.values(m.types)) wt(t);
    for (const fn of Object.values(m.functions)) wc(fn);
  }
  return out;
}

const dfL3 = toV2Detailed(await runDF(3), dfOptions(3)).application;
const dfL4 = toV2Detailed(await runDF(4), dfOptions(4)).application;

/** No intra-callable (bare-local) or cross-callable (canId@local) endpoint may dangle. */
function danglingCount(app: typeof dfL3): number {
  const root = app.application;
  const callables = allCallables(root);
  const bodies = new Map(callables.map((c) => [c.id, new Set(Object.keys(c.body))]));
  const resolve = (ep: string): boolean => {
    const at = ep.indexOf("@");
    if (at < 0) return false;
    const b = bodies.get(ep.slice(0, at));
    const rem = ep.slice(at);
    return !!b && (b.has(rem) || b.has(rem.slice(1))); // synthetic keeps '@'; positional strips the separator
  };
  let d = 0;
  for (const c of callables) {
    const body = bodies.get(c.id) as Set<string>;
    for (const list of ["cfg", "cdg", "ddg", "summary"] as const) {
      for (const e of (c[list] ?? []) as Array<{ src: string; dst: string }>) {
        if (!body.has(e.src)) d++;
        if (!body.has(e.dst)) d++;
      }
    }
  }
  for (const list of ["param_in", "param_out"] as const) {
    for (const e of root[list]) {
      if (!resolve(e.src)) d++;
      if (!resolve(e.dst)) d++;
    }
  }
  return d;
}

describe("schema v2 — L3 intraprocedural dataflow", () => {
  test("max_level is 3; callables grow cfg/cdg/ddg with reaching-defs provenance", () => {
    expect(dfL3.max_level).toBe(3);
    expect(dfL3.k_limit).toBeGreaterThan(0);
    let cfg = 0;
    let ddgReaching = 0;
    let ddgTotal = 0;
    for (const c of allCallables(dfL3.application)) {
      cfg += (c.cfg ?? []).length;
      for (const e of (c.ddg ?? []) as Array<{ prov: string[] }>) {
        ddgTotal++;
        if (e.prov.includes("reaching-defs")) ddgReaching++;
      }
    }
    expect(cfg).toBeGreaterThan(0);
    expect(ddgTotal).toBeGreaterThan(0);
    expect(ddgReaching).toBe(ddgTotal); // no points-to edges without the oracle
  });

  test("L3 omits the L4 SDG family (no param_in/param_out/summary/synthetic vertices)", () => {
    expect(dfL3.application.param_in).toEqual([]);
    expect(dfL3.application.param_out).toEqual([]);
    for (const c of allCallables(dfL3.application)) {
      expect(c.summary ?? []).toEqual([]);
      for (const k of Object.keys(c.body)) {
        expect(k.startsWith("@formal")).toBe(false);
        expect(k.includes("actual")).toBe(false);
      }
    }
  });

  test("no dangling endpoints at L3", () => {
    expect(danglingCount(dfL3)).toBe(0);
  });
});

describe("schema v2 — L4 interprocedural SDG", () => {
  test("max_level is 4; synthetic formal/actual vertices and param/summary edges appear", () => {
    expect(dfL4.max_level).toBe(4);
    let formalIn = 0;
    let actual = 0;
    let summary = 0;
    for (const c of allCallables(dfL4.application)) {
      for (const k of Object.keys(c.body)) {
        if (k.startsWith("@formal_in")) formalIn++;
        if (k.includes("actual")) actual++;
      }
      summary += (c.summary ?? []).length;
    }
    expect(formalIn).toBeGreaterThan(0);
    expect(actual).toBeGreaterThan(0);
    expect(summary).toBeGreaterThan(0);
    expect(dfL4.application.param_in.length).toBeGreaterThan(0);
    expect(dfL4.application.param_out.length).toBeGreaterThan(0);
  });

  test("param_in/param_out use fully-qualified canId@local ids", () => {
    // Every endpoint is a fully-qualified can:// id with a @local suffix (arg edges AND global-flow edges).
    for (const e of [...dfL4.application.param_in, ...dfL4.application.param_out]) {
      for (const ep of [e.src, e.dst]) {
        expect(ep.startsWith("can://typescript/")).toBe(true);
        expect(ep.includes("@")).toBe(true);
      }
    }
    // The canonical arg/return shape is present: actual_in→formal_in and formal_out→actual_out.
    expect(dfL4.application.param_in.some((e) => e.dst.includes("@formal_in:"))).toBe(true);
    expect(dfL4.application.param_out.some((e) => e.src.includes("@formal_out"))).toBe(true);
    expect(dfL4.application.param_out.some((e) => e.dst.includes("/actual_out"))).toBe(true);
  });

  test("no dangling endpoints at L4", () => {
    expect(danglingCount(dfL4)).toBe(0);
  });

  test("no null values except the sanctioned call-node callee (canonical § Conventions)", () => {
    let total = 0;
    let callee = 0;
    const walk = (v: unknown, key: string): void => {
      if (v === null) {
        total++;
        if (key === "callee") callee++;
        return;
      }
      if (Array.isArray(v)) {
        for (const x of v) walk(x, key);
        return;
      }
      if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) walk(val, k);
    };
    walk(dfL4, "");
    expect(total - callee).toBe(0); // absence encodes "no fact"; only callee:null is sanctioned
  });

  test("monotonicity: every L3 body key and cfg/cdg/ddg edge survives into L4", () => {
    const key = (c: V2Callable, list: "cfg" | "cdg" | "ddg"): Set<string> =>
      new Set((c[list] ?? []).map((e: { src: string; dst: string; kind?: string; var?: string }) => `${e.src}>${e.dst}:${e.kind ?? e.var ?? ""}`));
    const l4 = new Map(allCallables(dfL4.application).map((c) => [c.id, c]));
    let violations = 0;
    for (const c3 of allCallables(dfL3.application)) {
      const c4 = l4.get(c3.id);
      if (!c4) {
        violations++;
        continue;
      }
      const body4 = new Set(Object.keys(c4.body));
      for (const k of Object.keys(c3.body)) if (!body4.has(k)) violations++;
      for (const list of ["cfg", "cdg", "ddg"] as const) {
        const e4 = key(c4, list);
        for (const e of key(c3, list)) if (!e4.has(e)) violations++;
      }
    }
    expect(violations).toBe(0);
  });
});
