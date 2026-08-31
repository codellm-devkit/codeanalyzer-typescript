/**
 * A node the TypeScript checker cannot resolve must cost its own edges, never the run (#103).
 *
 * ts-morph's symbol queries run tsc's checker, and the checker throws — rather than returning
 * undefined — on a global referenced from a `.js` file that no tsconfig `include` covers, because
 * that file lands in a program with no default lib. On vscode a single such mock
 * (`extensions/microsoft-authentication/packageMocks/dpapi/dpapi.js`, `throw new Error(...)`)
 * aborted the whole 9,351-module analysis at -a 2, -a 3 and -a 4; -a 1 was unaffected because it
 * never resolves callees. The fixture here is that file, minimized.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { checkerFailures } from "../src/schema/checker";
import type { AnalysisOptions } from "../src/options";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/unresolvable-js-app");

function options(over: Partial<AnalysisOptions> = {}): AnalysisOptions {
  return {
    input: FIXTURE, output: null, emit: "json", appName: "unresolvable-js-app", neo4jUri: null,
    neo4jUser: "neo4j", neo4jPassword: "", neo4jDatabase: null, analysisLevel: 2, graphs: [],
    graphFieldDepth: 3, jobs: 1, targetFiles: null, skipTests: true, eager: true, noBuild: true,
    phantoms: true, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "cants-guard-")), verbosity: 0,
    ...over,
  } as AnalysisOptions;
}

describe("unresolvable nodes degrade, they do not abort (#103)", () => {
  test("-a 2 completes and still resolves the edges it can", async () => {
    const r = await analyze(options());
    const app = r.application.application;

    // The run produced a real symbol table rather than dying partway.
    const modules = Object.keys(app.symbol_table);
    expect(modules.some((m) => m.endsWith("src/index.ts"))).toBe(true);
    expect(modules.some((m) => m.endsWith("mocks/dpapi.js"))).toBe(true);

    // The unresolvable node cost only itself: run() -> greet() still resolves in the healthy file.
    const edges = app.call_graph.map((e) => `${e.src} -> ${e.dst}`);
    expect(edges).toContain("can://typescript/unresolvable-js-app/src/index.ts/run -> can://typescript/unresolvable-js-app/src/index.ts/greet");
  });

  test("the skipped resolutions are counted, not silently swallowed", async () => {
    await analyze(options());
    // Two `throw new Error(...)` sites in the fixture; the linker revisits them, so assert the
    // signal exists rather than pinning an exact revisit count.
    expect(checkerFailures()).toBeGreaterThan(0);
  });

  test("-a 1 is unaffected — it never resolves callees", async () => {
    const r = await analyze(options({ analysisLevel: 1 }));
    expect(Object.keys(r.application.application.symbol_table).length).toBeGreaterThan(0);
  });
});
