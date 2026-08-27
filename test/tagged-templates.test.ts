/**
 * Tagged template expressions are call sites (#98): `inline\`url(...)\`` must record a `call`
 * body node and resolve a call edge to the tag — found missing by the vscode Joern ledger
 * (cssValue.ts's `inline` idiom), then crash-guarded (tagged templates have no arguments list).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-tagged-"));
fs.mkdirSync(path.join(dir, "src"));
fs.writeFileSync(
  path.join(dir, "src", "x.ts"),
  [
    "export function inline(strings: TemplateStringsArray, ...v: string[]): string { return ''; }",
    "export function asCSSUrl(): string { return inline`url('x')`; }",
    "export const top = inline`module-scope`;",
    "declare const unknownTag: any;",
    "export function throughLinker(): void { unknownTag`unresolved-tag`; }",
    "export function mkSheet(): number { return 1; }",
    "export function createRule(sel: string, sheet = mkSheet()): number { return sheet; }",
  ].join("\n"),
);

const opts = {
  input: dir, output: null, emit: "json", appName: "tagged", neo4jUri: null, neo4jUser: "neo4j",
  neo4jPassword: "", neo4jDatabase: null, analysisLevel: 2, graphs: [], graphFieldDepth: 3,
  jobs: 1, targetFiles: null, skipTests: true, eager: true, noBuild: true, phantoms: true,
  cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "cants-tagged-cache-")), verbosity: 0,
} as AnalysisOptions;
const result = await analyze(opts);
fs.rmSync(dir, { recursive: true, force: true });

describe("tagged template calls (#98)", () => {
  test("a tagged template resolves a call edge to its tag", () => {
    expect(result.internal.call_graph.some((e) => e.source === "src/x.asCSSUrl" && e.target === "src/x.inline")).toBe(true);
  });

  test("a module-scope tagged template is attributed to the module", () => {
    expect(result.internal.call_graph.some((e) => e.source === "src/x" && e.target === "src/x.inline")).toBe(true);
  });

  test("a parameter-default initializer call is attributed to the callable (#98)", () => {
    expect(result.internal.call_graph.some((e) => e.source === "src/x.createRule" && e.target === "src/x.mkSheet")).toBe(true);
  });

  test("the tagged call is a body call node with a refined callee", () => {
    const fn = result.application.application.symbol_table["src/x.ts"]?.functions["asCSSUrl"];
    const calls = Object.values(fn?.body ?? {}).filter((b) => b.kind === "call");
    expect(calls.length).toBe(1);
    expect(calls[0]?.callee).toBe("can://typescript/tagged/src/x.ts/inline");
  });
});
