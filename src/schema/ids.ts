/**
 * Canonical `can://` id construction for schema v2 (durable ids, ≥ callable depth) and the
 * member-key rule for the tree's named maps. Pure functions, no runtime imports — mirrors
 * python's `codeanalyzer/schema/ids.py`.
 *
 * Ids embed the app name (`--app-name`, per-invocation), while the symbol table round-trips the
 * analysis cache across runs — so ids are NEVER baked at build time; `assignIds` stamps every
 * node fresh each run (see assignIds.ts).
 */

const LANGUAGE = "typescript";
const JS_EXTS = /\.(jsx|js|mjs|cjs)$/;

/**
 * A module's language namespace, from its file key (#114).
 *
 * The analyzer owns both languages (JS discovery, #98), so this is per MODULE rather than per run:
 * a `.js` file is JavaScript and must not be labelled `typescript`. `.d.ts` falls through to the
 * default rather than matching, so a declaration file stays TypeScript.
 */
export function languageOf(fileKey: string): string {
  return JS_EXTS.test(fileKey) ? "javascript" : LANGUAGE;
}

/**
 * The :Application anchor keeps the analyzer's own language even when it owns `javascript`
 * children. A mixed repository has no single language, and the alternatives were a neutral anchor
 * (moves every id in every projection) or two anchors (breaks the single-anchor invariant, #43).
 * See docs/design/specs/js-language-namespace.md.
 */
export function applicationIdOf(appName: string): string {
  return `can://${LANGUAGE}/${appName}`;
}

/** Takes the app NAME, not the app id: a module's namespace is its own, not the application's. */
export function moduleIdOf(appName: string, fileKey: string): string {
  return `can://${languageOf(fileKey)}/${appName}/${fileKey}`;
}

/** The module/signature prefix: the file key without its TS/JS extension. */
export function modulePrefixOf(fileKey: string): string {
  return fileKey.replace(/\.d\.ts$/, "").replace(/\.(tsx|ts|jsx|js|mts|cts|mjs|cjs)$/, "");
}

/** The containment-path id of a descendant, derived from its dotted signature. */
export function idFromSig(moduleId: string, modulePrefix: string, sig: string): string {
  const tail = sig.startsWith(`${modulePrefix}.`) ? sig.slice(modulePrefix.length + 1) : sig;
  return `${moduleId}/${tail.split(".").join("/")}`;
}

/**
 * Repository-artifact ids. Leading "./" and "/" are dropped as SEPARATORS only — dotfiles
 * (`.env`, `.github/...`) keep their leading dot (python's rule).
 */
export function artifactIdOf(appName: string, relPath: string): string {
  let rel = relPath.replace(/\\/g, "/");
  while (rel.startsWith("./")) rel = rel.slice(2);
  rel = rel.replace(/^\/+/, "");
  // Language-NEUTRAL namespace (python PR #160): the first segment is `artifact`, not a
  // language — sibling analyzers over the same repo emit the SAME id for the same file.
  return `can://artifact/${appName}/${rel}`;
}

/** Config-key id: the owning artifact's id, `@key/`, then the dotted path. */
export function configKeyIdOf(artifactId: string, dotted: string): string {
  return `${artifactId}@key/${dotted}`;
}

/** Package URL for an npm package name — the cross-language package id (`pkg:npm/...`). */
export function purlNpm(name: string): string {
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    const scope = encodeURIComponent(name.slice(0, slash)); // "@scope" → "%40scope" (purl spec)
    return `pkg:npm/${scope}/${name.slice(slash + 1)}`;
  }
  return `pkg:npm/${name}`;
}

/** The map key for a callable/type within its parent: the last signature segment (+ accessor tag). */
export function memberKey(sig: string, accessorKind?: string | null): string {
  const seg = sig.split(".").pop() ?? sig;
  if (accessorKind === "getter") return `${seg}#get`;
  if (accessorKind === "setter") return `${seg}#set`;
  return seg;
}
