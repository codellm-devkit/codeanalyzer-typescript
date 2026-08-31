/**
 * Config-key extraction (#101 unit B): a config-bearing artifact's text → flattened dotted keys.
 * Pure overlay — every parser returns [] on failure so the artifact node survives (the caller
 * marks `extraction: "partial"`). Parses the FULL on-disk text, never the stored `source`.
 */
import type { TSConfigKey, TSSpan } from "../schema";
import { parseYamlKeys } from "./yamlKeys";

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

export function referencesOf(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const out: string[] = [];
  for (const m of value.matchAll(PLACEHOLDER)) {
    const name = m[1] ?? m[2];
    if (name && !out.includes(`env:${name}`)) out.push(`env:${name}`);
  }
  return out;
}

const scalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

export function keyNode(key: string, namespace: string, value: unknown, span?: TSSpan): TSConfigKey {
  return {
    id: "",
    key,
    namespace,
    ...(scalar(value) ? { value } : {}),
    ...(span ? { span } : {}),
    references: referencesOf(value),
  };
}

/**
 * Strip `//`/block comments, then trailing commas — tsconfig/rc files are JSONC. TWO
 * passes, each independently string-aware (the string alternative is tried first in both,
 * so it always wins for anything that opens with `"` and is returned verbatim):
 *   1. remove comments — so a trailing comma separated from its `}`/`]` only by a comment
 *      (`1, // note\n}`) is reachable by pass 2;
 *   2. collapse `,\s*[}\]]`, but only outside strings — so `"hi, }"` and `"dist/{cjs,}"`
 *      still survive byte-for-byte.
 * One merged pass can't do both: by the time it would strip a trailing comma, a comment
 * sitting between the comma and the bracket hasn't been removed yet.
 */
export function parseJsonc(text: string): unknown {
  const noComments = text.replace(
    /"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (m) => (m.startsWith('"') ? m : ""),
  );
  const stripped = noComments.replace(
    /"(?:[^"\\]|\\.)*"|,\s*([}\]])/g,
    (m, bracket?: string) => (m.startsWith('"') ? m : (bracket ?? "")),
  );
  return JSON.parse(stripped);
}

function flatten(doc: unknown, prefix: string, out: TSConfigKey[], ns: string, depth: number): void {
  if (depth > 24 || doc === null || typeof doc !== "object") return;
  const entries: Array<[string, unknown]> = Array.isArray(doc)
    ? doc.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(doc as Record<string, unknown>);
  for (const [k, v] of entries) {
    const dotted = prefix ? `${prefix}.${k}` : k;
    if (scalar(v)) out.push(keyNode(dotted, ns, v));
    else flatten(v, dotted, out, ns, depth + 1);
  }
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*?)\s*$/;

export function parseEnvKeys(text: string): TSConfigKey[] {
  const out: TSConfigKey[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith("#")) return;
    const m = ENV_LINE.exec(line);
    if (!m) return;
    let value = m[2] as string;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const span: TSSpan = { start: [i + 1, 1], end: [i + 1, line.length + 1], bytes: [0, 0] };
    out.push(keyNode(m[1] as string, "env", value, span));
  });
  return out;
}

/** INI / .properties: `[section]` prefixes a dotted key space. */
export function parseIniKeys(text: string, namespace: string): TSConfigKey[] {
  const out: TSConfigKey[] = [];
  let section = "";
  text.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith(";")) return;
    const sec = /^\[([^\]]+)\]$/.exec(t);
    if (sec) {
      section = sec[1] as string;
      return;
    }
    const eq = t.indexOf("=");
    if (eq <= 0) return;
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim();
    const span: TSSpan = { start: [i + 1, 1], end: [i + 1, line.length + 1], bytes: [0, 0] };
    out.push(keyNode(section ? `${section}.${key}` : key, namespace, value, span));
  });
  return out;
}

/**
 * Dispatch by artifact format. A dependency manifest or lockfile is never also a config file
 * (codeanalyzer-python v1.3.0 parity) — gated on `roles`, not `format`, since both package.json
 * (json) and lockfiles (json/jsonc) would otherwise pass the format check below. YAML is handled
 * by yamlKeys.ts (Task 5).
 */
export function extractConfigKeys(format: string, roles: string[], text: string): TSConfigKey[] {
  if (roles.includes("dependency-manifest")) return [];
  switch (format) {
    case "env":
      return parseEnvKeys(text);
    case "json":
    case "jsonc": {
      const out: TSConfigKey[] = [];
      flatten(parseJsonc(text), "", out, "json", 0);
      return out;
    }
    case "ini":
      return parseIniKeys(text, "ini");
    case "properties":
      return parseIniKeys(text, "properties");
    case "yaml":
      return parseYamlKeys(text);
    default:
      return [];
  }
}
