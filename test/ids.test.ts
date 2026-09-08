/**
 * The `can://` grammar: `can://<app>/<lang>/<file>/<type>/<sig>`, application OUTERMOST.
 *
 * The language namespace is per MODULE (#114) — the analyzer owns both languages (JS discovery,
 * #98), so a `.js` module must not be labelled `typescript`. With the application outermost, both
 * namespaces are children of ONE `can://<app>/` prefix, so the application anchor no longer has to
 * pick a language for a mixed repository. See docs/design/specs/js-language-namespace.md.
 */
import { describe, expect, test } from "bun:test";
import { applicationIdOf, artifactIdOf, configKeyIdOf, languageOf, moduleIdOf } from "../src/schema/ids";

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
    expect(moduleIdOf("app", "types/x.d.ts")).toBe("can://app/typescript/types/x.d.ts");
  });

  // The match is anchored: a DIRECTORY named `foo.js` must not make its .ts children javascript.
  test("a directory named *.js does not change its children's namespace", () => {
    expect(languageOf("vendor.js/index.ts")).toBe("typescript");
  });

  test("module ids carry their own namespace, nested under the one application", () => {
    expect(applicationIdOf("app")).toBe("can://app");
    expect(moduleIdOf("app", "src/bar.ts")).toBe("can://app/typescript/src/bar.ts");
    expect(moduleIdOf("app", "lib/foo.js")).toBe("can://app/javascript/lib/foo.js");
  });
});

describe("the application is the outermost segment", () => {
  test("artifact ids nest under the app instead of forming a parallel scheme", () => {
    // Was can://artifact/<app>/<path> — a third top-level namespace. Now one rule.
    expect(artifactIdOf("app", "package.json")).toBe("can://app/artifact/package.json");
    expect(artifactIdOf("app", "./.env")).toBe("can://app/artifact/.env");
  });

  test("every id shares the application prefix — both language namespaces included", () => {
    // This is what makes ONE prefix-scoped delete correct where two used to be needed, so assert
    // it directly rather than inferring it from the mint functions.
    const app = applicationIdOf("app");
    for (const id of [
      moduleIdOf("app", "src/bar.ts"),
      moduleIdOf("app", "lib/foo.js"),
      artifactIdOf("app", "package.json"),
      configKeyIdOf(artifactIdOf("app", ".env"), "PAYMENT_HOST"),
      `${app}/@external/node:fs/readFileSync`,
    ]) {
      expect(id.startsWith(`${app}/`)).toBe(true);
    }
  });

  test("no id carries the old language-first shape", () => {
    for (const id of [applicationIdOf("app"), moduleIdOf("app", "lib/foo.js"), artifactIdOf("app", "package.json")]) {
      expect(id.startsWith("can://typescript/")).toBe(false);
      expect(id.startsWith("can://javascript/")).toBe(false);
      expect(id.startsWith("can://artifact/")).toBe(false);
    }
  });

  test("an app named after a language is still addressable (the segment-1 collision)", () => {
    // can://typescript/typescript/... is legal and unambiguous POSITIONALLY. Anything that reads
    // the language off the FIRST segment gets it wrong here; segment 2 is the language.
    expect(moduleIdOf("typescript", "lib/foo.js")).toBe("can://typescript/javascript/lib/foo.js");
    expect(moduleIdOf("javascript", "src/bar.ts")).toBe("can://javascript/typescript/src/bar.ts");
    expect(applicationIdOf("artifact")).toBe("can://artifact");
  });
});
