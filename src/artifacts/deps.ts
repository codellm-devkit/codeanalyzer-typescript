/**
 * Dependency extraction for the artifact layer (#101): `package.json` manifests → declared
 * `TSDependency` records, and the JSON lockfile family → `resolved_version` backfill on the
 * OWNING manifest's records only. Declared-only this unit: lockfiles never create records, and
 * transitive-only packages are skipped (`direct: false` stays reserved).
 *
 * Every parser is defensive — a malformed file yields `{}`, never an exception, so the artifact
 * node it hangs off is emitted regardless (python's overlay rule).
 */
import type { TSDependency, TSDependencyScope } from "../schema";

/** npm manifest section → shared scope vocabulary (`peer` is the spec'd additive token). */
const SCOPE_BY_SECTION: ReadonlyArray<[string, TSDependencyScope]> = [
  ["dependencies", "runtime"],
  ["devDependencies", "development"],
  ["optionalDependencies", "optional"],
  ["peerDependencies", "peer"],
];

export function parsePackageJson(text: string): Record<string, TSDependency> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof doc !== "object" || doc === null) return {};
  const out: Record<string, TSDependency> = {};
  for (const [section, scope] of SCOPE_BY_SECTION) {
    const block = (doc as Record<string, unknown>)[section];
    if (typeof block !== "object" || block === null) continue;
    for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
      // First section wins on a duplicate name (runtime > dev > optional > peer, the npm merge
      // order above); later sections never downgrade an existing record's scope.
      if (name in out) continue;
      out[name] = {
        id: "",
        kind: "dependency",
        name,
        ...(typeof spec === "string" ? { version_spec: spec } : {}),
        ecosystem: "npm",
        scope,
        direct: true,
      };
    }
  }
  return out;
}

/**
 * `name → resolved version` from a JSON-family lockfile. `package-lock.json` /
 * `npm-shrinkwrap.json`: v2/v3 `packages["node_modules/<name>"].version` (top-level entries
 * only — nested `node_modules/a/node_modules/b` are transitive shadows), falling back to v1
 * `dependencies{}`. `bun.lock` (JSONC): `packages{ "<name>": ["<name>@<version>", ...] }`.
 */
export function readLock(fileName: string, text: string): Record<string, string> {
  if (fileName === "bun.lock") return readBunLock(text);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof doc !== "object" || doc === null) return {};
  const out: Record<string, string> = {};
  const packages = (doc as Record<string, unknown>)["packages"];
  if (typeof packages === "object" && packages !== null) {
    for (const [key, entry] of Object.entries(packages as Record<string, unknown>)) {
      const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (!m) continue;
      const version = (entry as Record<string, unknown> | null)?.["version"];
      if (typeof version === "string") out[m[1] as string] = version;
    }
    if (Object.keys(out).length) return out;
  }
  const v1 = (doc as Record<string, unknown>)["dependencies"];
  if (typeof v1 === "object" && v1 !== null) {
    for (const [name, entry] of Object.entries(v1 as Record<string, unknown>)) {
      const version = (entry as Record<string, unknown> | null)?.["version"];
      if (typeof version === "string") out[name] = version;
    }
  }
  return out;
}

function readBunLock(text: string): Record<string, string> {
  // bun.lock is JSONC-ish: tolerate trailing commas (the one deviation bun actually emits).
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  const packages = (doc as Record<string, unknown> | null)?.["packages"];
  if (typeof packages !== "object" || packages === null) return {};
  for (const [name, entry] of Object.entries(packages as Record<string, unknown>)) {
    const first = Array.isArray(entry) ? entry[0] : undefined;
    if (typeof first !== "string") continue;
    const at = first.lastIndexOf("@");
    if (at > 0) out[name] = first.slice(at + 1);
  }
  return out;
}

/** Backfill `resolved_version` on DECLARED records — lockfiles never create records. */
export function applyLockVersions(deps: Record<string, TSDependency>, lock: Record<string, string>): void {
  for (const [name, dep] of Object.entries(deps)) {
    const v = lock[name];
    if (v !== undefined) dep.resolved_version = v;
  }
}
