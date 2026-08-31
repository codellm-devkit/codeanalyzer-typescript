/**
 * Repository-artifact layer (#101), parity with codeanalyzer-python PR #160 / the ratified
 * 2026-08-27 spec: `inventoryArtifacts` walks the project once and returns the three
 * application sections — `artifacts` (every RULES-matched non-code file, verbatim `source`,
 * unbounded by decision), `dependencies` (flat, evidence-tagged, declared-only; locks backfill
 * `locked_version`), and `unresolved_imports` (the hygiene signal). Level-free: attached
 * identically at every `-a`. Not cached. Ids are stamped by assignIds (they embed `--app-name`).
 *
 * Discovery skips the source-walk's directory set; TS/JS source stays in the symbol table.
 * Extensionless files with a shebang are captured as `script` artifacts. Unmatched files are
 * NOT artifacts (rules-matched capture — python's posture).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_ARTIFACT_TEXT_MAX_BYTES } from "../options";
import type { AnalysisOptions } from "../options";
import type { TSArtifact, TSDependency, TSImportBinding, TSModule } from "../schema";
import { sha256 } from "../utils";
import { SKIP_DIRS } from "../syntactic_analysis/discovery";
import { matchRules } from "./rules";
import { applyLockVersions, parsePackageJson, readLock } from "./deps";
import { bindImports } from "./binding";

const SOURCE_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const JSON_LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "bun.lock"]);

export interface ArtifactLayer {
  artifacts: Record<string, TSArtifact>;
  dependencies: TSDependency[];
  unresolved_imports: TSImportBinding[];
}

export function inventoryArtifacts(
  root: string,
  opts: AnalysisOptions,
  symbol_table: Record<string, TSModule>,
): ArtifactLayer {
  const artifacts: Record<string, TSArtifact> = {};
  // Owning manifest's rel path → {name: locked version} (a lock pins its SIBLING package.json).
  const locks: Record<string, Record<string, string>> = {};
  const manifests: Array<{ rel: string; text: string }> = [];

  for (const rel of walk(root).sort()) {
    const base = path.basename(rel);
    const matched = matchRules(rel);
    let format = matched?.format;
    let roles = matched?.roles;
    const abs = path.join(root, rel);
    let raw: Buffer;
    try {
      raw = fs.readFileSync(abs);
    } catch {
      continue; // unreadable — skip, don't crash
    }
    if (!matched) {
      // extensionless shebang scripts are captured too (python PR #160)
      if (path.extname(base) === "" && raw.subarray(0, 2).toString("utf-8") === "#!") {
        format = "text";
        roles = ["script"];
      } else {
        continue; // rules-matched capture only
      }
    }
    const text = decodeLossy(raw);
    const capture = opts.artifactText ?? true;
    const cap = opts.artifactTextMaxBytes ?? DEFAULT_ARTIFACT_TEXT_MAX_BYTES;
    const textByteLength = text === undefined ? 0 : Buffer.byteLength(text, "utf8");
    const stored =
      !capture || text === undefined
        ? ""
        : textByteLength > cap
          ? Buffer.from(text, "utf8").subarray(0, cap).toString("utf8")
          : text;
    const node: TSArtifact = {
      id: "",
      kind: "artifact",
      path: rel,
      format: format as string,
      roles: roles as string[],
      size_bytes: raw.length,
      sha256: sha256(raw),
      source: stored,
      text_truncated: capture && text !== undefined && textByteLength > cap,
      extraction: "none",
    };
    artifacts[rel] = node;
    if (text === undefined) continue;
    if (base === "package.json") manifests.push({ rel, text });
    else if (JSON_LOCKFILES.has(base)) {
      const ownerRel = rel.split("/").slice(0, -1).concat("package.json").join("/");
      locks[ownerRel] = readLock(base, text);
      artifacts[rel].extraction = "full";
    }
  }

  // Declared records from every dependency-manifest package.json; sibling locks backfill.
  const dependencies: TSDependency[] = [];
  for (const { rel, text } of manifests) {
    const recs = parsePackageJson(text, rel); // declared_in = REL PATH; assignIds re-stamps the id
    const node = artifacts[rel];
    if (node) node.extraction = recs.length ? "full" : node.extraction;
    const lock = locks[rel];
    if (lock) applyLockVersions(recs, lock);
    dependencies.push(...recs);
  }

  const unresolved_imports = bindImports(symbol_table, dependencies, root, opts.resolveInstalled ?? false);
  return { artifacts, dependencies, unresolved_imports };
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
        if (SKIP_DIRS.has(e.name)) continue; // the guard is on containing DIRS — a `.env` file survives
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

/** utf-8 decode with a strict binary probe on the head; binary → undefined. */
function decodeLossy(raw: Buffer): string | undefined {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, Math.min(raw.length, 4096)));
  } catch {
    return undefined;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(raw);
}
