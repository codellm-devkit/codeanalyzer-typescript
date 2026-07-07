/**
 * Schema-v2 L1 emission gate: the v1 in-memory model transformed to the canonical additive-CPG
 * tree (canonical-schema.md) must have the right envelope, well-formed unique `can://` ids, a
 * byte-slice-able `source` per module (get_method_body), namespaces as container nodes, free
 * bindings as module `fields{}`, and `body` `call` nodes at L1 — while remaining a superset of
 * every v1 symbol-table fact.
 */
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pkg from "../package.json";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import type { GraphSelector, TSApplication } from "../src/schema";
import { type V2Application, type V2Callable, type V2Module, type V2Type, toV2Detailed } from "../src/schema/v2";
import { type GraphRows, project } from "../src/build/neo4j";
import { tscProvider } from "../src/semantic_analysis";

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

  test("envelope carries analyzer{name,version}", () => {
    expect(v2.analyzer?.name).toBe("codeanalyzer-typescript");
    expect(v2.analyzer?.version).toBe(pkg.version);
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

// ---- Inheritance: heritage signatures resolve to can:// ids (issue #33) ------------------------
// sample-app's models.ts is first-party heritage: Entity implements Identifiable; User extends
// Entity implements Named; Robot implements Named (a second, unrelated implementer of Named).
// This resolution is unconditional (independent of `-a` level) — it only needs idBySig, which the
// unconditional L1 tree walk already populates — so it's exercised here even though `st` is L1.
describe("schema v2 — inheritance resolves heritage signatures to can:// ids (issue #33)", () => {
  test("a class's extends/implements signatures resolve to their declaring node's id", () => {
    const types = st["src/models.ts"].types;
    const entity = types.Entity;
    const user = types.User;
    const robot = types.Robot;
    const identifiable = types.Identifiable;
    const named = types.Named;

    expect(entity.extends_ids).toBeUndefined(); // no base class, only `implements`
    expect(entity.implements_ids).toEqual([identifiable.id]);

    expect(user.extends_ids).toEqual([entity.id]);
    expect(user.implements_ids).toEqual([named.id]);

    expect(robot.extends_ids).toBeUndefined();
    expect(robot.implements_ids).toEqual([named.id]);
  });

  test("base_classes/implements_types (signature strings) are unchanged — additive, not replaced", () => {
    const entity = st["src/models.ts"].types.Entity as unknown as { base_classes: string[]; implements_types: string[] };
    const user = st["src/models.ts"].types.User as unknown as { base_classes: string[]; implements_types: string[] };
    const identifiableSig = st["src/models.ts"].types.Identifiable.signature;
    const entitySig = st["src/models.ts"].types.Entity.signature;
    const namedSig = st["src/models.ts"].types.Named.signature;

    expect(entity.base_classes).toEqual([identifiableSig]);
    expect(entity.implements_types).toEqual([identifiableSig]);
    expect(user.base_classes).toEqual([entitySig, namedSig]);
    expect(user.implements_types).toEqual([namedSig]);
  });

  test("an unresolved (external/library) supertype is dropped, not nulled", () => {
    // Every type in sample-app either has no heritage or fully first-party heritage, so there is no
    // dropped entry to observe directly here — instead assert the shape invariant the resolver
    // relies on: extends_ids/implements_ids, when present, are always non-empty arrays of can://
    // ids (never contain undefined/null placeholders for an unresolved signature).
    for (const t of Object.values(st["src/models.ts"].types)) {
      for (const ids of [t.extends_ids, t.implements_ids]) {
        if (ids === undefined) continue;
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) expect(id.startsWith("can://")).toBe(true);
      }
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

// ---- L1: the call-graph solve is skipped entirely (issue #31) -------------------------------
// The solve (including the heavier Jelly leg) is only useful from L2 up — the v2 emitter never
// reads call_graph/external_symbols/synthesized_callables at L1 (homeExternals/homeSynthesized
// are gated to `level >= 2` in src/schema/v2/emit.ts). This locks BOTH the output invariant
// (already true before the -a 1 gating fix) AND, via a spy, that the provider itself is skipped.
describe("schema v2 — L1 skips the call-graph solve (issue #31)", () => {
  test("provider.build is not invoked and no call-graph/external/synth data appears at -a 1", async () => {
    const spy = spyOn(tscProvider, "build");
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-v2-l1-guard-"));
    try {
      const v1L1 = await analyze({ ...options(), analysisLevel: 1, callGraphProvider: "tsc", cacheDir });
      expect(spy).not.toHaveBeenCalled();
      expect(v1L1.call_graph).toEqual([]);
      expect(Object.keys(v1L1.external_symbols)).toEqual([]);
      expect(Object.keys(v1L1.synthesized_callables)).toEqual([]);
    } finally {
      spy.mockRestore();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("provider.build IS invoked at -a 2, and produces edges (baseline: L2 unaffected)", async () => {
    const spy = spyOn(tscProvider, "build");
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-v2-l1-guard-l2-"));
    try {
      const v1L2guard = await analyze({ ...options(), analysisLevel: 2, callGraphProvider: "tsc", cacheDir });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(v1L2guard.call_graph.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
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

  test("a sampled L3 statement node is source-sliceable (span.bytes reproduces its text)", () => {
    const mod = dfL3.application.symbol_table["src/flow.ts"];
    const classify = mod.functions.classify as V2Callable;
    const stmt = classify.body["4:3"];
    expect(stmt?.kind).toBe("statement");
    const [s, e] = (stmt as { span: { bytes: [number, number] } }).span.bytes;
    expect(e).toBeGreaterThan(s);
    expect(mod.source.slice(s, e)).toBe('let label = "none";');
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

  // The full L1⊆L2⊆L3⊆L4 gate (including this L3→L4 edge/body-key check, plus symbol-table ids,
  // call_graph, summary, and param_in/param_out) lives below in the dedicated monotonicity
  // describe block, run end-to-end across all four levels rather than just this one pair.
});

// ---- Real end-to-end monotonicity gate + Neo4j↔JSON count parity (issue #27) -------------------
//
// `analyze()` run fresh at each of `-a 1/2/3/4` on dataflow-app (four full runs — the fixture is
// small), then the emitted V2Application at each level is reduced to three KEY-sets — symbol-table
// ids, body-node keys, and edge keys (call_graph / cfg / cdg / ddg / summary / param_in / param_out)
// — and every level's set must be a superset of the level below (canonical-schema.md's additive
// invariant). Comparing KEYS (not values) means the one sanctioned value mutation, a `call` node's
// `callee: null → id` refinement between L1 and L2, needs no special-casing: the body key survives
// unchanged even though its `callee` value changes.

function optsAt(level: 1 | 2 | 3 | 4): AnalysisOptions {
  // Mirrors the CLI's own `--graphs` default per level (src/cli.ts): graphs is only consulted once
  // `analysisLevel >= 3` starts extraction at all, so it's `[]` and inert below that.
  const graphs: GraphSelector[] = level >= 4 ? ["cfg", "dfg", "pdg", "sdg"] : level === 3 ? ["cfg", "dfg", "pdg"] : [];
  return { ...options(), input: DF_FIXTURE, analysisLevel: level, graphs };
}

async function appAt(level: 1 | 2 | 3 | 4): Promise<V2Application> {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-mono-"));
  try {
    const v1run = await analyze({ ...optsAt(level), cacheDir });
    return toV2Detailed(v1run, optsAt(level)).application;
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

/** Every symbol-table id — module/type/callable/field — recursing through nested scopes. */
function symbolIds(app: V2Application): Set<string> {
  const out = new Set<string>();
  const walkCallable = (c: V2Callable): void => {
    out.add(c.id);
    for (const cc of Object.values(c.callables ?? {})) walkCallable(cc);
    for (const t of Object.values(c.types ?? {})) walkType(t);
  };
  const walkType = (t: V2Type): void => {
    out.add(t.id);
    for (const c of Object.values(t.callables ?? {})) walkCallable(c);
    for (const f of Object.values(t.fields ?? {})) out.add(f.id);
    for (const nested of Object.values(t.types ?? {})) walkType(nested);
    for (const fn of Object.values(t.functions ?? {})) walkCallable(fn);
  };
  for (const m of Object.values(app.application.symbol_table)) {
    out.add(m.id);
    for (const t of Object.values(m.types)) walkType(t);
    for (const c of Object.values(m.functions)) walkCallable(c);
    for (const f of Object.values(m.fields)) out.add(f.id);
  }
  return out;
}

/** Every type node — classes/interfaces/enums/aliases/namespaces — recursing through nested scopes. */
function allTypes(app: V2Application): V2Type[] {
  const out: V2Type[] = [];
  const walkCallable = (c: V2Callable): void => {
    for (const cc of Object.values(c.callables ?? {})) walkCallable(cc);
    for (const t of Object.values(c.types ?? {})) walkType(t);
  };
  const walkType = (t: V2Type): void => {
    out.push(t);
    for (const c of Object.values(t.callables ?? {})) walkCallable(c);
    for (const nested of Object.values(t.types ?? {})) walkType(nested);
    for (const fn of Object.values(t.functions ?? {})) walkCallable(fn);
  };
  for (const m of Object.values(app.application.symbol_table)) {
    for (const t of Object.values(m.types)) walkType(t);
    for (const c of Object.values(m.functions)) walkCallable(c);
  }
  return out;
}

/** Every body-node key, namespaced by its owning callable id so bare local keys never collide. */
function bodyKeys(app: V2Application): Set<string> {
  const out = new Set<string>();
  for (const c of allCallables(app.application)) {
    for (const k of Object.keys(c.body)) out.add(`${c.id}::${k}`);
  }
  return out;
}

/** Every edge key: call_graph + param_in/param_out (app scope), cfg/cdg/ddg/summary (per callable). */
function edgeKeys(app: V2Application): Set<string> {
  const out = new Set<string>();
  const root = app.application;
  for (const e of root.call_graph) out.add(`call_graph::${e.src}>${e.dst}:${[...e.prov].sort().join(",")}`);
  for (const c of allCallables(root)) {
    for (const list of ["cfg", "cdg", "ddg", "summary"] as const) {
      for (const e of (c[list] ?? []) as Array<{ src: string; dst: string; kind?: string; var?: string }>) {
        out.add(`${c.id}::${list}::${e.src}>${e.dst}:${e.kind ?? e.var ?? ""}`);
      }
    }
  }
  for (const list of ["param_in", "param_out"] as const) {
    for (const e of root[list]) out.add(`${list}::${e.src}>${e.dst}:${e.var ?? ""}`);
  }
  return out;
}

/** Elements of `lo` missing from `hi` — empty means `lo` is a subset of `hi`. */
function missingFrom(lo: Set<string>, hi: Set<string>): string[] {
  return [...lo].filter((k) => !hi.has(k));
}

const monoApp1 = await appAt(1);
const monoApp2 = await appAt(2);
const monoApp3 = await appAt(3);
const monoApp4 = await appAt(4);
const monoPairs: Array<[V2Application, V2Application, string]> = [
  [monoApp1, monoApp2, "L1 -> L2"],
  [monoApp2, monoApp3, "L2 -> L3"],
  [monoApp3, monoApp4, "L3 -> L4"],
];

describe("additive monotonicity — real L1 ⊆ L2 ⊆ L3 ⊆ L4 gate (issue #27)", () => {
  test("fixture sanity: each level actually adds new facts (guards against a vacuous superset)", () => {
    expect(bodyKeys(monoApp1).size).toBeGreaterThan(0);
    expect(edgeKeys(monoApp2).size).toBeGreaterThan(0); // call_graph appears at L2
    expect(edgeKeys(monoApp3).size).toBeGreaterThan(edgeKeys(monoApp2).size); // cfg/cdg/ddg appear at L3
    expect(edgeKeys(monoApp4).size).toBeGreaterThan(edgeKeys(monoApp3).size); // summary/param_in/out appear at L4
    expect(bodyKeys(monoApp3).size).toBeGreaterThan(bodyKeys(monoApp2).size); // statements appear at L3
    expect(bodyKeys(monoApp4).size).toBeGreaterThan(bodyKeys(monoApp3).size); // synthetic vertices appear at L4
  });

  for (const [lo, hi, label] of monoPairs) {
    test(`symbol-table ids (module/type/callable/field): ${label}`, () => {
      expect(missingFrom(symbolIds(lo), symbolIds(hi))).toEqual([]);
    });
    test(`body-node keys: ${label}`, () => {
      expect(missingFrom(bodyKeys(lo), bodyKeys(hi))).toEqual([]);
    });
    test(`edge keys (call_graph/cfg/cdg/ddg/summary/param_in/param_out): ${label}`, () => {
      expect(missingFrom(edgeKeys(lo), edgeKeys(hi))).toEqual([]);
    });
  }
});

// ---- Neo4j ↔ JSON count parity, full depth (issue #27) -----------------------------------------
//
// `project()` is a second projection of the SAME v2 tree the JSON path emits, so node/edge counts
// must line up exactly at `-a 4` (full depth). `RowBuilder` dedupes nodes by (labels[0], id) — every
// project-owned node shares the "CanNode" label — so the JS-side count must dedupe on id the same
// way; a plain sum-of-walks would silently diverge from `rows.nodes.length` if two tree positions
// ever produced the same id (which the L1 identity test elsewhere guards against, but this test
// doesn't lean on that guarantee holding).

const monoRows: GraphRows = project(monoApp4, "dataflow-app");

function relCount(rows: GraphRows, type: string): number {
  return rows.edges.filter((e) => e.type === type).length;
}

/** Every id materialized as a `:CanNode` row: symbol-table ids + body-node fq ids + external/synth. */
function canNodeIds(app: V2Application): Set<string> {
  const ids = new Set(symbolIds(app));
  for (const c of allCallables(app.application)) {
    for (const k of Object.keys(c.body)) ids.add(k.startsWith("@") ? `${c.id}${k}` : `${c.id}@${k}`);
  }
  for (const id of Object.keys(app.application.external_symbols ?? {})) ids.add(id);
  for (const id of Object.keys(app.application.synthesized_callables ?? {})) ids.add(id);
  return ids;
}

/** Every `call` body node whose `callee` resolved to an id — the JSON-side source of RESOLVES_TO. */
function resolvesToCount(app: V2Application): number {
  let n = 0;
  for (const c of allCallables(app.application)) {
    for (const bn of Object.values(c.body)) if (typeof bn.callee === "string") n++;
  }
  return n;
}

describe("neo4j ↔ json count parity — full depth (issue #27)", () => {
  test("node count: 1 :Application row + every :CanNode id", () => {
    expect(monoRows.nodes.length).toBe(1 + canNodeIds(monoApp4).size);
  });

  test("typed overlay relationships match their JSON edge-list length 1:1", () => {
    const callables = allCallables(monoApp4.application);
    expect(relCount(monoRows, "CALLS")).toBe(monoApp4.application.call_graph.length);
    expect(relCount(monoRows, "PARAM_IN")).toBe(monoApp4.application.param_in.length);
    expect(relCount(monoRows, "PARAM_OUT")).toBe(monoApp4.application.param_out.length);
    expect(relCount(monoRows, "CFG_NEXT")).toBe(callables.reduce((n, c) => n + (c.cfg?.length ?? 0), 0));
    expect(relCount(monoRows, "CDG")).toBe(callables.reduce((n, c) => n + (c.cdg?.length ?? 0), 0));
    expect(relCount(monoRows, "DDG")).toBe(callables.reduce((n, c) => n + (c.ddg?.length ?? 0), 0));
    expect(relCount(monoRows, "SUMMARY")).toBe(callables.reduce((n, c) => n + (c.summary?.length ?? 0), 0));
  });

  test("containment relationships (HAS_*/DECLARES) match tree cardinality, not a JSON edge-list", () => {
    // HAS_MODULE/DECLARES/HAS_METHOD/HAS_FIELD/HAS_BODY_NODE have no JSON edge-list counterpart —
    // they ARE the containment tree. Every node except :Application and the off-tree External/
    // AnonymousCallable homes gets exactly one incoming containment edge from its tree parent, so
    // their total must equal every other CanNode id. (RESOLVES_TO and EXTENDS/IMPLEMENTS ALSO have
    // no top-level JSON edge-list — they're sourced from a body node's `callee` and a type node's
    // `extends_ids`/`implements_ids` props respectively — but they are not containment either, so
    // they're deliberately excluded from this invariant too; see the dedicated tests below and the
    // exhaustive edge-accounting test that folds every relationship family back into one total.)
    const containment = ["HAS_MODULE", "DECLARES", "HAS_METHOD", "HAS_FIELD", "HAS_BODY_NODE"];
    const containmentEdges = containment.reduce((n, t) => n + relCount(monoRows, t), 0);
    const externalCount = Object.keys(monoApp4.application.external_symbols ?? {}).length;
    const synthCount = Object.keys(monoApp4.application.synthesized_callables ?? {}).length;
    expect(containmentEdges).toBe(canNodeIds(monoApp4).size - externalCount - synthCount);
  });

  test("EXTENDS/IMPLEMENTS have no JSON edge-list (extends_ids/implements_ids node props are the source of truth); counts still match 1:1", () => {
    const types = allTypes(monoApp4);
    const extendsCount = types.reduce((n, t) => n + (t.extends_ids?.length ?? 0), 0);
    const implementsCount = types.reduce((n, t) => n + (t.implements_ids?.length ?? 0), 0);
    // sanity: dataflow-app's first-party hierarchy (src/hierarchy.ts) exercises both relationship
    // kinds — guards against a vacuous 0 === 0 pass if the fixture ever loses its heritage.
    expect(extendsCount).toBeGreaterThan(0);
    expect(implementsCount).toBeGreaterThan(0);
    expect(relCount(monoRows, "EXTENDS")).toBe(extendsCount);
    expect(relCount(monoRows, "IMPLEMENTS")).toBe(implementsCount);
  });

  test("every projected edge is accounted for: typed overlay + containment + RESOLVES_TO + EXTENDS/IMPLEMENTS sums to the total", () => {
    // The exhaustive form of the parity gate: unlike the per-family tests above (which only prove
    // each family individually matches its JSON source), this proves nothing is left over — if
    // project.ts ever grows a new relationship family without this test learning about it, the two
    // sides diverge and the gate fails, instead of silently passing on an incomplete accounting.
    const typedOverlay =
      relCount(monoRows, "CALLS") +
      relCount(monoRows, "PARAM_IN") +
      relCount(monoRows, "PARAM_OUT") +
      relCount(monoRows, "CFG_NEXT") +
      relCount(monoRows, "CDG") +
      relCount(monoRows, "DDG") +
      relCount(monoRows, "SUMMARY");
    const containment = ["HAS_MODULE", "DECLARES", "HAS_METHOD", "HAS_FIELD", "HAS_BODY_NODE"].reduce(
      (n, t) => n + relCount(monoRows, t),
      0,
    );
    const resolvesTo = relCount(monoRows, "RESOLVES_TO");
    const heritage = relCount(monoRows, "EXTENDS") + relCount(monoRows, "IMPLEMENTS");
    expect(resolvesTo).toBe(resolvesToCount(monoApp4));
    expect(typedOverlay + containment + resolvesTo + heritage).toBe(monoRows.edges.length);
  });
});
