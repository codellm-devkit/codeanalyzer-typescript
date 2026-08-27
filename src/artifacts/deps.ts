/**
 * Dependency extraction (#101, python PR #160 parity): `package.json` manifests → FLAT
 * evidence-tagged `TSDependency` records on the application; the JSON lockfile family backfills
 * `locked_version` on the OWNING manifest's records (`prov` gains "lockfile"); lockfiles never
 * create records. Defensive throughout — a malformed file yields no records, never an exception.
 */
import type { TSDependency } from "../schema";

const SECTION_KIND: ReadonlyArray<[string, TSDependency["kind"]]> = [
  ["dependencies", "runtime"],
  ["devDependencies", "dev"],
  ["optionalDependencies", "optional"],
  ["peerDependencies", "peer"], // the spec'd additive npm token
];

/** Import specifiers this distribution provides: itself; `@types/x` also provides types-for-x. */
function providesOf(name: string): string[] {
  if (name.startsWith("@types/")) {
    const base = name.slice("@types/".length);
    // DefinitelyTyped mangles scoped names: @types/scope__pkg types @scope/pkg.
    const real = base.includes("__") ? `@${base.replace("__", "/")}` : base;
    return [name, real];
  }
  return [name];
}

export function parsePackageJson(text: string, declaredIn: string): TSDependency[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof doc !== "object" || doc === null) return [];
  const out: TSDependency[] = [];
  const seen = new Set<string>();
  for (const [section, kind] of SECTION_KIND) {
    const block = (doc as Record<string, unknown>)[section];
    if (typeof block !== "object" || block === null) continue;
    for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
      if (seen.has(name)) continue; // first section wins (npm merge order above)
      seen.add(name);
      out.push({
        name,
        spec: typeof spec === "string" ? spec : "",
        kind,
        extras: [],
        declared_in: declaredIn,
        provides_imports: providesOf(name),
        prov: ["declared"],
      });
    }
  }
  return out;
}

/**
 * `name → locked version` from a JSON-family lockfile. package-lock/npm-shrinkwrap: v2/v3
 * top-level `packages["node_modules/<name>"].version` (nested entries are transitive shadows),
 * v1 `dependencies{}` fallback. bun.lock (JSONC): `packages{ "<name>": ["<name>@<ver>", ...] }`.
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
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/,\s*([}\]])/g, "$1")); // tolerate bun's trailing commas
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

/** Backfill locked_version on DECLARED records; their `prov` gains "lockfile". */
export function applyLockVersions(deps: TSDependency[], lock: Record<string, string>): void {
  for (const dep of deps) {
    const v = lock[dep.name];
    if (v === undefined) continue;
    dep.locked_version = v;
    if (!dep.prov.includes("lockfile")) dep.prov.push("lockfile");
  }
}
