/**
 * #56 — multi-tsconfig program construction. The analyzer must discover more than one ts-morph
 * program in a monorepo and build each with its OWN compiler options, so files resolve under the
 * tsconfig that actually governs them.
 *
 * The fixture is a two-program monorepo:
 *   - root `tsconfig.json` — commonjs/node resolution, `exclude: ["web"]`
 *   - `web/tsconfig.json` — SOLUTION-STYLE (`files: []`, references `./src/tsconfig.app.json`)
 *   - `web/src/tsconfig.app.json` — bundler resolution with a `@app/*` path alias
 *
 * `web/src/main.ts` imports `@app/service`. That alias resolves ONLY under the web program's
 * tsconfig; under the root program it is an unresolved bare specifier. So the `main → svc` edge
 * resolving in-project is the discriminating signal that the web program was built with its own
 * options — which is exactly what fails before this feature (one root program swallows every file).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication } from "../src/schema";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/multi-tsconfig-app");

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
    analysisLevel: 2,
    graphs: [],
    graphFieldDepth: 3,
    jobs: 1,
    targetFiles: null,
    skipTests: true,
    eager: true,
    noBuild: true,
    phantoms: true,
    cacheDir: null,
    verbosity: 0,
  };
}

async function run(): Promise<TSApplication> {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-multitsconfig-test-"));
  try {
    return (await analyze({ ...options(), cacheDir })).internal;
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

async function runLevel3(): Promise<TSApplication> {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-multitsconfig-l3-"));
  try {
    const r = await analyze({ ...options(), analysisLevel: 3, graphs: ["cfg", "dfg", "pdg"], cacheDir });
    return r.application.application;
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

describe("multi-tsconfig program construction (#56)", () => {
  test("both programs' files are in one merged symbol table, each owned once", async () => {
    const app = await run();
    const keys = Object.keys(app.symbol_table);

    // Every discovered source file appears — the root program and the web program both contribute.
    expect(keys).toContain("src/server.ts");
    expect(keys).toContain("src/util.ts");
    expect(keys).toContain("web/src/main.ts");
    expect(keys).toContain("web/src/app/service.ts");

    // No file is built twice: exactly the four sources, each owned by exactly one program.
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
    expect(keys.length).toBe(4);
  });

  test("the web program's @app/* alias resolves in-project (not a phantom)", async () => {
    const app = await run();

    const edge = app.call_graph.find((e) => e.source === "web/src/main.boot");
    expect(edge).toBeDefined();
    // Resolved against the web program's own tsconfig → the real in-project callee signature,
    // provenance tsc, no external tag. Under the root program `@app/service` cannot resolve, so
    // before the fix this is either absent or an `@app/service.svc` phantom (provenance import).
    expect(edge?.target).toBe("web/src/app/service.svc");
    expect(edge?.provenance).toContain("tsc");
    expect(edge?.tags?.["ts.external"]).toBeUndefined();

    // The callee is a real symbol-table callable, not a minted external symbol.
    expect(Object.keys(app.external_symbols ?? {})).not.toContain("@app/service.svc");
  });

  // #111: extraction used to index every callable against the ROOT program alone. A file a DEEPER
  // program owns is absent from that index, so `if (!fn) continue` skipped it silently — the run
  // succeeded and produced no flow. Measured on vscode (92 programs, no root tsconfig): 1,204 of
  // 174,767 callables. Here the root tsconfig excludes `web`, so every web callable is owned by
  // the nested program and is exactly the case that vanished.
  test("L3 populates callables owned by the NESTED program, not just the root's (#111)", async () => {
    const app = await runLevel3();

    const web = app.symbol_table["web/src/main.ts"];
    expect(web, "web/src/main.ts missing from the symbol table").toBeDefined();
    const boot = (web!.functions ?? {})["boot"];
    expect(boot, "boot() missing").toBeDefined();
    expect(boot!.cfg?.length ?? 0, "nested-program callable got no CFG").toBeGreaterThan(0);
    expect(Object.keys(boot!.body ?? {}).some((k) => k === "@entry")).toBe(true);

    const svcMod = app.symbol_table["web/src/app/service.ts"];
    const svc = (svcMod?.functions ?? {})["svc"];
    expect(svc?.cfg?.length ?? 0, "nested-program callee got no CFG").toBeGreaterThan(0);

    // The root program's own callables keep working — this is a widening, not a swap.
    const server = (app.symbol_table["src/server.ts"]?.functions ?? {})["serve"];
    expect(server?.cfg?.length ?? 0, "root-program callable lost its CFG").toBeGreaterThan(0);
  });

  test("the root program's relative import still resolves (no regression)", async () => {
    const app = await run();
    const edge = app.call_graph.find((e) => e.source === "src/server.serve");
    expect(edge?.target).toBe("src/util.greet");
    expect(edge?.provenance).toContain("tsc");
  });
});
