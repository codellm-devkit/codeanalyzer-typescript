import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { materialize } from "../src/build";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import { populateL1Body } from "../src/schema/l1Body";
import type { AnalysisInternal, TSCallable, TSModule } from "../src/schema";
import { buildSymbolTable } from "../src/syntactic_analysis";
import { loadCache, Logger } from "../src/utils";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/sample-app");

describe("l1Body tolerates a stale-cache callable (#101 fix round 1)", () => {
  test("callable missing config_accesses (call_sites present) does not throw", () => {
    // Simulates a TSCallable deserialized from a .codeanalyzer cache written before Task 7 added
    // `config_accesses` — loadCache only invalidates on analyzer_version change, not shape, so a
    // same-version warm cache can hand resetCallable an object narrower than today's TSCallable
    // contract. `call_sites` present, `config_accesses` deliberately OMITTED; `as unknown as`
    // documents this as an intentional stand-in for stale cached data, not an oversight.
    const stale = {
      body: {},
      call_sites: [
        {
          start_line: 5, start_column: 3, end_line: 5, end_column: 10, bytes: [40, 47],
          method_name: "foo", argument_types: [], type_arguments: [],
          is_constructor_call: false, is_optional_chain: false,
        },
      ],
    } as unknown as TSCallable;
    const mod = { functions: { stale }, types: {} } as unknown as TSModule;
    const app = { symbol_table: { "x.ts": mod } } as unknown as AnalysisInternal;

    expect(() => populateL1Body(app)).not.toThrow();

    const kinds = Object.values(stale.body).map((n) => n.kind);
    expect(kinds).toEqual(["call"]); // call_sites still processed normally
    expect(kinds).not.toContain("config_access"); // nothing to materialize; no crash either
  });
});

test("complete warm Level-1 cache hits skip projects and preserve output", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-l1-cache-"));
  const opts: AnalysisOptions = {
    input: FIXTURE,
    output: null,
    emit: "json",
    appName: "sample-app",
    neo4jUri: null,
    neo4jUser: "neo4j",
    neo4jPassword: "",
    neo4jDatabase: null,
    analysisLevel: 1,
    graphs: [],
    graphFieldDepth: 3,
    jobs: 1,
    targetFiles: null,
    skipTests: true,
    eager: false,
    noBuild: true,
    phantoms: true,
    cacheDir,
    verbosity: 0,
  };

  try {
    const cold = await analyze(opts);
    const cached = loadCache(cacheDir);
    expect(cached, "cold analysis cache").not.toBeNull();

    const log = new Logger(0);
    const result = buildSymbolTable(opts, materialize(opts, log), cached!.symbol_table, log);
    expect(result.project).toBeUndefined();
    expect(result.programs).toHaveLength(0);

    const warm = await analyze(opts);
    expect(warm.application).toEqual(cold.application);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
