/**
 * Level-3 gate tests (issue #2): every verification gate from the dataflow contract, asserted
 * with exact expected sets on the dataflow-app fixture — CFG, dominance/CDG, DFG, the
 * PDG backward-slice gate, summaries (SCC fixpoint), SDG (no dangling endpoints), the
 * interprocedural slice, determinism, and the -a 1/-a 2 gating.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze, type AnalysisResult } from "../src/core";
import { backwardSlice } from "../src/dataflow";
import type { AnalysisOptions } from "../src/options";
import { forEachCallable, type CfgEdge, type FunctionCfg, type GraphSelector, type ProgramGraphs, type SdgEdge, type TSCallable } from "../src/schema";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/dataflow-app");

function options(level: 1 | 2 | 3, cacheDir: string, jobs: number, graphs: GraphSelector[]): AnalysisOptions {
  return {
    input: FIXTURE,
    output: null,
    emit: "json",
    appName: null,
    neo4jUri: null,
    neo4jUser: "neo4j",
    neo4jPassword: "",
    neo4jDatabase: null,
    analysisLevel: level,
    graphs,
    graphFieldDepth: 3,
    jobs,
    targetFiles: null,
    skipTests: true,
    eager: true,
    noBuild: true,
    phantoms: true,
    cacheDir,
    verbosity: 0,
  };
}

async function run(
  level: 1 | 2 | 3,
  jobs = 1,
  graphs: GraphSelector[] = ["cfg", "dfg", "pdg", "sdg"],
): Promise<AnalysisResult> {
  // Returns the full AnalysisResult — the program-graph IR rides on it, not on the tree.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-dataflow-test-"));
  try {
    return await analyze(options(level, cacheDir, jobs, graphs));
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

function callableOf(result: AnalysisResult, signature: string): TSCallable {
  let found: TSCallable | undefined;
  for (const mod of Object.values(result.internal.symbol_table)) {
    forEachCallable(mod, (callable) => {
      if (callable.signature === signature) found = callable;
    });
  }
  if (!found) throw new Error(`no callable for ${signature}`);
  return found;
}

const pg = (await run(3)).program_graphs as ProgramGraphs;

const cfgOf = (sig: string): FunctionCfg => {
  const g = pg.functions[sig]?.cfg;
  if (!g) throw new Error(`no cfg for ${sig}`);
  return g;
};
const pdgOf = (sig: string) => {
  const g = pg.functions[sig]?.pdg;
  if (!g) throw new Error(`no pdg for ${sig}`);
  return g.edges;
};
const cdgSet = (sig: string): string[] =>
  pdgOf(sig)
    .filter((e) => e.type === "CDG")
    .map((e) => `${e.source}>${e.target}`)
    .sort();
const ddgHas = (sig: string, source: number, target: number, v: string): boolean =>
  pdgOf(sig).some((e) => e.type === "DDG" && e.source === source && e.target === target && e.var === v);
const kinds = (sig: string, filter?: (e: CfgEdge) => boolean): CfgEdge[] =>
  cfgOf(sig).edges.filter(filter ?? (() => true));
const sdg = (filter: (e: SdgEdge) => boolean): SdgEdge[] => pg.sdg_edges.filter(filter);

// ------------------------------------------------------------------------------------------------
// CFG gate
// ------------------------------------------------------------------------------------------------

describe("CFG gate", () => {
  test("every function: single ENTRY (0) / single EXIT (last), contiguous span-ordered ids", () => {
    for (const [sig, g] of Object.entries(pg.functions)) {
      const cfg = g.cfg as FunctionCfg;
      expect(cfg.nodes.length, sig).toBeGreaterThanOrEqual(2);
      expect(cfg.nodes[0]?.kind, sig).toBe("entry");
      expect(cfg.nodes[cfg.nodes.length - 1]?.kind, sig).toBe("exit");
      cfg.nodes.forEach((n, i) => expect(n.id, sig).toBe(i));
      expect(cfg.nodes.filter((n) => n.kind === "entry" || n.kind === "exit"), sig).toHaveLength(2);
    }
  });

  test("every node maps to a real source span", () => {
    for (const [sig, g] of Object.entries(pg.functions)) {
      for (const n of (g.cfg as FunctionCfg).nodes) {
        expect(n.start_line, sig).toBeGreaterThanOrEqual(1);
        expect(n.end_line, sig).toBeGreaterThanOrEqual(n.start_line);
      }
    }
  });

  test("every node is reachable from ENTRY and reaches EXIT", () => {
    for (const [sig, g] of Object.entries(pg.functions)) {
      const cfg = g.cfg as FunctionCfg;
      const fwd = new Map<number, number[]>();
      const rev = new Map<number, number[]>();
      for (const e of cfg.edges) {
        fwd.set(e.source, [...(fwd.get(e.source) ?? []), e.target]);
        rev.set(e.target, [...(rev.get(e.target) ?? []), e.source]);
      }
      const bfs = (start: number, adj: Map<number, number[]>): Set<number> => {
        const seen = new Set([start]);
        const q = [start];
        while (q.length) for (const nx of adj.get(q.shift() as number) ?? []) if (!seen.has(nx)) (seen.add(nx), q.push(nx));
        return seen;
      };
      const fromEntry = bfs(0, fwd);
      const toExit = bfs(cfg.nodes.length - 1, rev);
      for (const n of cfg.nodes) {
        expect(fromEntry.has(n.id), `${sig}#${n.id} unreachable from ENTRY`).toBe(true);
        expect(toExit.has(n.id), `${sig}#${n.id} cannot reach EXIT`).toBe(true);
      }
    }
  });

  test("if/else lowers to true/false branch edges (classify)", () => {
    const e = kinds("src/flow.classify");
    expect(e).toContainEqual({ source: 3, target: 4, kind: "true" });
    expect(e).toContainEqual({ source: 3, target: 5, kind: "false" });
  });

  test("loops lower with a loop_back edge (sumTo)", () => {
    expect(kinds("src/flow.sumTo", (e) => e.kind === "loop_back")).not.toHaveLength(0);
  });

  test("a throwing call inside try edges to the catch node; finally may re-raise (guarded)", () => {
    const e = kinds("src/flow.guarded");
    expect(e).toContainEqual({ source: 3, target: 4, kind: "exception" }); // out = parse(s) → catch
    expect(e).toContainEqual({ source: 6, target: 8, kind: "exception" }); // finally → outward (EXIT)
  });

  test("throw with no handler edges to EXIT (parse)", () => {
    const cfg = cfgOf("src/flow.parse");
    const exit = cfg.nodes.length - 1;
    expect(cfg.edges.filter((e) => e.kind === "exception" && e.target === exit)).not.toHaveLength(0);
  });

  test("while (true) still emits the loop-exit false edge — the synthetic post-dominance edge (spin)", () => {
    expect(kinds("src/flow.spin")).toContainEqual({ source: 2, target: 6, kind: "false" });
    expect(kinds("src/flow.spin", (e) => e.kind === "break")).toHaveLength(1);
  });

  test("switch lowers to switch_case dispatch plus break edges (pickDay)", () => {
    expect(kinds("src/flow.pickDay", (e) => e.kind === "switch_case")).toHaveLength(3);
    expect(kinds("src/flow.pickDay", (e) => e.kind === "break")).toHaveLength(2);
  });

  test("await suspends via an await_resume edge (fetchTotal)", () => {
    expect(kinds("src/susp.fetchTotal")).toContainEqual({ source: 2, target: 3, kind: "await_resume" });
  });

  test("yield suspends via a yield edge (numbers)", () => {
    expect(kinds("src/susp.numbers")).toContainEqual({ source: 4, target: 5, kind: "yield" });
  });

  test("short-circuit / optional chaining stay intra-statement (shortCircuit has no branch edges)", () => {
    expect(kinds("src/susp.shortCircuit", (e) => e.kind === "true" || e.kind === "false")).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------
// Dominance gate (control dependence, hand-computed)
// ------------------------------------------------------------------------------------------------

describe("dominance gate", () => {
  test("classify: exact hand-computed control dependences", () => {
    expect(cdgSet("src/flow.classify")).toEqual(["0>1", "0>2", "0>3", "0>6", "3>4", "3>5"]);
  });

  test("early (early return): everything after the guard depends on it", () => {
    expect(cdgSet("src/flow.early")).toEqual(["0>1", "0>2", "2>3", "2>4", "2>5"]);
  });
});

// ------------------------------------------------------------------------------------------------
// DFG gate
// ------------------------------------------------------------------------------------------------

describe("DFG gate", () => {
  test("loop-carried dependency: acc feeds itself around the back edge (sumTo)", () => {
    expect(ddgHas("src/flow.sumTo", 4, 4, "acc")).toBe(true);
    expect(ddgHas("src/flow.sumTo", 3, 3, "i")).toBe(true);
  });

  test("shadowed variables do not leak edges across scopes (shadow)", () => {
    // outer x (node 1) → return (node 4); inner x (node 2) → touch(x) (node 3); never 2 → 4.
    expect(ddgHas("src/flow.shadow", 1, 4, "x")).toBe(true);
    expect(ddgHas("src/flow.shadow", 2, 3, "x")).toBe(true);
    expect(ddgHas("src/flow.shadow", 2, 4, "x")).toBe(false);
  });

  test("copy aliasing: a write through q reaches the read through p (useAlias)", () => {
    expect(ddgHas("src/closures.useAlias", 3, 4, "p.f")).toBe(true);
  });

  test("closure capture: the captured local flows into the declaring statement (makeCounter)", () => {
    expect(ddgHas("src/closures.makeCounter", 2, 3, "count")).toBe(true);
  });

  test("the closure body has its own graph, with the captured base defined at ENTRY", () => {
    const inc = pdgOf("src/closures.makeCounter.inc");
    expect(inc.some((e) => e.type === "DDG" && e.var === "count")).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// PDG gate — the intraprocedural backward slice, exact
// ------------------------------------------------------------------------------------------------

describe("PDG slice gate", () => {
  test("backward slice of classify's return equals the hand-computed node set", () => {
    // Node 2 (`let label = "none"`) is strongly killed on BOTH branches, so it is NOT in the slice.
    const slice = backwardSlice(pg, { signature: "src/flow.classify", node: 6 });
    const inClassify = [...slice].filter((k) => k.startsWith("src/flow.classify#")).sort();
    expect(inClassify).toEqual([
      "src/flow.classify#0",
      "src/flow.classify#1",
      "src/flow.classify#3",
      "src/flow.classify#4",
      "src/flow.classify#5",
      "src/flow.classify#6",
    ]);
    expect([...slice].every((k) => k.startsWith("src/flow.classify#"))).toBe(true); // no callers → intra only
  });
});

// ------------------------------------------------------------------------------------------------
// Summary + SDG gates
// ------------------------------------------------------------------------------------------------

describe("summary and SDG gates", () => {
  test("no dangling (signature, node_id) endpoints anywhere in the SDG", () => {
    const valid = new Map<string, number>();
    for (const [sig, g] of Object.entries(pg.functions)) valid.set(sig, (g.cfg as FunctionCfg).nodes.length);
    for (const e of pg.sdg_edges) {
      for (const end of [e.source, e.target]) {
        const n = valid.get(end.signature);
        expect(n, `dangling signature ${end.signature}`).toBeDefined();
        expect(end.node, `dangling node ${end.signature}#${end.node}`).toBeLessThan(n as number);
        expect(end.node).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("CALL edges target the callee ENTRY; positional PARAM_IN edges target `param` nodes", () => {
    for (const e of pg.sdg_edges) {
      if (e.type === "CALL") expect(e.target.node).toBe(0);
      if (e.type === "PARAM_IN" && e.var?.startsWith("arg")) {
        const callee = pg.functions[e.target.signature]?.cfg as FunctionCfg;
        expect(callee.nodes[e.target.node]?.kind, `${e.target.signature}#${e.target.node}`).toBe("param");
      }
    }
  });

  test("PARAM_IN arity: argN edges never exceed the callee's declared parameters", () => {
    for (const e of pg.sdg_edges) {
      if (e.type !== "PARAM_IN" || !e.var?.startsWith("arg")) continue;
      const callee = pg.functions[e.target.signature]?.cfg as FunctionCfg;
      const params = callee.nodes.filter((n) => n.kind === "param").length;
      expect(params, `${e.target.signature} has no params but receives ${e.var}`).toBeGreaterThan(0);
    }
  });

  test("the a → b → c chain: CALL / PARAM_IN / PARAM_OUT stitched at each hop", () => {
    expect(pg.sdg_edges).toContainEqual({
      source: { signature: "src/chain.a", node: 2 },
      target: { signature: "src/chain.b", node: 0 },
      type: "CALL",
    });
    expect(pg.sdg_edges).toContainEqual({
      source: { signature: "src/chain.a", node: 2 },
      target: { signature: "src/chain.b", node: 1 },
      type: "PARAM_IN",
      var: "arg0",
    });
    expect(pg.sdg_edges).toContainEqual({
      source: { signature: "src/chain.b", node: 4 },
      target: { signature: "src/chain.a", node: 2 },
      type: "PARAM_OUT",
      var: "return",
    });
  });

  test("SUMMARY gate: the composed transitive flow arg0 → return exists at a's callsite", () => {
    expect(pg.sdg_edges).toContainEqual({
      source: { signature: "src/chain.a", node: 2 },
      target: { signature: "src/chain.a", node: 2 },
      type: "SUMMARY",
      var: "arg0",
    });
  });

  test("cross-module (multi-file) SDG edges exist (viaOtherFile → util.increment)", () => {
    expect(pg.sdg_edges).toContainEqual({
      source: { signature: "src/chain.viaOtherFile", node: 2 },
      target: { signature: "src/util.increment", node: 1 },
      type: "PARAM_IN",
      var: "arg0",
    });
  });

  test("globals ride the SDG: transitive write and read of src/state.counter at churn's callsites", () => {
    expect(
      sdg(
        (e) =>
          e.type === "PARAM_OUT" &&
          e.var === "src/state.counter" &&
          e.source.signature === "src/state.bump" &&
          e.target.signature === "src/state.churn",
      ),
    ).toHaveLength(1);
    expect(
      sdg(
        (e) =>
          e.type === "PARAM_IN" &&
          e.var === "src/state.counter" &&
          e.source.signature === "src/state.churn" &&
          e.target.signature === "src/state.readCounter" &&
          e.target.node === 0,
      ),
    ).toHaveLength(1);
  });

  test("a global written by one callee then read by the next shows up as caller-local DDG (main)", () => {
    // bump(3) (node 1) transitively writes counter; a(readCounter()) (node 2) transitively reads it.
    expect(ddgHas("src/main.main", 1, 2, "src/state.counter")).toBe(true);
  });

  test("mutual recursion (isEven/isOdd) reaches a fixpoint and stitches both directions", () => {
    expect(sdg((e) => e.type === "CALL" && e.source.signature === "src/chain.isEven")).toHaveLength(1);
    expect(sdg((e) => e.type === "CALL" && e.source.signature === "src/chain.isOdd")).toHaveLength(1);
  });

  test("interprocedural backward slice of main's return: exact, context-sensitive", () => {
    const slice = backwardSlice(pg, { signature: "src/main.main", node: 3 });
    const bySig = new Map<string, number[]>();
    for (const k of slice) {
      const [sig, n] = k.split("#") as [string, string];
      bySig.set(sig, [...(bySig.get(sig) ?? []), Number(n)].sort((a, b) => a - b));
    }
    expect([...bySig.keys()].sort()).toEqual([
      "src/chain.a",
      "src/chain.b",
      "src/chain.c",
      "src/main.main",
      "src/state.bump",
      "src/state.readCounter",
    ]);
    expect(bySig.get("src/main.main")).toEqual([0, 1, 2, 3]);
    expect(bySig.get("src/chain.a")).toEqual([0, 1, 2, 3, 4]);
    expect(bySig.get("src/chain.c")).toEqual([0, 1, 2, 3]);
    expect(bySig.get("src/state.bump")).toEqual([0, 1, 2, 3]);
  });
});

// ------------------------------------------------------------------------------------------------
// Determinism + level gating
// ------------------------------------------------------------------------------------------------

describe("determinism and gating", () => {
  test("two runs on identical content emit byte-identical program_graphs", async () => {
    const second = await run(3);
    expect(JSON.stringify(second.program_graphs)).toBe(JSON.stringify(pg));
  });

  test("--jobs N (workers + wavefront) is byte-identical to --jobs 1 (the differential oracle)", async () => {
    const parallel = await run(3, 4);
    expect(JSON.stringify(parallel.program_graphs)).toBe(JSON.stringify(pg));
  }, 60_000);

  test("-a 1 emits no program_graphs section", async () => {
    const level1 = await run(1);
    expect(level1.program_graphs).toBeUndefined();
    expect(JSON.stringify(level1.application)).not.toContain("program_graphs");
  });

  test("schema_version and k_limit are stamped", () => {
    expect(pg.schema_version).toBe("1.0.0");
    expect(pg.k_limit).toBe(3);
  });

  test("--graphs selects attached fields without deleting compute dependencies", async () => {
    const dfg = await run(3, 1, ["dfg"]);
    const dfgCallable = callableOf(dfg, "src/flow.sumTo");
    expect(dfg.program_graphs?.functions["src/flow.sumTo"]?.cfg?.nodes.length).toBeGreaterThan(0);
    expect(dfgCallable.body["@entry"]).toBeDefined();
    expect(dfgCallable.cfg).toBeUndefined();
    expect(dfgCallable.cdg).toBeUndefined();
    expect(dfgCallable.ddg?.length).toBeGreaterThan(0);

    const cfg = await run(3, 1, ["cfg"]);
    const cfgCallable = callableOf(cfg, "src/flow.sumTo");
    expect(cfgCallable.cfg?.length).toBeGreaterThan(0);
    expect(cfgCallable.cdg).toBeUndefined();
    expect(cfgCallable.ddg).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------
// CLI flag validation (strict, non-zero exit — cli-contract.md)
// ------------------------------------------------------------------------------------------------

describe("--graphs flag validation", () => {
  const cli = (...args: string[]) =>
    Bun.spawnSync(["bun", "run", path.resolve(import.meta.dir, "../src/index.ts"), ...args], {
      cwd: path.resolve(import.meta.dir, ".."),
    });

  test("unknown --graphs value fails with a clear error, never a silent fallback", () => {
    const r = cli("-i", FIXTURE, "-a", "3", "--graphs", "cfg,bogus", "--no-build");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("unknown --graphs value 'bogus'");
  });

  test("--graphs without -a 3 is rejected", () => {
    const r = cli("-i", FIXTURE, "--graphs", "cfg", "--no-build");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("--graphs requires --analysis-level 3");
  });

  test("--graph-field-depth must be a positive integer", () => {
    const r = cli("-i", FIXTURE, "-a", "3", "--graph-field-depth", "zero", "--no-build");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("invalid --graph-field-depth");
  });

  test("--jobs must be a positive integer", () => {
    const r = cli("-i", FIXTURE, "-a", "3", "--jobs", "0", "--no-build");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("invalid --jobs");
  });
});
