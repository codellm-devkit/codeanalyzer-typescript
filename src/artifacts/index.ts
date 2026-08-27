/**
 * Repository-artifact layer (#101): the non-source file inventory, python-parity
 * (`codeanalyzer/artifacts/`, 51ee29e). `inventoryArtifacts(root, opts)` walks the project once
 * and returns the `application.artifacts` map — a `TSArtifact` per non-source file, with parsed
 * `TSDependency` / `TSConfigKey` children where the file is a recognized manifest or config.
 * Application-anchored and level-free: attached identically at every `-a` level. Not cached
 * (trivial cost). Ids are stamped later by assignIds (they embed `--app-name`).
 *
 * Discovery skips the same directory set the source walk ignores (`SKIP_DIRS`); TS/JS source
 * stays in the symbol table and is not re-inventoried. Nothing else is dropped: an unrecognized
 * file is still an artifact, classified `other`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AnalysisOptions } from "../options";
import { DEFAULT_ARTIFACT_TEXT_MAX_BYTES } from "../options";
import type { TSArtifact, TSArtifactKind } from "../schema";
import { sha256 } from "../utils";
import { SKIP_DIRS } from "../syntactic_analysis/discovery";
import { applyLockVersions, parsePackageJson, readLock } from "./deps";
import { parseConfigKeys } from "./config";

const SOURCE_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// A lockfile pins resolved_version on its OWNING manifest (the sibling package.json) only —
// a workspace member's lock never bleeds versions onto another member's manifest.
const JSON_LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "bun.lock"]);
const ALL_LOCKFILES = new Set([...JSON_LOCKFILES, "yarn.lock", "pnpm-lock.yaml", "bun.lockb"]);

export function inventoryArtifacts(root: string, opts: AnalysisOptions): Record<string, TSArtifact> {
  const captureText = opts.artifactText ?? true;
  const textCap = opts.artifactTextMaxBytes ?? DEFAULT_ARTIFACT_TEXT_MAX_BYTES;

  const artifacts: Record<string, TSArtifact> = {};
  // rel path → decoded text: the PARSE buffer, independent of `captureText` — disabling text
  // capture never disables dependency/config extraction (python's rule).
  const texts: Record<string, string | undefined> = {};
  // Owning manifest's rel path → {name: resolved_version}.
  const locks: Record<string, Record<string, string>> = {};

  for (const rel of walk(root).sort()) {
    const abs = path.join(root, rel);
    let raw: Buffer;
    try {
      raw = fs.readFileSync(abs);
    } catch {
      continue; // unreadable (permissions, race) — skip, don't crash
    }
    const { text, truncated } = decode(raw, textCap);
    texts[rel] = text;
    const node: TSArtifact = {
      id: "",
      kind: "artifact",
      artifact_kind: classify(rel),
      path: rel,
      ...(formatOf(rel) !== undefined ? { format: formatOf(rel) } : {}),
      content_hash: sha256(raw),
      size_bytes: raw.length,
      text_truncated: false,
      dependencies: {},
      config_keys: {},
    };
    if (captureText && text !== undefined) {
      node.text = text;
      node.text_encoding = "utf-8";
      node.text_truncated = truncated;
    }
    artifacts[rel] = node;
    const base = path.basename(rel);
    if (JSON_LOCKFILES.has(base) && text !== undefined) {
      const ownerRel = rel.split("/").slice(0, -1).concat("package.json").join("/");
      locks[ownerRel] = readLock(base, text);
    }
  }

  // Attach dependency / config-key children off the parse buffers.
  for (const [rel, node] of Object.entries(artifacts)) {
    const text = texts[rel];
    if (text === undefined) continue;
    const base = path.basename(rel);
    if (base === "package.json") {
      const deps = parsePackageJson(text);
      const lock = locks[rel]; // only this manifest's OWN lockfile
      if (lock) applyLockVersions(deps, lock);
      if (Object.keys(deps).length) node.dependencies = deps;
      continue;
    }
    const keys = parseConfigKeys(base, path.extname(rel).toLowerCase(), text);
    if (Object.keys(keys).length) node.config_keys = keys;
  }

  return artifacts;
}

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        // A `.env` FILE is an artifact; a skip-named DIRECTORY is pruned — the guard is on
        // containing components only, so a file named like a skip entry is still inventoried.
        if (SKIP_DIRS.has(e.name)) continue;
        visit(abs);
      } else if (e.isFile()) {
        if (SOURCE_EXTS.has(path.extname(e.name))) continue; // source lives in the symbol table
        out.push(path.relative(root, abs).split(path.sep).join("/"));
      }
    }
  };
  visit(root);
  return out;
}

/**
 * Decode up to `textCap` bytes as utf-8 — `{text, truncated}` or `{text: undefined}` for
 * binary. A strict probe of the head detects binary (real binary fails long before the cap);
 * the capped decode itself is lossy-tolerant so a cap landing mid-codepoint drops only the
 * split trailing bytes (python's exact posture).
 */
function decode(raw: Buffer, textCap: number): { text: string | undefined; truncated: boolean } {
  const truncated = raw.length > textCap;
  const head = raw.subarray(0, textCap);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, Math.min(head.length, 4096)));
  } catch {
    return { text: undefined, truncated: false }; // binary
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(head), truncated };
}

// --- classification (name/extension → artifact_kind + format), npm-ecosystem rules table -----

const KIND_BY_SUFFIX: Record<string, TSArtifactKind> = {
  ".yml": "configuration",
  ".yaml": "configuration",
  ".json": "configuration",
  ".toml": "configuration",
  ".ini": "configuration",
  ".cfg": "configuration",
  ".properties": "configuration",
  ".conf": "configuration",
  ".tf": "infrastructure",
  ".tfvars": "infrastructure",
  ".md": "documentation",
  ".rst": "documentation",
  ".txt": "documentation",
  ".sh": "script",
  ".bash": "script",
  ".csv": "data",
  ".sql": "data",
};

const FORMAT_BY_SUFFIX: Record<string, string> = {
  ".yml": "yaml",
  ".yaml": "yaml",
  ".json": "json",
  ".toml": "toml",
  ".ini": "ini",
  ".cfg": "ini",
  ".properties": "properties",
};

function classify(rel: string): TSArtifactKind {
  const name = path.basename(rel);
  const suffix = path.extname(rel).toLowerCase();
  if (name === ".env" || name.startsWith(".env.")) return "configuration";
  if (ALL_LOCKFILES.has(name)) return "dependency_lockfile";
  if (name === "package.json") return "build_manifest";
  if (name === "Dockerfile" || name.startsWith("Dockerfile")) return "container";
  if (name.includes("compose") && (suffix === ".yml" || suffix === ".yaml")) return "container";
  if (isCi(rel)) return "ci";
  return KIND_BY_SUFFIX[suffix] ?? "other";
}

function isCi(rel: string): boolean {
  return (
    rel.startsWith(".github/workflows/") ||
    [".gitlab-ci.yml", ".travis.yml", "azure-pipelines.yml"].includes(path.basename(rel))
  );
}

function formatOf(rel: string): string | undefined {
  const name = path.basename(rel);
  if (name === ".env" || name.startsWith(".env.")) return "env";
  if (name === "bun.lock") return "jsonc";
  if (name === "yarn.lock") return "yarnlock";
  if (name === "Dockerfile" || name.startsWith("Dockerfile")) return "dockerfile";
  return FORMAT_BY_SUFFIX[path.extname(rel).toLowerCase()];
}
