/**
 * A `.js` file that no tsconfig `include` covers must still resolve — and a node the checker
 * genuinely cannot resolve must cost its own edges, never the run (#103).
 *
 * JS source discovery (#98) adds a discovered `.js` file to the program that owns its PATH, which
 * is not the same thing as the program whose `include` names it. A TypeScript project's tsconfig
 * normally leaves `allowJs` unset — false — so that file has no valid checker state, and resolving
 * ANY identifier in it throws inside tsc rather than returning undefined. On vscode a single such
 * mock (`extensions/microsoft-authentication/packageMocks/dpapi/dpapi.js`, `throw new Error(...)`)
 * aborted the whole 9,351-module analysis at -a 2, -a 3 and -a 4; -a 1 survived only because it
 * never resolves callees. The fixture here is that file, minimized.
 *
 * Two independent guarantees, tested apart: `createProject` forces `allowJs` on so the file
 * resolves properly, and `symbolAt` degrades a checker throw to undefined so any REMAINING
 * unresolvable node cannot take the run down.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { checkerFailures, resetCheckerFailures, symbolAt } from "../src/schema/checker";
import type { AnalysisOptions } from "../src/options";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/unresolvable-js-app");
const ID = "can://typescript/unresolvable-js-app";

function options(over: Partial<AnalysisOptions> = {}): AnalysisOptions {
  return {
    input: FIXTURE, output: null, emit: "json", appName: "unresolvable-js-app", neo4jUri: null,
    neo4jUser: "neo4j", neo4jPassword: "", neo4jDatabase: null, analysisLevel: 2, graphs: [],
    graphFieldDepth: 3, jobs: 1, targetFiles: null, skipTests: true, eager: true, noBuild: true,
    phantoms: true, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "cants-guard-")), verbosity: 0,
    ...over,
  } as AnalysisOptions;
}

describe("a .js file outside tsconfig's include still resolves (#103)", () => {
  test("-a 2 completes, and the JS file's own declarations land in the symbol table", async () => {
    const app = (await analyze(options())).application.application;

    const js = app.symbol_table["mocks/dpapi.js"];
    expect(js).toBeDefined();
    expect(Object.keys(js!.types ?? {})).toContain("defaultDpapi");
    const methods = Object.values((js!.types ?? {})["defaultDpapi"]?.callables ?? {}).map((c) => c.id);
    expect(methods).toContain(`${ID}/mocks/dpapi.js/defaultDpapi/protectData`);
    expect(methods).toContain(`${ID}/mocks/dpapi.js/defaultDpapi/unprotectData`);
  });

  test("its call edges resolve — with allowJs off, the checker threw before reaching them", async () => {
    const app = (await analyze(options())).application.application;
    const edges = app.call_graph.map((e) => `${e.src} -> ${e.dst}`);

    // Module-scope `new defaultDpapi()`, attributed to the MODULE. This edge does not merely go
    // missing without the fix — resolving it is what threw.
    expect(edges).toContain(`${ID}/mocks/dpapi.js -> ${ID}/mocks/dpapi.js/defaultDpapi/constructor`);
    // The healthy TypeScript file is unaffected either way.
    expect(edges).toContain(`${ID}/src/index.ts/run -> ${ID}/src/index.ts/greet`);
  });

  test("nothing is skipped any more — the checker resolves the file cleanly", async () => {
    await analyze(options());
    expect(checkerFailures()).toBe(0);
  });
});

describe("a checker throw degrades to unresolved, it does not abort (#103)", () => {
  test("symbolAt returns undefined and counts the failure", () => {
    resetCheckerFailures();
    const exploding = {
      getSymbol(): never {
        throw new TypeError("undefined is not an object (evaluating 'getSymbolOfDeclaration(location).members')");
      },
    };

    expect(symbolAt(exploding as never)).toBeUndefined();
    expect(checkerFailures()).toBe(1);
  });
});
