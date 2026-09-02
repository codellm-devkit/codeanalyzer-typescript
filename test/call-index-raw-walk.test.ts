/**
 * `indexCallExpressions` walks the raw compiler AST rather than ts-morph's `forEachDescendant`,
 * because the wrapper API caches a JS object per visited node on the SourceFile for the program's
 * lifetime (+5.09GB over the 6,758 files of vscode/src). The raw walk must index exactly the same
 * call sites under exactly the same keys as the wrapper walk it replaced — this pins that.
 */
import { describe, expect, test } from "bun:test";
import { Node, Project } from "ts-morph";
import { indexCallExpressions } from "../src/semantic_analysis/callGraph";

/** The wrapper-materialising walk this replaced, kept here as the differential oracle. */
function viaWrappers(project: Project): Map<string, Node> {
  const idx = new Map<string, Node>();
  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    if (sf.isDeclarationFile() || fp.includes("/node_modules/")) continue;
    sf.forEachDescendant((node) => {
      if (!Node.isCallExpression(node) && !Node.isNewExpression(node) && !Node.isTaggedTemplateExpression(node))
        return;
      const s = sf.getLineAndColumnAtPos(node.getStart());
      const e = sf.getLineAndColumnAtPos(node.getEnd());
      idx.set(`${fp}#${s.line}:${s.column}-${e.line}:${e.column}`, node);
    });
  }
  return idx;
}

describe("indexCallExpressions raw AST walk", () => {
  test("indexes the same call sites as the wrapper walk", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "/a.ts",
      [
        "function f(x: number): number { return x; }",
        "class C { m(): void {} static s(): void {} }",
        "function tag(s: TemplateStringsArray): string { return ''; }",
        "export function driver(): void {",
        "  f(1);",                                   // call
        "  new C().m();",                            // new + method call
        "  C.s();",                                  // static call
        "  tag`t`;",                                 // tagged template
        "  [1, 2].map((v) => f(v));",                // nested call in arrow
        "  (function () { return f(2); })();",       // IIFE
        "  f(f(f(3)));",                             // nested same-line calls
        "  const o = { k: () => new C() };",         // new inside object literal
        "  o.k();",
        "}",
        "export const modScope = f(9);",             // module-scope call
      ].join("\n"),
    );
    project.createSourceFile("/b.d.ts", "export declare function g(): void;"); // must be skipped

    const raw = indexCallExpressions(project);
    const oracle = viaWrappers(project);

    expect([...raw.keys()].sort()).toEqual([...oracle.keys()].sort());
    expect(raw.size).toBe(oracle.size);
    for (const [k, node] of raw) expect(node.getStart()).toBe((oracle.get(k) as Node).getStart());
    // sanity: the fixture really does contain the constructs, and .d.ts contributed nothing
    expect(raw.size).toBeGreaterThan(10);
    expect([...raw.keys()].every((k) => k.startsWith("/a.ts#"))).toBe(true);
  });
});
