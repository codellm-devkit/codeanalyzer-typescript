import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/artifacts-app");
const opts = {
  input: FIXTURE, output: null, emit: "json", appName: "artifacts-app", neo4jUri: null,
  neo4jUser: "neo4j", neo4jPassword: "", neo4jDatabase: null, analysisLevel: 1, graphs: [],
  graphFieldDepth: 3, jobs: 1, targetFiles: null, skipTests: true, eager: true, noBuild: true,
  phantoms: true, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "cants-keys-")), verbosity: 0,
} as AnalysisOptions;

const arts = (await analyze(opts)).application.application.artifacts;
const keysOf = (p: string): Record<string, { value?: string | number | boolean; namespace: string; id: string; references: string[] }> =>
  Object.fromEntries((arts[p]?.config_keys ?? []).map((k) => [k.key, k]));

describe("config keys — flat and JSON (#101 unit B)", () => {
  test(".env keys land in the env namespace with refs and stripped quotes", () => {
    const k = keysOf(".env");
    expect(k["PAYMENT_HOST"]?.value).toBe("https://pay.example.com");
    expect(k["PAYMENT_HOST"]?.namespace).toBe("env");
    expect(k["DB_URL"]?.references).toEqual(["env:PAYMENT_HOST"]);
    expect(k["NODE_OPTIONS"]?.value).toBe("--max-old-space-size=4096");
  });

  test("JSONC tsconfig parses despite comments and trailing commas", () => {
    const k = keysOf("tsconfig.json");
    expect(k["compilerOptions.strict"]?.value).toBe(true);
    expect(k["compilerOptions.target"]?.value).toBe("ES2022");
    expect(k["include.0"]?.value).toBe("src"); // arrays get numeric segments
    expect(arts["tsconfig.json"]?.extraction).toBe("full");
  });

  test("key ids chain off the artifact id", () => {
    expect(keysOf(".env")["PAYMENT_HOST"]?.id).toBe("can://artifact/artifacts-app/.env@key/PAYMENT_HOST");
  });
});
