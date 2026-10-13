/**
 * Deployment-env sources (#101 unit D): Dockerfile ENV, compose `environment`, and k8s container
 * `env` mint BINDABLE `env`-namespace keys — the ones a later `process.env.X` read joins — in
 * addition to whatever structural key the file already produced. Dockerfile ARG mints a
 * `dockerfile`-namespace key that is deliberately NON-bindable: build-time only, never joins a
 * runtime read.
 *
 * `deploymentEnvKeys` is role-gated exactly like `extractConfigKeys` (a dependency-manifest —
 * e.g. pnpm-lock.yaml, format "yaml" — must not gain env keys either, same as it gains no
 * structural ones). For "yaml" it takes the ALREADY-flattened keys `extractConfigKeys` /
 * `parseYamlKeys` produced for this same artifact rather than re-parsing the text: one YAML parse
 * per artifact. A throw from that upstream parse (malformed compose/k8s YAML) is not this
 * module's problem — the caller's try/catch around the structural pass already turns it into
 * `extraction: "partial"` before this function is ever reached, so a broken document mints zero
 * deploy keys, not a second throw. Dockerfile has no structural pass to reuse, so it parses
 * `text` directly — a line-based scan that can never throw, unlike JSON.parse/YAML.parse.
 */
import { keyNode } from "./configKeys";
import type { TSConfigKey, TSSpan } from "../schema";

const DOCKER_LINE = /^\s*(ENV|ARG)\s+(.*)$/i;
const ESCAPE_DIRECTIVE = /^\s*#\s*escape\s*=\s*([\\`])\s*$/i;

// POSIX-shell variable-name grammar (python v1.3.0's _ENV_KEY_NAME, adopted verbatim): gates
// which compose list-form leaves are real env-var declarations vs. junk.
const ENV_KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface DockerInstruction {
  text: string;
  startLine: number;
  endLine: number;
  endColumn: number;
  escape: string;
}

function logicalDockerInstructions(text: string): DockerInstruction[] {
  const instructions: DockerInstruction[] = [];
  const lines = text.split("\n");
  let escape = "\\";
  let active = false;
  let logical = "";
  let startLine = 1;

  lines.forEach((line, index) => {
    const directive = ESCAPE_DIRECTIVE.exec(line);
    if (!active && directive) {
      escape = directive[1] as string;
      return;
    }
    if (!active) {
      active = true;
      startLine = index + 1;
    }

    const trimmed = line.trimEnd();
    let escapes = 0;
    for (let i = trimmed.length - 1; i >= 0 && trimmed[i] === escape; i--) escapes++;
    const continued = escapes % 2 === 1;
    logical += continued ? trimmed.slice(0, -1) : line;
    if (continued) return;

    instructions.push({
      text: logical,
      startLine,
      endLine: index + 1,
      endColumn: line.length + 1,
      escape,
    });
    active = false;
    logical = "";
  });

  if (active) {
    const endLine = lines.length;
    instructions.push({
      text: logical,
      startLine,
      endLine,
      endColumn: (lines[endLine - 1]?.length ?? 0) + 1,
      escape,
    });
  }
  return instructions;
}

function dockerWords(text: string, escape: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = (): void => {
    if (!current) return;
    words.push(current);
    current = "";
  };

  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === escape && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      push();
    } else {
      current += char;
    }
  }
  if (escaped) current += escape;
  push();
  return words;
}

/** Parse logical ENV/ARG instructions with Docker quoting and escape continuations. */
export function parseDockerfileEnv(text: string): TSConfigKey[] {
  const byKey = new Map<string, TSConfigKey>();
  for (const instruction of logicalDockerInstructions(text)) {
    const match = DOCKER_LINE.exec(instruction.text);
    if (!match) continue;
    const directive = (match[1] as string).toUpperCase();
    const words = dockerWords((match[2] as string).trim(), instruction.escape);
    if (words.length === 0) continue;
    const span: TSSpan = {
      start: [instruction.startLine, 1],
      end: [instruction.endLine, instruction.endColumn],
      bytes: [0, 0],
    };
    const namespace = directive === "ENV" ? "env" : "dockerfile";
    const assignments: Array<[string, string | undefined]> = [];

    if (directive === "ENV" && !words[0]?.includes("=")) {
      assignments.push([words[0] as string, words.slice(1).join(" ")]);
    } else {
      for (const word of words) {
        const equals = word.indexOf("=");
        if (equals < 0) {
          if (directive === "ARG") assignments.push([word, undefined]);
          continue;
        }
        assignments.push([word.slice(0, equals), word.slice(equals + 1)]);
      }
    }

    for (const [name, value] of assignments) {
      if (!ENV_KEY_NAME.test(name)) continue;
      byKey.set(`${namespace}:${name}`, keyNode(name, namespace, value, span));
    }
  }
  return [...byKey.values()];
}

/**
 * compose `services.<svc>.environment` (map or list form) and k8s
 * `(spec|template.spec).containers[].env[].name`/`.value` → bindable env keys, matched against
 * the ALREADY-flattened yaml keys (see module docstring — one parse per artifact). A
 * multi-document stream prefixes every flattened key with its zero-based document index
 * (`0.services…`, `1.spec…` — yamlKeys.ts), so both compose patterns below — anchored at
 * `^services` — spell out an optional leading `<digits>.` segment; the k8s pattern's leading
 * `.*` already absorbs that prefix without needing the same treatment.
 */
export function yamlEnvKeys(flat: TSConfigKey[]): TSConfigKey[] {
  const out: TSConfigKey[] = [];
  const seen = new Set<string>();
  const push = (name: string, value: unknown, span?: TSSpan): void => {
    if (!name || seen.has(name)) return; // first occurrence wins — deterministic, source order
    seen.add(name);
    out.push(keyNode(name, "env", value, span));
  };
  for (const k of flat) {
    // compose list form: [doc.]services.<svc>.environment.<i> = "NAME=value". Checked BEFORE the
    // map-form pattern below, even though map-form's `[^.]+` would also match a bare digit: a
    // real env var name can never be pure digits (POSIX naming), so a numeric last segment is
    // unambiguously a list index, never a name — and map-form must not steal it and mint a
    // variable literally called "0".
    const composeList = /^(?:\d+\.)?services\.[^.]+\.environment\.\d+$/.exec(k.key);
    if (composeList && typeof k.value === "string") {
      // "KEY=value" AND bare "KEY" both mint — compose's own syntax for a bare list entry is
      // "inherit this variable from the host environment", a real bindable declaration, not
      // dropped convenience. "KEY=" (an "=" present, empty right side) mints an EMPTY-STRING
      // value; bare "KEY" (no "=" at all) mints NO value — same valueless shape as the k8s
      // valueFrom case below. Either way, a name that isn't a valid env var name stays dropped.
      const eq = k.value.indexOf("=");
      const name = eq >= 0 ? k.value.slice(0, eq) : k.value;
      if (ENV_KEY_NAME.test(name)) push(name, eq >= 0 ? k.value.slice(eq + 1) : undefined, k.span);
      continue;
    }
    // compose map form: [doc.]services.<svc>.environment.<NAME>
    const compose = /^(?:\d+\.)?services\.[^.]+\.environment\.([^.]+)$/.exec(k.key);
    if (compose) {
      push(compose[1] as string, k.value, k.span);
      continue;
    }
    // k8s: [doc.](...).containers.<i>.env.<j>.name = NAME (value on the sibling ".value" key;
    // absent when the entry uses valueFrom (secretRef/configMapRef) instead of a literal — mint
    // the key with no value rather than dropping it, the name is still real).
    const k8s = /^(.*\.containers\.\d+\.env\.\d+)\.name$/.exec(k.key);
    if (k8s && typeof k.value === "string") {
      const sibling = flat.find((x) => x.key === `${k8s[1]}.value`);
      push(k.value, sibling?.value, k.span);
    }
  }
  return out;
}

/**
 * Every bindable deployment-env key an artifact contributes, by format. Gated on `roles` exactly
 * like `extractConfigKeys` — a dependency-manifest never gains deploy keys either, regardless of
 * format. `flatYamlKeys` is the SAME array `extractConfigKeys` already produced for this artifact
 * (unused for "dockerfile"; required for "yaml" — see yamlEnvKeys above).
 */
export function deploymentEnvKeys(
  format: string,
  roles: string[],
  text: string,
  flatYamlKeys: TSConfigKey[] = [],
): TSConfigKey[] {
  if (roles.includes("dependency-manifest")) return [];
  if (format === "dockerfile") return parseDockerfileEnv(text);
  if (format === "yaml") return yamlEnvKeys(flatYamlKeys);
  return [];
}
