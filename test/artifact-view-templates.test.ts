/**
 * View-template artifact roles (#208). The role name `view-template` is NOT coined here: it is
 * codeanalyzer-java's, from its JSP/JSF/Thymeleaf rows (ArtifactDiscovery.java, spec 2026-09-11 D1),
 * adopted verbatim under the cross-language parity clause. The `.html`-stays-unknown policy is
 * adopted with it — see the comment on the rules rows.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { matchRules } from "../src/artifacts/rules";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication } from "../src/schema";

describe("matchRules: template extensions carry the view-template role (#208)", () => {
  test("each shipped template extension, with its own format", () => {
    const cases: Array<[string, string]> = [
      ["views/page.ejs", "ejs"],
      ["views/mail.hbs", "handlebars"],
      ["src/emails/welcome.handlebars", "handlebars"],
      ["views/layout.pug", "pug"],
      ["templates/index.njk", "nunjucks"],
      ["theme/product.liquid", "liquid"],
      ["src/Widget.vue", "vue"],
      ["src/App.svelte", "svelte"],
      ["src/pages/index.astro", "astro"],
    ];
    for (const [rel, format] of cases) expect(matchRules(rel), rel).toEqual({ format, roles: ["view-template"] });
  });

  test("`.html`/`.htm` only under a views/templates convention directory, at any depth", () => {
    for (const rel of ["views/page.html", "templates/mail.htm", "src/server/views/admin/user.html", "app/templates/a/b.html"]) {
      expect(matchRules(rel), rel).toEqual({ format: "html", roles: ["view-template"] });
    }
    // A bare page is a static asset, not a rendered view, and the two are indistinguishable by
    // name — java's own reasoning. No rule matches, so the walk files it as `unknown`.
    for (const rel of ["public/index.html", "index.html", "docs/api.html"]) expect(matchRules(rel), rel).toBeNull();
  });

  test("non-templates keep the roles they had", () => {
    expect(matchRules("package.json")?.roles).toEqual(["dependency-manifest", "tool-config"]);
    expect(matchRules("README.md")?.roles).toEqual(["docs"]);
    expect(matchRules("tsconfig.json")?.roles).toEqual(["tool-config"]);
    // The role never unions in from a second row: `views/x.html` matches ONE rule, not the
    // catch rows, so no `unknown` rides along.
    expect(matchRules("views/x.html")?.roles).not.toContain("unknown");
  });
});

describe("end to end: templates reach application.artifacts with the role (#208)", () => {
  test("a project of one template per shape", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-208-"));
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "views-app", dependencies: {} }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2020" }, include: ["**/*.ts"] }),
      "src/real.ts": "export const x = 1;\n",
      "views/page.ejs": "<h1><%= title %></h1>\n",
      "src/Widget.vue": "<template><p>{{ msg }}</p></template>\n",
      "src/pages/index.astro": "---\nconst t = 1;\n---\n<h1>{t}</h1>\n",
      "views/shell.html": "<html><body></body></html>\n",
      "public/index.html": "<html><body></body></html>\n",
      "README.md": "# views-app\n",
    };
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    const opts = { input: dir, output: null, emit: "json", appName: "views-app", neo4jUri: null, neo4jUser: "neo4j",
      neo4jPassword: "", neo4jDatabase: null, analysisLevel: 1, graphs: [], graphFieldDepth: 3, jobs: 1,
      targetFiles: null, skipTests: true, eager: true, noBuild: true, phantoms: true,
      cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "cants-208-cache-")), verbosity: 0 } as unknown as AnalysisOptions;
    const root = (await analyze(opts)).application.application as TSApplication;
    const arts = root.artifacts;
    for (const key of ["views/page.ejs", "src/Widget.vue", "src/pages/index.astro", "views/shell.html"]) {
      expect(arts[key]?.roles, key).toEqual(["view-template"]);
    }
    expect(arts["public/index.html"]?.roles).toEqual(["unknown"]);
    expect(arts["README.md"]?.roles).toEqual(["docs"]);
    // A template file is an artifact, not a module — unchanged by this issue (#209 owns that).
    expect(Object.keys(root.symbol_table)).toEqual(["src/real.ts"]);
  });
});
