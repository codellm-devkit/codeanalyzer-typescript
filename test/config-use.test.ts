import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/artifacts-app");
function options(level: number): AnalysisOptions {
  return {
    input: FIXTURE, output: null, emit: "json", appName: "artifacts-app", neo4jUri: null,
    neo4jUser: "neo4j", neo4jPassword: "", neo4jDatabase: null, analysisLevel: level,
    graphs: level >= 3 ? ["cfg", "dfg", "pdg", "sdg"] : [], graphFieldDepth: 3, jobs: 1,
    targetFiles: null, skipTests: true, eager: true, noBuild: true, phantoms: true,
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "cants-cu-")), verbosity: 0,
  } as AnalysisOptions;
}

const r1 = await analyze(options(1));
const mod = r1.application.application.symbol_table["src/config.ts"];

describe("config_access body nodes (#101 unit C1)", () => {
  test("member, element, and destructured env reads all mint nodes with keys", () => {
    const nodesOf = (fn: string) => Object.values(mod?.functions[fn]?.body ?? {}).filter((b) => b.kind === "config_access");
    expect(nodesOf("readHost").map((n) => n.key)).toEqual(["PAYMENT_HOST"]);
    expect(nodesOf("readFlag").map((n) => n.key)).toEqual(["FEATURE_FLAG"]);
    expect(nodesOf("readDestructured").map((n) => n.key)).toEqual(["NODE_OPTIONS"]);
    expect(nodesOf("readHost")[0]?.root).toBe("process.env");
    expect(nodesOf("readHost")[0]?.callee).toBeUndefined(); // a read is not a call
  });

  test("a dynamic key mints a node with no key", () => {
    const n = Object.values(mod?.functions["readVia"]?.body ?? {}).filter((b) => b.kind === "config_access");
    expect(n.length).toBe(1);
    expect(n[0]?.key).toBeUndefined();
  });
});
