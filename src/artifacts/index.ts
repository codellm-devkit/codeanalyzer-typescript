/**
 * Repository-artifact layer (#101), parity with codeanalyzer-python PR #160 / the ratified
 * 2026-08-27 spec: `inventoryArtifacts` walks the project once and returns the three
 * application sections — `artifacts` (every RULES-matched non-code file, verbatim `source`,
 * unbounded by decision), `dependencies` (flat, evidence-tagged: `direct:true` declared records
 * from manifests, plus `direct:false` transitive records for lock-pinned packages no manifest
 * names; locks backfill `locked_version` on declared records), and `unresolved_imports` (the
 * hygiene signal). Level-free: attached
 * identically at every `-a`. Not cached. Ids are stamped by assignIds (they embed `--app-name`).
 *
 * Discovery skips the source-walk's directory set; TS/JS source stays in the symbol table.
 * All non-source files are captured: rules-matched files carry their designated roles, extensionless
 * shebang files are `script` artifacts, and everything else is `unknown` (text or binary).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AnalysisOptions } from "../options";
import type { TSArtifact, TSDependency, TSImportBinding, TSModule } from "../schema";
import { sha256 } from "../utils";
import { SKIP_DIRS } from "../syntactic_analysis/discovery";
import { matchRules } from "./rules";
import { applyLockVersions, parsePackageJson, readLock, transitiveRecords } from "./deps";
import { bindImports } from "./binding";
import { extractConfigKeys } from "./configKeys";
import { deploymentEnvKeys } from "./deployEnv";

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
  // Same key → the lock file's OWN rel path (the transitive records' `declared_in` attribution).
  const lockPathOf: Record<string, string> = {};
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
      // Never drop: a file without a rule is still inventoried. Extensionless shebang files are
      // scripts; everything else decodable is `unknown`; undecodable bytes are hash-only.
      const probe = decodeLossy(raw);
      if (path.extname(base) === "" && raw.subarray(0, 2).toString("utf-8") === "#!") {
        format = "text";
        roles = ["script"];
      } else if (probe === undefined) {
        format = "binary";
        roles = ["unknown"];
      } else {
        format = "text";
        roles = ["unknown"];
      }
    }
    const text = decodeLossy(raw);
    // Captured whole or not at all -- there is no byte cap. A truncated `source` is a prefix that
    // reads like a complete file, and every consumer then needs a flag to tell the two apart;
    // `--no-artifact-text` remains the way to opt out of the payload entirely.
    const capture = opts.artifactText ?? true;
    const stored = !capture || text === undefined ? "" : text;
    const node: TSArtifact = {
      id: "",
      kind: "artifact",
      path: rel,
      format: format as string,
      roles: roles as string[],
      size_bytes: raw.length,
      sha256: sha256(raw),
      source: stored,
      extraction: "none",
      config_keys: [],
    };
    artifacts[rel] = node;
    if (text === undefined) continue;
    if (base === "package.json") manifests.push({ rel, text });
    else if (JSON_LOCKFILES.has(base)) {
      const ownerRel = rel.split("/").slice(0, -1).concat("package.json").join("/");
      locks[ownerRel] = readLock(base, text);
      lockPathOf[ownerRel] = rel;
      artifacts[rel].extraction = "full";
    }
    // Config keys: attempted for every namespace-eligible format; a throw means the file is
    // config-shaped but unparseable → keep the node, mark partial (overlay posture).
    if (["env", "json", "jsonc", "ini", "properties", "yaml"].includes(node.format)) {
      try {
        const keys = extractConfigKeys(node.format, node.roles, text);
        if (keys.length) {
          node.config_keys = keys;
          node.extraction = node.extraction === "none" ? "full" : node.extraction;
        }
        // Deployment-env keys (#101 unit D): additive on top of the structural keys above.
        // Compose/k8s mint theirs from `keys` (the same yaml parse — no second one); a throw from
        // extractConfigKeys above already skipped straight to the catch below, so a malformed
        // document never reaches here either.
        const deployKeys = deploymentEnvKeys(node.format, node.roles, text, keys);
        if (deployKeys.length) {
          node.config_keys = [...node.config_keys, ...deployKeys];
          node.extraction = "full";
        }
      } catch {
        node.extraction = "partial";
      }
    } else if (node.format === "dockerfile") {
      // Not namespace-eligible above (no structural extractConfigKeys case for it), but ENV/ARG
      // still mint deploy keys; the line-based parse never throws, so no try/catch needed.
      const deployKeys = deploymentEnvKeys(node.format, node.roles, text);
      if (deployKeys.length) {
        node.config_keys = deployKeys;
        node.extraction = "full";
      }
    }
  }
  if (opts.artifactText === false) {
    for (const art of Object.values(artifacts)) {
      for (const ck of art.config_keys) delete ck.value;
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

  // Lock-only packages (pinned, never declared in any manifest): direct:false transitive records,
  // attributed to the lock that pinned them (python PR #160 parity — supply chain, not just surface).
  const declaredNames = new Set(dependencies.map((d) => d.name));
  for (const [ownerRel, pins] of Object.entries(locks).sort(([a], [b]) => a.localeCompare(b))) {
    const lockRel = lockPathOf[ownerRel] as string;
    const lockArtifact = artifacts[lockRel];
    if (!lockArtifact) continue;
    dependencies.push(...transitiveRecords(pins, declaredNames, lockRel)); // rel path; assignIds re-stamps
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
