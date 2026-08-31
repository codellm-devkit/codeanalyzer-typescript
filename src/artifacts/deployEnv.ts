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

/**
 * Line-based, never throws — a line that doesn't match is just skipped, never a reason to mark
 * the whole Dockerfile "partial". `ENV K=V` and the legacy `ENV K V` both occur; ARG may be bare
 * (`ARG X`, no default). A key redefined on a later line (a real Dockerfile pattern — e.g. `ARG
 * VERSION` then `ENV VERSION=$VERSION`: same bare name, but ARG/ENV land in different namespaces
 * so that particular pair never collides) keeps the LAST occurrence's value, matching Docker's
 * own build-time override semantics — keyed by `namespace:name` in a Map so at most one
 * TSConfigKey per (namespace, key) ever comes out of one Dockerfile.
 */
export function parseDockerfileEnv(text: string): TSConfigKey[] {
  const byKey = new Map<string, TSConfigKey>();
  text.split("\n").forEach((line, i) => {
    const m = DOCKER_LINE.exec(line);
    if (!m) return;
    const directive = (m[1] as string).toUpperCase();
    const rest = (m[2] as string).trim();
    const span: TSSpan = { start: [i + 1, 1], end: [i + 1, line.length + 1], bytes: [0, 0] };
    const eq = rest.indexOf("=");
    const [name, raw] = eq > 0 ? [rest.slice(0, eq), rest.slice(eq + 1)] : (() => {
      const sp = rest.indexOf(" ");
      return sp > 0 ? [rest.slice(0, sp), rest.slice(sp + 1)] : [rest, ""];
    })();
    const key = (name as string).trim();
    if (!key) return; // a bare "ENV " line with nothing after it — no name to mint
    let value = (raw as string).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const namespace = directive === "ENV" ? "env" : "dockerfile";
    byKey.set(`${namespace}:${key}`, keyNode(key, namespace, value, span)); // later line wins
  });
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
      const eq = k.value.indexOf("=");
      if (eq > 0) push(k.value.slice(0, eq), k.value.slice(eq + 1), k.span);
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
