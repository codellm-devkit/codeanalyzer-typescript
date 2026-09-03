/**
 * `--program` shard selection (#146), unit 1 of the sharded two-wave L4 design.
 *
 * The load-bearing rule: selection must NOT change file→program assignment. `ownerProgram` falls
 * back to the ROOT program for any file no scope contains, so filtering the spec list *before*
 * assignment would hand a selected ancestor every file its deeper, unselected descendants own —
 * compiling them under the wrong tsconfig (wrong module resolution, wrong `paths`, wrong lib).
 * Ownership is computed globally and filtered afterwards. The second test is what catches a
 * regression to the other order.
 *
 * Programs are named by SCOPE, not by tsconfig path: `web/tsconfig.json` here only `references`
 * others, so it resolves to the leaf `web/src/tsconfig.app.json` under scope `web`, and two specs
 * can share one leaf config under different scopes.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { analyze, discoverPrograms } from "../src/core";
import type { AnalysisOptions } from "../src/options";

const APP = path.resolve("test/fixtures/multi-tsconfig-app");
const base = { input: APP, appName: "m", analysisLevel: 2, noBuild: true, emit: "json" };
const opts = (programFilter: string[] | null) => ({ ...base, programFilter } as unknown as AnalysisOptions);

type Envelope = { application: { symbol_table: Record<string, { id: string }> } };
const tableOf = (a: unknown) => (a as Envelope).application.symbol_table;
const modulesOf = (a: unknown) => Object.keys(tableOf(a)).sort();

describe("--program shard selection", () => {
  test("enumerates programs by scope, deepest first", () => {
    // deepest-first is the ordering ownerProgram depends on: first containing scope wins.
    expect(discoverPrograms(opts(null))).toEqual(["web", "<root>"]);
  });

  test("selecting an ancestor does NOT absorb a deeper program's files", async () => {
    // web/src/** is owned by scope `web`. Selecting only the root must leave those files OUT,
    // not compile them under the root tsconfig. Filter-then-assign would include both.
    const res = await analyze(opts(["<root>"]));
    expect(modulesOf(res.application)).toEqual(["src/server.ts", "src/util.ts"]);
  });

  test("selecting a program yields exactly the files it owns", async () => {
    const res = await analyze(opts(["web"]));
    expect(modulesOf(res.application)).toEqual(["web/src/app/service.ts", "web/src/main.ts"]);
  });

  test("selecting every program reproduces the unsharded module set and ids exactly", async () => {
    const whole = await analyze(opts(null));
    const sharded = await analyze(opts(discoverPrograms(opts(null))));
    expect(modulesOf(sharded.application)).toEqual(modulesOf(whole.application));
    // ids embed --input and --app-name, never the program, so they must be byte-identical
    const ids = (a: unknown) => Object.values(tableOf(a)).map((m) => m.id).sort();
    expect(ids(sharded.application)).toEqual(ids(whole.application));
  });

  test("the shards are disjoint and their union is the whole", async () => {
    const perShard: string[][] = [];
    for (const name of discoverPrograms(opts(null))) perShard.push(modulesOf((await analyze(opts([name]))).application));
    const flat = perShard.flat();
    expect(new Set(flat).size).toBe(flat.length); // ownerProgram assigns exactly one owner per file
    expect(flat.sort()).toEqual(modulesOf((await analyze(opts(null))).application));
  });

  test("an unmatched --program is a hard error, not a silently empty shard", async () => {
    await expect(analyze(opts(["nope"]))).rejects.toThrow(/no program matched/);
  });

  test("trailing slashes and './' spellings of a scope still match", async () => {
    expect(modulesOf((await analyze(opts(["./web/"]))).application)).toEqual([
      "web/src/app/service.ts",
      "web/src/main.ts",
    ]);
  });
});
