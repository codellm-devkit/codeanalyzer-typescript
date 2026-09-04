import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";
import { populateL1Body } from "../src/schema/l1Body";
import type { AnalysisInternal, TSCallable, TSModule } from "../src/schema";
import { cacheFilePath, saveCache } from "../src/utils/cache";

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

describe("semantic cache validity", () => {
  test("save strips per-run callee resolution provenance", () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-cache-shape-"));
    try {
      const module = {
        functions: {
          caller: {
            call_sites: [{ callee_signature: "stale.target" }],
          },
        },
      } as unknown as TSModule;
      saveCache(cacheDir, { symbol_table: { "src/main.ts": module }, program_contexts: { "tsconfig.json": "hash" } });
      expect(fs.readFileSync(cacheFilePath(cacheDir), "utf8")).not.toContain("callee_signature");
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("warm output matches eager output after source and compiler-context changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cants-cache-context-"));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-cache-data-"));
    const sourceDir = path.join(root, "src");
    fs.mkdirSync(sourceDir);
    const mainPath = path.join(sourceDir, "main.ts");
    const targetPath = path.join(sourceDir, "target.ts");
    const configPath = path.join(root, "tsconfig.json");
    const dependencyDir = path.join(root, "node_modules", "dep");
    const declarationPath = path.join(dependencyDir, "index.d.ts");
    fs.mkdirSync(dependencyDir, { recursive: true });
    fs.writeFileSync(
      mainPath,
      'import { target } from "@target";\nimport { dep } from "dep";\n' +
        "export function current() { return target(); }\nexport function fromPackage() { return dep(); }\n",
    );
    fs.writeFileSync(targetPath, "export function target() { return 1; }\n");
    fs.writeFileSync(path.join(dependencyDir, "package.json"), '{"name":"dep","types":"index.d.ts"}');
    fs.writeFileSync(declarationPath, "export declare function dep(): number;\n");

    const writeConfig = (withAlias: boolean): void => {
      fs.writeFileSync(configPath, JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          ...(withAlias ? { baseUrl: ".", paths: { "@target": ["src/target.ts"] } } : {}),
        },
        include: ["src/**/*.ts"],
      }));
    };
    const options = (eager: boolean): AnalysisOptions => ({
      input: root,
      output: null,
      emit: "json",
      appName: "cache-context",
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
      eager,
      noBuild: true,
      phantoms: true,
      cacheDir,
      verbosity: 0,
    });

    try {
      writeConfig(true);
      await analyze(options(false));

      fs.writeFileSync(targetPath, 'export function target() { return "changed"; }\n');
      const warmSource = await analyze(options(false));
      const eagerSource = await analyze(options(true));
      expect(warmSource.application).toEqual(eagerSource.application);
      expect(warmSource.internal.symbol_table["src/main.ts"]?.functions.current?.return_type).toBe("string");

      fs.writeFileSync(declarationPath, "export declare function dep(): boolean;\n");
      const warmDeclaration = await analyze(options(false));
      const eagerDeclaration = await analyze(options(true));
      expect(warmDeclaration.application).toEqual(eagerDeclaration.application);
      expect(warmDeclaration.internal.symbol_table["src/main.ts"]?.functions.fromPackage?.return_type).toBe("boolean");

      writeConfig(false);
      const warmConfig = await analyze(options(false));
      const eagerConfig = await analyze(options(true));
      expect(warmConfig.application).toEqual(eagerConfig.application);
      expect(warmConfig.internal.symbol_table["src/main.ts"]?.functions.current?.return_type).toBe("any");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
