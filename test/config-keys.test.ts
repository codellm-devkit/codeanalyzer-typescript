import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { parseJsonc } from "../src/artifacts/configKeys";
import { parseYamlKeys } from "../src/artifacts/yamlKeys";
import { parseDockerfileEnv, yamlEnvKeys } from "../src/artifacts/deployEnv";
import type { AnalysisOptions } from "../src/options";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/artifacts-app");
const opts = {
  input: FIXTURE, output: null, emit: "json", appName: "artifacts-app", neo4jUri: null,
  neo4jUser: "neo4j", neo4jPassword: "", neo4jDatabase: null, analysisLevel: 1, graphs: [],
  graphFieldDepth: 3, jobs: 1, targetFiles: null, skipTests: true, eager: true, noBuild: true,
  phantoms: true, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "cants-keys-")), verbosity: 0,
} as AnalysisOptions;

const arts = (await analyze(opts)).application.application.artifacts;
const keysOf = (p: string): Record<string, { value?: string | number | boolean; namespace: string; id: string; references: string[] }> =>
  Object.fromEntries((arts[p]?.config_keys ?? []).map((k) => [k.key, k]));

describe("config keys — flat and JSON (#101 unit B)", () => {
  test(".env keys land in the env namespace with refs and stripped quotes", () => {
    const k = keysOf(".env");
    expect(k["PAYMENT_HOST"]?.value).toBe("https://pay.example.com");
    expect(k["PAYMENT_HOST"]?.namespace).toBe("env");
    expect(k["DB_URL"]?.references).toEqual(["env:PAYMENT_HOST"]);
    expect(k["NODE_OPTIONS"]?.value).toBe("--max-old-space-size=4096");
  });

  test("JSONC tsconfig parses despite comments and trailing commas", () => {
    const k = keysOf("tsconfig.json");
    expect(k["compilerOptions.strict"]?.value).toBe(true);
    expect(k["compilerOptions.target"]?.value).toBe("ES2022");
    expect(k["include.0"]?.value).toBe("src"); // arrays get numeric segments
    expect(arts["tsconfig.json"]?.extraction).toBe("full");
  });

  test("key ids chain off the artifact id", () => {
    expect(keysOf(".env")["PAYMENT_HOST"]?.id).toBe("can://artifact/artifacts-app/.env@key/PAYMENT_HOST");
  });

  test("a dependency manifest is never also a config file — manifests/lockfiles yield zero keys", () => {
    expect(arts["package.json"]?.config_keys.length).toBe(0);
    expect(arts["package-lock.json"]?.config_keys.length).toBe(0);
    expect(arts["packages/web/bun.lock"]?.config_keys.length).toBe(0);
    // fix round 2: the gate is checked on `roles` before the format switch, so it must hold for
    // YAML too — pnpm-lock.yaml is format "yaml" with role dependency-manifest; previously only
    // exercised by probe, not a committed test.
    expect(arts["pnpm-lock.yaml"]?.config_keys.length).toBe(0);
    // the gate is role-scoped, not blanket — plain config files in the same formats still extract
    expect(arts["tsconfig.json"]?.config_keys.length).toBeGreaterThan(0);
    expect(arts[".env"]?.config_keys.length).toBeGreaterThan(0);
  });

  test("a genuinely malformed config file falls back to partial — node survives intact", () => {
    const art = arts["tsconfig.broken.json"];
    expect(art?.extraction).toBe("partial");
    expect(art?.config_keys).toEqual([]); // nothing salvaged, but no throw escaped
    expect(art?.sha256.length).toBe(64); // inventory fields untouched by the failed extraction
    expect(art?.size_bytes).toBeGreaterThan(0);
  });
});

// Direct unit tests of the parser (fix round 2): faster and clearer than round-tripping
// every case through a full analyze() run, since these are pure-function properties of
// parseJsonc itself, not of the artifact pipeline around it.
describe("parseJsonc — comments then trailing commas, each pass string-aware", () => {
  test("a string containing ', }' survives byte-for-byte (not mistaken for a trailing comma)", () => {
    expect(parseJsonc(`{"note": "hi, }"}`)).toEqual({ note: "hi, }" });
  });

  test("a string containing ',]' survives byte-for-byte", () => {
    expect(parseJsonc(`{"pattern": "a,]b"}`)).toEqual({ pattern: "a,]b" });
  });

  test("a string containing a trailing-comma-shaped glob token survives byte-for-byte", () => {
    expect(parseJsonc(`{"files": "dist/{cjs,}"}`)).toEqual({ files: "dist/{cjs,}" });
  });

  test("a string containing '//' survives (not mistaken for a line comment)", () => {
    expect(parseJsonc(`{"homepage": "https://example.com"}`)).toEqual({ homepage: "https://example.com" });
  });

  test("a string containing '/*' survives (not mistaken for a block comment)", () => {
    expect(parseJsonc(`{"glob": "a/*b"}`)).toEqual({ glob: "a/*b" });
  });

  test("an escaped quote inside a string doesn't end it early, even with a real comment right after", () => {
    // Built with a single-quoted JS string (not a template literal) so `\\"` in the SOURCE
    // collapses to a literal `\"` (backslash + quote) at RUNTIME — i.e. an actual escaped
    // quote inside the JSON text, the way it would read straight off disk.
    const doc = '{"note": "he said \\"hi\\"", "x": 1} // trailing comment';
    expect(parseJsonc(doc)).toEqual({ note: 'he said "hi"', x: 1 });
  });

  test("a genuine trailing comma is still stripped before both } and ]", () => {
    expect(parseJsonc(`{ "a": 1, "b": [1, 2, 3,], }`)).toEqual({ a: 1, b: [1, 2, 3] });
  });

  // Fix round 3: a trailing comma separated from its closing bracket by a comment (not just
  // whitespace) is an everyday tsconfig shape — comments removed in pass 1 make it reachable by
  // pass 2. A non-empty result here is exactly what flips the caller's `extraction` to "full"
  // (src/artifacts/index.ts: `if (keys.length) { ... extraction = "full" }`) — already pinned
  // end-to-end by the "JSONC tsconfig parses..." test above.
  test("a trailing comma followed by a line comment before the closing brace still parses", () => {
    expect(parseJsonc(`{"a": 1, // note\n}`)).toEqual({ a: 1 });
  });

  test("a trailing comma followed by a block comment before the closing brace still parses", () => {
    expect(parseJsonc(`{"a": 1, /* note */ }`)).toEqual({ a: 1 });
  });

  test("a genuinely malformed document still throws (caller marks the artifact partial)", () => {
    expect(() => parseJsonc(`{"a": "unterminated}`)).toThrow();
  });
});

describe("config keys — YAML (#101 unit B)", () => {
  test("nested maps and sequences flatten with numeric segments and real spans", () => {
    const k = keysOf("docker-compose.yml");
    expect(k["services.web.image"]?.value).toBe("node:22");
    expect(k["services.web.ports.0"]?.value).toBe("3000:3000");
    expect(k["services.web.image"]?.namespace).toBe("yaml");
    expect(k["services.web.image"]?.span?.start[0]).toBeGreaterThan(0);
  });

  // Fix round 1: a parse error is a different fact from "nothing to extract" — parseYamlKeys now
  // throws when the document has errors, so the caller's existing catch (src/artifacts/index.ts)
  // records "partial" the same way it already does for malformed JSONC. Mirrors the
  // "tsconfig.broken.json" test above, one namespace over.
  test("a genuinely malformed YAML file falls back to partial — node survives intact", () => {
    const art = arts["docker-compose.broken.yml"];
    expect(art?.extraction).toBe("partial");
    expect(art?.config_keys).toEqual([]); // nothing salvaged, but no throw escaped past the caller
    expect(art?.sha256.length).toBe(64); // inventory fields untouched by the failed extraction
    expect(art?.source).toBe("services:\n  web:\n    ports: [1, 2\n"); // full on-disk text, verbatim
  });

  // Fix round 1: `---`-separated multi-document streams (the standard shape of a Kubernetes
  // manifest) now parse via parseAllDocuments instead of being silently truncated to the first
  // document. Each document's keys get a zero-based index prefix; a single document (the fixture
  // above) stays unprefixed — already re-confirmed by the untouched test above still passing
  // unmodified (services.web.image, not 0.services.web.image).
  test("a multi-document stream (Kubernetes-style) prefixes keys by document index, with real spans in the SECOND document", () => {
    const k = keysOf("k8s/multi.yaml");
    expect(k["0.services.web.image"]?.value).toBe("node:22");
    expect(k["1.spec.containers.0.env.0.name"]?.value).toBe("PAYMENT_HOST");
    expect(k["1.spec.containers.0.env.0.value"]?.value).toBe("https://pay.example.com");
    // Line 11 of the COMBINED file is where the second document's env name actually sits. One
    // LineCounter spans the whole parse; a counter reset per document would report a smaller,
    // wrong line here instead.
    expect(k["1.spec.containers.0.env.0.name"]?.span?.start).toEqual([11, 17]);
    expect(arts["k8s/multi.yaml"]?.extraction).toBe("full");
  });

  // Fix round 2: "any document has errors" must mean any — not just the first. This fixture's
  // FIRST document is well-formed; only the second has a syntax error, exercised through the
  // full index.ts pipeline (not a direct parseYamlKeys call) so the assertion is on what the
  // artifact node actually ends up looking like, the same shape as the single-document
  // "falls back to partial" test above.
  test("an error in a NON-first document still fails the whole file — partial, node intact", () => {
    const art = arts["k8s/multi-broken.yaml"];
    expect(art?.extraction).toBe("partial");
    expect(art?.config_keys).toEqual([]); // the well-formed first document is not partially salvaged
    expect(art?.sha256.length).toBe(64);
    expect(art?.source).toBe("services:\n  web:\n    image: node:22\n---\nspec:\n  containers: [1, 2\n");
  });
});

// Direct unit tests of the parser (fix round 2): anchors/aliases/merge-keys/cycles are properties
// of parseYamlKeys itself, not of the artifact pipeline around it — same rationale as the
// parseJsonc block above.
describe("parseYamlKeys — anchors, aliases, and merge keys (fix round 2)", () => {
  test("an aliased map recurses into its own keys; a merge key splices into the CURRENT prefix", () => {
    const text = "defaults: &defaults\n  timeout: 30\nweb:\n  <<: *defaults\nplain:\n  val: *defaults\n";
    const keys = Object.fromEntries(parseYamlKeys(text).map((k) => [k.key, k]));
    expect(keys["defaults.timeout"]?.value).toBe(30);
    expect(keys["web.timeout"]?.value).toBe(30); // merge key: no ".<<." segment — spliced into "web"
    expect(keys["plain.val.timeout"]?.value).toBe(30); // aliased map recurses exactly like an inline one
    // the span belongs to the ANCHOR's own scalar node — every alias of it points back at that
    // one source location, not at the `*name` reference site.
    expect(keys["web.timeout"]?.span?.start).toEqual(keys["defaults.timeout"]?.span?.start);
    expect(keys["plain.val.timeout"]?.span?.start).toEqual(keys["defaults.timeout"]?.span?.start);
  });

  test("a merge-key sequence (<<: [*a, *b]) splices every source into the current prefix", () => {
    const text = "a: &a\n  x: 1\nb: &b\n  y: 2\nc:\n  <<: [*a, *b]\n";
    const keys = Object.fromEntries(parseYamlKeys(text).map((k) => [k.key, k.value]));
    expect(keys["a.x"]).toBe(1);
    expect(keys["b.y"]).toBe(2);
    expect(keys["c.x"]).toBe(1); // merged from *a
    expect(keys["c.y"]).toBe(2); // merged from *b
  });

  test("a cyclic alias (a map aliasing itself) terminates via the existing depth cap instead of hanging, and still keys the reachable scalar", () => {
    const text = "node: &node\n  value: 1\n  self: *node\n";
    const start = Date.now();
    const keys = parseYamlKeys(text);
    expect(Date.now() - start).toBeLessThan(1000); // terminates — the bug this guards is an infinite loop
    const byKey = Object.fromEntries(keys.map((k) => [k.key, k.value]));
    expect(byKey["node.value"]).toBe(1); // the one genuine scalar is still reachable and correct
    expect(keys.length).toBeLessThan(30); // bounded by the depth cap (~24), not unbounded
  });

  test("a dangling alias (no matching anchor) resolves to undefined and is skipped, not thrown", () => {
    expect(parseYamlKeys("a: *nope\n")).toEqual([]);
  });

  // Fix round 3: explicit keys must beat merged ones of the same name regardless of document
  // order, and the winning entry's span must be the EXPLICIT site, not the anchor's — otherwise a
  // last-wins consumer reads the value YAML says is overridden, and the two entries collide on id
  // (configKeyIdOf derives the id from the key string alone, so a genuine duplicate would too).
  test("an explicit key beats a merged one of the same name — one entry, explicit value and span", () => {
    const text = "defaults: &defaults\n  timeout: 30\nweb:\n  timeout: 60\n  <<: *defaults\n";
    const keys = parseYamlKeys(text).filter((k) => k.key === "web.timeout");
    expect(keys.length).toBe(1);
    expect(keys[0]?.value).toBe(60);
    expect(keys[0]?.span?.start).toEqual([4, 12]); // line 4: the explicit "  timeout: 60" line
  });

  test("the same override with << written BEFORE the explicit key — identical result, proving order-independence", () => {
    const text = "defaults: &defaults\n  timeout: 30\nweb:\n  <<: *defaults\n  timeout: 60\n";
    const keys = parseYamlKeys(text).filter((k) => k.key === "web.timeout");
    expect(keys.length).toBe(1);
    expect(keys[0]?.value).toBe(60);
    expect(keys[0]?.span?.start).toEqual([5, 12]); // explicit key moved to line 5 — span follows it
  });

  test("in a merge sequence, an earlier source wins over a later one when both define the same key", () => {
    const text = "a: &a\n  x: 1\nb: &b\n  x: 2\nc:\n  <<: [*a, *b]\n";
    const keys = parseYamlKeys(text).filter((k) => k.key === "c.x");
    expect(keys.length).toBe(1);
    expect(keys[0]?.value).toBe(1); // *a, not *b
  });

  test("no duplicate dotted keys across the whole anchor/merge fixture", () => {
    const text = "defaults: &defaults\n  timeout: 30\nweb:\n  <<: *defaults\nplain:\n  val: *defaults\n";
    const keys = parseYamlKeys(text);
    expect(new Set(keys.map((k) => k.key)).size).toBe(keys.length);
  });
});

describe("deployment-env namespaces (#101 unit D)", () => {
  test("Dockerfile ENV mints bindable env keys; ARG stays non-bindable dockerfile", () => {
    const k = keysOf("Dockerfile");
    expect(k["PAYMENT_HOST"]?.namespace).toBe("env");
    expect(k["PAYMENT_HOST"]?.value).toBe("https://pay.example.com");
    expect(k["FEATURE_FLAG"]?.namespace).toBe("env");
    expect(k["FEATURE_FLAG"]?.value).toBe("on"); // legacy `ENV K "V"` form, quotes stripped
    expect(k["BUILD_ID"]?.namespace).toBe("dockerfile"); // build-time only, never joins a read
    expect(k["BUILD_ID"]?.value).toBe("local");
    expect(arts["Dockerfile"]?.extraction).toBe("full");
  });

  test("compose environment blocks mint env keys ALONGSIDE the structural yaml keys", () => {
    const k = keysOf("docker-compose.yml");
    expect(k["services.web.environment.PAYMENT_HOST"]?.namespace).toBe("yaml"); // structural
    const envKeys = (arts["docker-compose.yml"]?.config_keys ?? []).filter((x) => x.namespace === "env");
    expect(envKeys.map((x) => x.key).sort()).toEqual(["FEATURE_FLAG", "PAYMENT_HOST"]);
    const byName = Object.fromEntries(envKeys.map((x) => [x.key, x]));
    expect(byName["PAYMENT_HOST"]?.value).toBe("https://pay.example.com");
  });

  // Controller ruling: yamlKeys.ts prefixes every key in a multi-document stream with its
  // zero-based document index ("1.spec.containers.0.env.0.name"). A compose/k8s matcher anchored
  // at "^services" that ignores this prefix would silently match nothing on a real
  // Kubernetes-shaped multi-document file. k8s/multi.yaml is exactly that shape: doc 0 is a
  // compose-shaped services: map, doc 1 is a Deployment with spec.containers[0].env[0].
  test("multi-document files (k8s/multi.yaml) still mint env keys despite the doc-index prefix", () => {
    const envKeys = (arts["k8s/multi.yaml"]?.config_keys ?? []).filter((x) => x.namespace === "env");
    expect(envKeys.map((x) => x.key)).toEqual(["PAYMENT_HOST"]);
    expect(envKeys[0]?.value).toBe("https://pay.example.com");
    expect(arts["k8s/multi.yaml"]?.extraction).toBe("full");
  });

  // extractConfigKeys already refuses a dependency-manifest; deploymentEnvKeys must not
  // independently re-open that door. pnpm-lock.yaml (format "yaml", role dependency-manifest) is
  // the one existing fixture that exercises this for the yaml path (a Dockerfile can never carry
  // that role, so there is nothing to check on the dockerfile side of the same gate).
  test("a dependency-manifest yaml file (pnpm-lock.yaml) gains zero env keys — same gate as structural keys", () => {
    expect(arts["pnpm-lock.yaml"]?.config_keys.filter((x) => x.namespace === "env")).toEqual([]);
  });

  // Fix round 1 (coordinator ruling): configKeyIdOf(artifactId, key) ignores namespace, so a bare
  // name minted into TWO namespaces on the SAME artifact collided on `.id` before this round —
  // confirmed to actually happen via `ARG VERSION` + `ENV VERSION=$VERSION`, a routine Dockerfile
  // idiom (promote a build arg into a runtime env var under the same name). The `key` FIELD stays
  // the bare name in both cases (env-namespace resolution still joins on a plain `key ===` match);
  // only the id gets an internal prefix — python v1.3.0 parity, applied in assignIds.ts.
  test("ARG VERSION + ENV VERSION=$VERSION mint the same bare key in two namespaces with DISTINCT ids", () => {
    const keys = arts["Dockerfile"]?.config_keys ?? [];
    const argVersion = keys.find((k) => k.namespace === "dockerfile" && k.key === "VERSION");
    const envVersion = keys.find((k) => k.namespace === "env" && k.key === "VERSION");
    expect(argVersion?.key).toBe("VERSION"); // key field stays bare — only the id is disambiguated
    expect(envVersion?.key).toBe("VERSION");
    expect(argVersion?.id).toBe("can://artifact/artifacts-app/Dockerfile@key/arg.VERSION");
    expect(envVersion?.id).toBe("can://artifact/artifacts-app/Dockerfile@key/VERSION"); // ENV: unprefixed
    expect(argVersion?.id).not.toBe(envVersion?.id);
  });

  // Same collision class, one namespace over: a yaml artifact's TOP-LEVEL leaf and its "env"
  // dual-mint (compose/k8s) can share a bare name too — docker-compose.yml now carries both a
  // root PAYMENT_HOST: leaf and services.web.environment.PAYMENT_HOST (which dual-mints an "env"
  // key named bare "PAYMENT_HOST"). Only the dual-mint's id gets the `env.` prefix.
  test("a yaml artifact's top-level leaf and its env dual-mint share a bare name but get DISTINCT ids", () => {
    const keys = arts["docker-compose.yml"]?.config_keys ?? [];
    const structural = keys.find((k) => k.namespace === "yaml" && k.key === "PAYMENT_HOST");
    const deployEnv = keys.find((k) => k.namespace === "env" && k.key === "PAYMENT_HOST");
    expect(structural?.value).toBe("https://root-level.example.com");
    expect(deployEnv?.value).toBe("https://pay.example.com");
    expect(structural?.id).toBe("can://artifact/artifacts-app/docker-compose.yml@key/PAYMENT_HOST");
    expect(deployEnv?.id).toBe("can://artifact/artifacts-app/docker-compose.yml@key/env.PAYMENT_HOST");
    expect(structural?.id).not.toBe(deployEnv?.id);
  });

  // The regression guard that would have caught the original bug: every config-key id across the
  // WHOLE fixture app, unique — not just within the two cases spelled out above.
  test("no two config keys anywhere in the fixture app share an id", () => {
    const ids = Object.values(arts).flatMap((a) => a.config_keys.map((k) => k.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  // docker-compose.broken.yml / k8s/multi-broken.yaml falling back to "partial" with empty
  // config_keys is already pinned above (config keys — YAML block); nothing to re-assert here
  // beyond confirming this task didn't reach for deploy keys on a file that never parsed.
});

// Direct unit tests (fixtures don't cover every shape without risking the line/span assertions
// pinned on them elsewhere): compose list form, k8s valueFrom, and the doc-index prefix, each in
// isolation — same rationale as the parseJsonc/parseYamlKeys direct-unit-test blocks above.
describe("yamlEnvKeys — compose list form and k8s valueFrom (#101 unit D)", () => {
  test("compose list-form environment entries (`- KEY=value`) mint bindable env keys too", () => {
    const text =
      "services:\n  web:\n    environment:\n      - FEATURE_FLAG=on\n      - PAYMENT_HOST=https://pay.example.com\n";
    const keys = Object.fromEntries(yamlEnvKeys(parseYamlKeys(text)).map((k) => [k.key, k]));
    expect(keys["FEATURE_FLAG"]?.namespace).toBe("env");
    expect(keys["FEATURE_FLAG"]?.value).toBe("on");
    expect(keys["PAYMENT_HOST"]?.value).toBe("https://pay.example.com");
    // the numeric list index must never itself be minted as a variable name
    expect(keys["0"]).toBeUndefined();
    expect(keys["1"]).toBeUndefined();
  });

  // Fix round 2 (coordinator ruling, python v1.3.0 parity): a bare list entry ("- KEY", no "=")
  // is compose's own syntax for "inherit this variable from the host environment" — a real
  // bindable declaration, not dropped convenience — and must mint a valueless key, same shape as
  // the k8s valueFrom case below. Distinguished from "- KEY=" (an "=" present, empty right side),
  // which mints an EMPTY-STRING value. A name that isn't a valid env var name stays dropped either way.
  test("a bare compose list entry (`- KEY`, no `=`) mints a valueless env key; `- KEY=` mints an empty string; junk is dropped", () => {
    const text =
      "services:\n  web:\n    environment:\n      - PASSTHROUGH_KEY\n      - EMPTY_KEY=\n      - 9INVALID\n";
    const keys = Object.fromEntries(yamlEnvKeys(parseYamlKeys(text)).map((k) => [k.key, k]));
    expect(keys["PASSTHROUGH_KEY"]?.namespace).toBe("env");
    expect(keys["PASSTHROUGH_KEY"]?.value).toBeUndefined(); // no "=" at all — absent, not ""
    expect("value" in (keys["PASSTHROUGH_KEY"] ?? {})).toBe(false); // truly absent, not present-as-undefined
    expect(keys["EMPTY_KEY"]?.value).toBe(""); // "=" present, empty right side — distinct from bare
    expect(keys["9INVALID"]).toBeUndefined(); // not a valid env var name (leading digit) — dropped
  });

  test("a k8s env entry using valueFrom (no literal value) still mints the key, with no value", () => {
    const text = [
      "spec:",
      "  containers:",
      "    - name: app",
      "      env:",
      "        - name: DB_PASSWORD",
      "          valueFrom:",
      "            secretKeyRef:",
      "              name: db-secret",
      "              key: password",
      "",
    ].join("\n");
    const keys = Object.fromEntries(yamlEnvKeys(parseYamlKeys(text)).map((k) => [k.key, k]));
    expect(keys["DB_PASSWORD"]?.namespace).toBe("env");
    expect(keys["DB_PASSWORD"]?.value).toBeUndefined(); // no literal — not dropped, just valueless
  });

  test("the doc-index prefix from a multi-document stream is tolerated by both compose and k8s matchers", () => {
    const text =
      'services:\n  web:\n    environment:\n      DEBUG: "true"\n---\nspec:\n  containers:\n    - name: app\n      env:\n        - name: DEBUG\n          value: "false"\n';
    const flat = parseYamlKeys(text);
    expect(flat.some((k) => k.key.startsWith("0."))).toBe(true); // sanity: this IS a multi-doc stream
    const keys = yamlEnvKeys(flat);
    // same bare name "DEBUG" from two different documents/containers — first occurrence in
    // flattened (document) order wins: exactly one TSConfigKey, not two colliding on id.
    const debug = keys.filter((k) => k.key === "DEBUG");
    expect(debug.length).toBe(1);
    expect(debug[0]?.value).toBe("true");
  });
});

describe("parseDockerfileEnv — redefinition and dedup (#101 unit D)", () => {
  test("a key redefined on a later ENV line keeps the LAST value — one key, not two colliding ids", () => {
    const keys = parseDockerfileEnv("FROM node:22\nENV FOO=1\nENV FOO=2\n");
    const foo = keys.filter((k) => k.key === "FOO");
    expect(foo.length).toBe(1);
    expect(foo[0]?.value).toBe("2");
  });

  test("ARG and ENV of the same name land in different namespaces and both survive", () => {
    const keys = parseDockerfileEnv("ARG VERSION=1.0\nENV VERSION=$VERSION\n");
    const byNs = Object.fromEntries(keys.map((k) => [k.namespace, k]));
    expect(byNs["dockerfile"]?.key).toBe("VERSION");
    expect(byNs["env"]?.key).toBe("VERSION");
    expect(keys.length).toBe(2);
  });

  test("never throws, even on garbage input", () => {
    expect(() => parseDockerfileEnv("ENV \nARG\n\0\0binary garbage\nENV =nope\n")).not.toThrow();
  });
});
