/**
 * The `can://` language namespace is per MODULE (#114).
 *
 * The analyzer owns both languages (JS discovery, #98), so a `.js` module must not be labelled
 * `typescript`. The :Application anchor deliberately keeps the analyzer's own language even when it
 * owns `javascript` children — a mixed repository has no single language, and the alternatives
 * moved every id in every projection or broke the single-anchor invariant (#43).
 * See docs/design/specs/js-language-namespace.md.
 */
import { describe, expect, test } from "bun:test";
import { applicationIdOf, languageOf, moduleIdOf } from "../src/schema/ids";

describe("per-module language namespace (#114)", () => {
  test.each([["a.ts"], ["a.tsx"], ["a.mts"], ["a.cts"]])("%s is typescript", (f) => {
    expect(languageOf(f)).toBe("typescript");
  });

  test.each([["b.js"], ["b.jsx"], ["b.mjs"], ["b.cjs"]])("%s is javascript", (f) => {
    expect(languageOf(f)).toBe("javascript");
  });

  // A declaration file is TypeScript. The suffix must not be read as `.ts` on a file named `a.d`.
  test("a .d.ts declaration file is typescript", () => {
    expect(languageOf("types/x.d.ts")).toBe("typescript");
    expect(moduleIdOf("app", "types/x.d.ts")).toBe("can://typescript/app/types/x.d.ts");
  });

  // The match is anchored: a DIRECTORY named `foo.js` must not make its .ts children javascript.
  test("a directory named *.js does not change its children's namespace", () => {
    expect(languageOf("vendor.js/index.ts")).toBe("typescript");
  });

  test("module ids carry their own namespace; the application anchor keeps typescript", () => {
    expect(applicationIdOf("app")).toBe("can://typescript/app");
    expect(moduleIdOf("app", "src/bar.ts")).toBe("can://typescript/app/src/bar.ts");
    expect(moduleIdOf("app", "lib/foo.js")).toBe("can://javascript/app/lib/foo.js");
  });
});
