/**
 * Config-key extraction for the artifact layer (#101): a structured config artifact's text →
 * `TSConfigKey` children — canonical dotted key, scalar value, recognized placeholder refs.
 * This unit parses the `.env` family (flat keys, namespace "env") and JSON configs (dotted
 * keys); YAML configs are artifact nodes without key extraction (no YAML dependency — spec'd).
 *
 * Pure overlay: every parser returns `{}` on failure, never raises — the artifact node is
 * emitted whether or not its structure was understood (python's rule).
 */
import type { TSConfigKey } from "../schema";

// `${VAR}`, `$VAR`, and `%(VAR)s` placeholders → recorded as env: refs (python's regex).
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%\(([A-Za-z_][A-Za-z0-9_]*)\)s/g;

function refsOf(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const out: string[] = [];
  for (const m of value.matchAll(PLACEHOLDER)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (name) {
      const ref = `env:${name}`;
      if (!out.includes(ref)) out.push(ref);
    }
  }
  return out;
}

const scalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

function keyNode(dotted: string, value: unknown, namespace?: string): TSConfigKey {
  return {
    id: "",
    kind: "config_key",
    key: dotted,
    ...(namespace !== undefined ? { namespace } : {}),
    ...(scalar(value) ? { value } : {}),
    references: refsOf(value),
  };
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*?)\s*$/;

function parseEnv(text: string): Record<string, TSConfigKey> {
  const out: Record<string, TSConfigKey> = {};
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = ENV_LINE.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    let value = m[2] as string;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = keyNode(key, value, "env");
  }
  return out;
}

function flattenJson(doc: unknown, prefix: string, out: Record<string, TSConfigKey>, depth: number): void {
  if (depth > 12 || typeof doc !== "object" || doc === null || Array.isArray(doc)) return;
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    const dotted = prefix ? `${prefix}.${k}` : k;
    if (scalar(v)) out[dotted] = keyNode(dotted, v);
    else flattenJson(v, dotted, out, depth + 1);
  }
}

function parseJson(text: string): Record<string, TSConfigKey> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return {};
  }
  const out: Record<string, TSConfigKey> = {};
  flattenJson(doc, "", out, 0);
  return out;
}

export function parseConfigKeys(fileName: string, suffix: string, text: string): Record<string, TSConfigKey> {
  if (fileName === ".env" || fileName.startsWith(".env.")) return parseEnv(text);
  if (suffix === ".json") return parseJson(text);
  return {};
}
