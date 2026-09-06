import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RulesError, loadRules } from "../src/entrypoints/rules";
import { parseArgs } from "../src/cli";

const tmp = (text: string): string => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cants-rules-")), "r.yml");
  fs.writeFileSync(p, text);
  return p;
};

describe("rules loader", () => {
  test("shipped rules load and cover the frameworks the spec names", () => {
    const r = loadRules([]);
    expect(r.rulesets).toEqual(["shipped"]);
    expect(Object.keys(r.frameworks).sort()).toEqual(["angular", "nestjs", "nextjs", "sveltekit"]);
    expect(r.heuristics.decorators.map((d) => d.id)).toEqual(["heuristic.http-route", "heuristic.http-verb"]);
    expect(r.heuristics.calls.map((c) => c.id)).toEqual(["heuristic.http-verb-call"]);
    expect(r.manifest.map((m) => m.id)).toEqual(["manifest.bin", "manifest.main"]);
    // heuristic confidence is FORCED, whatever the file says
    for (const d of [...r.heuristics.decorators, ...r.heuristics.calls]) expect(d.confidence).toBe("heuristic");
  });

  test("a user file merges additively and records its origin", () => {
    const p = tmp("version: 1\nframeworks:\n  mine:\n    detect: [mine]\n    decorators:\n      - id: mine.route\n        match: mine.route\n");
    const r = loadRules([p]);
    expect(r.rulesets).toEqual(["shipped", `user:${p}`]);
    expect(r.frameworks.mine?.decorators[0]).toMatchObject({ id: "mine.route", confidence: "certain", origin: `user:${p}` });
    expect(r.frameworks.nestjs).toBeDefined(); // shipped rules survive
  });

  test("disable: removes a shipped rule by id, from every tier", () => {
    const r = loadRules([tmp("version: 1\ndisable: [nestjs.verb, heuristic.http-verb]\n")]);
    expect(r.frameworks.nestjs?.decorators.map((d) => d.id)).not.toContain("nestjs.verb");
    expect(r.heuristics.decorators.map((d) => d.id)).not.toContain("heuristic.http-verb");
  });

  test("malformed files are hard errors, never silently skipped", () => {
    expect(() => loadRules(["/nope/none.yml"])).toThrow(RulesError);
    expect(() => loadRules([tmp("- not a mapping")])).toThrow(/top level must be a mapping/);
    expect(() => loadRules([tmp("version: 1\nbogus: {}\n")])).toThrow(/unknown top-level key/);
    expect(() => loadRules([tmp("version: 1\nframeworks:\n  x:\n    decorators:\n      - id: x.a\n")])).toThrow(/missing `match`/);
    expect(() => loadRules([tmp("version: 1\nframeworks:\n  x:\n    decorators:\n      - id: x.a\n        match: '{a'\n")])).toThrow(RulesError);
    expect(() => loadRules([tmp("version: 1\nframeworks:\n  x:\n    decorators:\n      - {id: x.a, match: a, confidence: maybe}\n")])).toThrow(/confidence/);
    expect(() => loadRules([tmp("version: 1\nheuristics:\n  bogus: []\n")])).toThrow(/unknown heuristics key/);
    // ArgSpec.from is validated, not passed through String() unchecked: a typo must not load clean
    // and silently yield [] / positional-last (#issue-157 unit 3, Important 3).
    expect(() => loadRules([tmp("version: 1\nframeworks:\n  x:\n    decorators:\n      - {id: x.a, match: a, methods: {from: match_sufix}}\n")])).toThrow(/from/);
    expect(() => loadRules([tmp("version: 1\nheuristics:\n  calls:\n    - {id: h.a, match: a, handler: {from: keyword}}\n")])).toThrow(/handler/);
  });

  test("`detect` must be a list, not a bare scalar (Minor 1)", () => {
    expect(() => loadRules([tmp("version: 1\nframeworks:\n  x:\n    detect: \"@x/y\"\n")])).toThrow(/`detect` must be a list/);
  });

  test("--entrypoint-rules is repeatable and lands in options", () => {
    const o = parseArgs(["-i", ".", "--entrypoint-rules", "a.yml", "--entrypoint-rules", "b.yml"]);
    expect(o.entrypointRules).toEqual(["a.yml", "b.yml"]);
    expect(parseArgs(["-i", "."]).entrypointRules).toBeNull();
  });
});
