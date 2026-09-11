/**
 * The shipped discovery rules table (#101, python PR #160's mechanism): glob pattern against the
 * repo-relative POSIX path → (format, roles). Rules decide `format` and `roles` for matched
 * files; unmatched files are still inventoried by the walk in index.ts with `roles: ["unknown"]`
 * or `format: "binary"` when undecodable; extensionless shebangs are captured as `script` artifacts.
 */

export interface ArtifactRule {
  pattern: RegExp;
  format: string;
  roles: string[];
}

/**
 * Tiny glob→RegExp: `**` crosses directories, `*` does not. A pattern CONTAINING `/` anchors at
 * the repo root; a bare basename pattern matches at any depth (workspace-member package.json,
 * nested Dockerfiles).
 */
function glob(g: string): RegExp {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++; // `**/` also matches zero directories
      } else re += "[^/]*";
    } else if (".+^${}()|[]\\".includes(c)) re += `\\${c}`;
    else re += c;
  }
  return g.includes("/") ? new RegExp(`^${re}$`) : new RegExp(`^(?:.*/)?${re}$`);
}

const R = (g: string, format: string, roles: string[]): ArtifactRule => ({ pattern: glob(g), format, roles });

export const RULES: ArtifactRule[] = [
  // dependency manifests + locks (npm ecosystem)
  R("package.json", "json", ["dependency-manifest", "tool-config"]),
  R("package-lock.json", "json", ["dependency-manifest"]),
  R("npm-shrinkwrap.json", "json", ["dependency-manifest"]),
  R("bun.lock", "jsonc", ["dependency-manifest"]),
  R("yarn.lock", "yarnlock", ["dependency-manifest"]),
  R("pnpm-lock.yaml", "yaml", ["dependency-manifest"]),
  // tool configs
  R("tsconfig*.json", "json", ["tool-config"]),
  R("jsconfig*.json", "json", ["tool-config"]),
  R(".eslintrc*", "json", ["tool-config"]),
  R(".prettierrc*", "json", ["tool-config"]),
  R("babel.config.*", "text", ["tool-config"]),
  R("vite.config.*", "text", ["tool-config"]),
  R("webpack.config.*", "text", ["tool-config"]),
  R("Makefile", "text", ["tool-config"]),
  // containers / topology
  R("Dockerfile", "dockerfile", ["container-image"]),
  R("*.dockerfile", "dockerfile", ["container-image"]),
  R("Dockerfile.*", "dockerfile", ["container-image"]),
  R("docker-compose*.yml", "yaml", ["service-topology"]),
  R("docker-compose*.yaml", "yaml", ["service-topology"]),
  R("compose.yml", "yaml", ["service-topology"]),
  R("compose.yaml", "yaml", ["service-topology"]),
  R("k8s/**/*.yml", "yaml", ["service-topology"]),
  R("k8s/**/*.yaml", "yaml", ["service-topology"]),
  // ci
  R(".github/workflows/*.yml", "yaml", ["ci"]),
  R(".github/workflows/*.yaml", "yaml", ["ci"]),
  R(".gitlab-ci.yml", "yaml", ["ci"]),
  R("azure-pipelines.yml", "yaml", ["ci"]),
  // env
  R(".env", "env", ["env"]),
  R(".env.*", "env", ["env"]),
  // docs / legal
  R("*.md", "text", ["docs"]),
  R("*.rst", "text", ["docs"]),
  R("LICENSE*", "text", ["legal"]),
  R("COPYRIGHT*", "text", ["legal"]),
  R("NOTICE*", "text", ["legal"]),
  // View templates (#208). The role name is codeanalyzer-java's — its JSP/JSF/Thymeleaf rows
  // (ArtifactDiscovery.java, spec 2026-09-11 D1) coined `view-template` first, so it is ADOPTED
  // verbatim here rather than re-coined; see .claude/SCHEMA_DECISIONS.md. `format` names the
  // template language, one value per family. Classification is by extension and therefore
  // best-effort: a hand-written `.html` test input under a views/ directory reads as a view. The
  // artifact record itself (source, sha256, size) is identical either way.
  R("*.ejs", "ejs", ["view-template"]),
  R("*.hbs", "handlebars", ["view-template"]),
  R("*.handlebars", "handlebars", ["view-template"]),
  R("*.pug", "pug", ["view-template"]),
  R("*.njk", "nunjucks", ["view-template"]),
  R("*.liquid", "liquid", ["view-template"]),
  // Single-file components. Rendered server-side too, so they are views by the same test; a file
  // here staying an ARTIFACT is what makes this safe to land ahead of #209 — if a `.vue` later
  // also yields a symbol_table module, the role it already carries needs no re-decision.
  R("*.vue", "vue", ["view-template"]),
  R("*.svelte", "svelte", ["view-template"]),
  R("*.astro", "astro", ["view-template"]),
  // `.html` gets the role only under a convention directory, java's policy adopted with the name:
  // a static page and a rendered template are not distinguishable by file name, and `public/index.html`
  // is an asset. `views/` is Express' default, `templates/` the cross-framework spelling. `**/`
  // matches zero directories, so a repo-root `views/` matches too. Deliberately NO bare `*.html`
  // catch row — one would union `unknown` into these rows' roles.
  R("**/views/**/*.html", "html", ["view-template"]),
  R("**/views/**/*.htm", "html", ["view-template"]),
  R("**/templates/**/*.html", "html", ["view-template"]),
  R("**/templates/**/*.htm", "html", ["view-template"]),
  // config-shaped catch rows (python's `unknown` rows)
  R("*.toml", "toml", ["unknown"]),
  R("*.ini", "ini", ["unknown"]),
  R("*.cfg", "ini", ["unknown"]),
];

/** First matching rule wins; roles union across ALL matching rules (a compose file is both). */
export function matchRules(relPath: string): { format: string; roles: string[] } | null {
  let format: string | null = null;
  const roles: string[] = [];
  for (const r of RULES) {
    if (!r.pattern.test(relPath)) continue;
    if (format === null) format = r.format;
    for (const role of r.roles) if (!roles.includes(role)) roles.push(role);
  }
  return format === null ? null : { format, roles };
}
