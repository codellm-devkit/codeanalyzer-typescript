/**
 * #53 — checker-known external/library calls resolve to `:TSExternal` phantoms instead of being
 * dropped. `resolveCalleeSignature` (src/schema/signatures.ts) already asks the ts-morph checker
 * for the callee's declaration; before this fix it only kept the result when the declaration lived
 * in-project (gated by `allSignatures`), silently discarding anything the checker resolved into
 * node_modules or the TS stdlib. The fixture (`external-calls.ts`) exercises the two cases the
 * pre-existing import-index phantom fallback (phantoms.ts) can't reach on its own: a member call on
 * a receiver that is itself external-typed but not an import binding (`cmd.name()`/`cmd.parse()` —
 * `cmd` is a local `const`, not an `import`), and a bare stdlib global with no import at all (`eval`).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Node, Project } from "ts-morph";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication, TSCallsite } from "../src/schema";
import { externalHomeOf } from "../src/schema/signatures";

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
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-ext-test-"));
  try {
    return (await analyze({ ...options(), cacheDir })).internal;
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

/** Every call site recorded on every top-level function of one module file. */
function callsIn(app: TSApplication, fileKey: string): TSCallsite[] {
  const mod = app.symbol_table[fileKey];
  const out: TSCallsite[] = [];
  for (const fn of Object.values(mod.functions)) out.push(...fn.call_sites);
  return out;
}

describe("external call resolution (#53)", () => {
  test("checker-resolved external targets become external_symbols with callee backfilled", async () => {
    const app = await run();

    const ext = Object.keys(app.external_symbols ?? {});
    // node:fs.readFileSync — a bare named-import call, already reachable via the pre-existing
    // import-index fallback (unaffected by #53; asserted here for shape parity).
    expect(ext.some((s) => s.includes("node:fs") && s.includes("readFileSync"))).toBe(true);
    // `new Command()` — checker-resolved to commander's ClassDeclaration (commander self-types);
    // the import-index fallback would name it identically, so both paths agree on one identity.
    // The genuinely checker-only case is `cmd.name()/.description()/.parse()`: member calls on
    // `cmd`, a local `const`, not an import binding — the syntactic index has nothing to key off
    // of, so only checker-based resolution (this fix) reaches them.
    expect(ext.some((s) => s.startsWith("commander"))).toBe(true);
    expect(ext.some((s) => /^commander\.(name|description|parse)$/.test(s))).toBe(true);
    // default-import member call (`neo4j.driver(...)`) → external neo4j-driver.driver.
    expect(ext.some((s) => s.startsWith("neo4j-driver") && s.includes("driver"))).toBe(true);
    // member calls on a LOCAL external-typed receiver (`d` — no import binding, checker-only):
    // MethodDeclaration members already resolved; the module is neo4j-driver-core because that
    // transitive package is where `Driver.session` is actually declared.
    expect(ext).toContain("neo4j-driver-core.session");
    // function-typed PropertyDeclaration member (`rxSession: (cfg?) => RxSession`) — the
    // framework-.d.ts shape (Express `app.get`, RxJS `subscribe`) that #53 must resolve.
    expect(ext).toContain("neo4j-driver.rxSession");
    // PropertySignature member on a nested receiver (`neo4j.auth.basic` — fallback-unreachable).
    expect(ext).toContain("neo4j-driver.basic");
    // a TS-stdlib global (eval, from lib.*.d.ts) with no import at all — checker-resolved, new in #53.
    expect(ext.some((s) => s.endsWith(".eval"))).toBe(true);

    const calls = callsIn(app, "src/external-calls.ts");
    expect(calls.length).toBeGreaterThan(0);
    // The checker-only member calls got their callee backfilled in place on the call site.
    const rx = calls.find((c) => c.method_name === "rxSession");
    expect(rx?.callee_signature).toBe("neo4j-driver.rxSession");
    const session = calls.find((c) => c.method_name === "session");
    expect(session?.callee_signature).toBe("neo4j-driver-core.session");
    const resolved = calls.filter((c) => c.callee_signature != null);
    expect(resolved.length / calls.length).toBeGreaterThanOrEqual(0.75);
  });
});

// ---- externalHomeOf unit tests: declaration path → module identity ---------------------------
// Each case plants a declaration at a synthetic node_modules path in an in-memory ts-morph
// project and asserts the module identity `externalHomeOf` derives from that path alone.
function declAt(filePath: string): Node {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile(filePath, "export declare function f(): void;");
  return sf.getFunctionOrThrow("f");
}

describe("externalHomeOf — declaration home classification (#53)", () => {
  test("@types/node files map to their node: specifier, not a collapsed `node` module", () => {
    expect(externalHomeOf(declAt("/proj/node_modules/@types/node/fs.d.ts"))).toEqual({ module: "node:fs" });
    // nested builtin modules keep their subpath
    expect(externalHomeOf(declAt("/proj/node_modules/@types/node/stream/consumers.d.ts"))).toEqual({
      module: "node:stream/consumers",
    });
    // the root index (globals like `process`) has no per-module specifier → plain `node`
    expect(externalHomeOf(declAt("/proj/node_modules/@types/node/index.d.ts"))).toEqual({ module: "node" });
  });

  test("other @types/<pkg> collapse onto the runtime package", () => {
    expect(externalHomeOf(declAt("/proj/node_modules/@types/commander/index.d.ts"))).toEqual({ module: "commander" });
  });

  test("pnpm virtual-store paths resolve to the innermost package, not .pnpm", () => {
    expect(externalHomeOf(declAt("/proj/node_modules/.pnpm/zod@3.24.1/node_modules/zod/index.d.ts"))).toEqual({
      module: "zod",
    });
    expect(
      externalHomeOf(declAt("/proj/node_modules/.pnpm/@types+node@22.0.0/node_modules/@types/node/fs.d.ts")),
    ).toEqual({ module: "node:fs" });
  });

  test("scoped packages keep their full @scope/name", () => {
    expect(externalHomeOf(declAt("/proj/node_modules/@scope/pkg/dist/index.d.ts"))).toEqual({ module: "@scope/pkg" });
  });

  test("the TS stdlib maps to (builtin), even though it lives under node_modules/typescript", () => {
    expect(externalHomeOf(declAt("/proj/node_modules/typescript/lib/lib.es5.d.ts"))).toEqual({ module: "(builtin)" });
    // non-lib typescript files are just the `typescript` package
    expect(externalHomeOf(declAt("/proj/node_modules/typescript/lib/typescript.d.ts"))).toEqual({
      module: "typescript",
    });
  });

  test("in-project declarations have no external home", () => {
    expect(externalHomeOf(declAt("/proj/src/app.ts"))).toBeNull();
  });
});
