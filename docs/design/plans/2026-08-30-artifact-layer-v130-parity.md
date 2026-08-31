# Repository-artifact layer (python v1.3.0 parity) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring codeanalyzer-typescript's repository-artifact layer to codeanalyzer-python v1.3.0 parity — never-drop inventory with a text-capture policy, lockfile transitives, the ConfigKey family, deployment-env namespaces, and the level-graded `config_use` edge.

**Architecture:** Four spec units land as staged commits on `feat/issue-101-artifacts`, each placed with the pipeline stage whose output it consumes: file-derived data in `src/artifacts/`, the literal `config_use` tier in `src/semantic_analysis/` (needs resolved callees), the dataflow tiers in `src/dataflow/` (needs def-use). Env reads mint a new L1 `config_access` body node so `config_uses.src` is a uniform ordinal id at every level.

**Tech Stack:** TypeScript, Bun (test runner + bundler), ts-morph, `yaml` (new dependency), Neo4j projection.

**Spec:** `docs/design/specs/2026-08-30-artifact-layer-v130-parity.md`

## Global Constraints

- **`SCHEMA_VERSION` in `src/build/neo4j/schema.ts` must NOT move.** PR #103's bump to `"2.2.0"` reverts to `"2.1.0"`. All analyzers re-baseline at 2.0.0 later, cross-language.
- **Schema changes are additive only** — no existing field renamed, removed, or repurposed.
- **Determinism:** every emitted list is sorted by a stable key; no `Date.now()`, no hash-order iteration. Two consecutive default runs must produce byte-identical output.
- **Extraction parses the full on-disk text**, never the (possibly truncated) `source` stored on the node.
- **`sha256` and `size_bytes` are always the full file**, regardless of capture settings.
- **Never drop a file:** unmatched-but-decodable → `roles: ["unknown"]`; undecodable → `format: "binary"`, `source: ""`.
- **Overlay posture:** a parse failure never suppresses an artifact node; it sets `extraction: "partial"`.
- **`config_uses` is superset-monotonic** across levels (L2 ⊆ L3 ⊆ L4); **`config_reads` deliberately shrinks** as levels rise — assert both.
- Language-neutral graph nouns (`Artifact`, `Package`, `ConfigKey`) stay unprefixed; this analyzer's own claims (`TS_PROVIDES`, `TS_UNRESOLVED_IMPORT`, `TS_USES_CONFIG`) keep the `TS_` prefix.
- Run `bun test` and `bun run typecheck` before every commit; both must be green.

**Implementation order note:** the spec labels the units A–D, but D (deployment-env) *produces* config keys that C (config_use) *consumes*. Tasks below therefore run **A → B → D → C**, so every C test has real bindable keys to match against. No spec content changes.

---

## File Structure

**Create:**
- `src/artifacts/configKeys.ts` — config-key extraction (env / JSONC / TOML / INI / properties), unit B
- `src/artifacts/yamlKeys.ts` — YAML flattening with real spans, unit B
- `src/artifacts/deployEnv.ts` — Dockerfile `ENV`/`ARG`, compose, k8s → bindable env keys, unit D
- `src/semantic_analysis/configUseRules.ts` — shipped detector table, unit C
- `src/semantic_analysis/configUse.ts` — literal tier + `config_reads`, unit C
- `src/dataflow/configUse.ts` — intra + interprocedural dataflow tiers, unit C
- `docs/skills/analyzing-cants-graphs/SKILL.md` + `references/vocabulary.md` + `references/analyses.md`
- `test/config-keys.test.ts`, `test/config-use.test.ts`

**Modify:**
- `src/schema/schema.ts` — `TSConfigKey`, `TSConfigUse`, `TSConfigRead`, `TSConfigAccess`; artifact gains `text_truncated` + `config_keys`; callable gains internal `config_accesses`; application gains `config_uses` + `config_reads`
- `src/schema/ids.ts` — `configKeyIdOf`
- `src/schema/assignIds.ts` — stamp config-key ids
- `src/schema/l1Body.ts` — emit `config_access` body nodes
- `src/schema/emit.ts` — new root sections
- `src/artifacts/index.ts` — never-drop walk, text policy, key attachment
- `src/artifacts/deps.ts` — `direct: false` transitives
- `src/syntactic_analysis/builders.ts` — record env-read accesses
- `src/options/options.ts`, `src/cli.ts` — `--artifact-text`, `--artifact-text-max-bytes`
- `src/core.ts` — pipeline placement of the tiers
- `src/build/neo4j/schema.ts`, `src/build/neo4j/project.ts` — ConfigKey vocabulary; revert the version bump
- `test/artifacts.test.ts`, `test/schema-v2.test.ts`, `test/neo4j-schema.test.ts` — gates
- `test/fixtures/artifacts-app/**` — fixture growth
- `CLAUDE.md`, `README.md`, `.claude/SCHEMA_DECISIONS.md`

---

### Task 1: Text-capture policy (unit A)

**Files:**
- Modify: `src/options/options.ts`, `src/cli.ts`, `src/artifacts/index.ts`, `src/schema/schema.ts`
- Test: `test/artifacts.test.ts`

**Interfaces:**
- Consumes: `AnalysisOptions`, `TSArtifact` (both exist)
- Produces: `AnalysisOptions.artifactText?: boolean`, `AnalysisOptions.artifactTextMaxBytes?: number`, `DEFAULT_ARTIFACT_TEXT_MAX_BYTES = 262144`, `TSArtifact.text_truncated: boolean`

- [ ] **Step 1: Write the failing test**

In `test/artifacts.test.ts`, inside the `level-invariance + determinism` describe block:

```ts
  test("text capture: on by default, truncates under the cap, hash stays full-file", async () => {
    const full = (await analyze(options())).application.application.artifacts["README.md"];
    expect(full?.source.length).toBeGreaterThan(0);
    expect(full?.text_truncated).toBe(false);

    const capped = (await analyze(options({ artifactTextMaxBytes: 8 }))).application.application.artifacts["README.md"];
    expect(capped?.text_truncated).toBe(true);
    expect(capped!.source.length).toBeLessThanOrEqual(8);
    expect(capped?.sha256).toBe(full?.sha256); // hash is of the FULL file
    expect(capped?.size_bytes).toBe(full?.size_bytes);
  });

  test("--no-artifact-text drops source but keeps inventory AND extraction", async () => {
    const a = (await analyze(options({ artifactText: false }))).application.application;
    expect(a.artifacts["package.json"]?.source).toBe("");
    expect(a.dependencies.find((d) => d.name === "express")?.locked_version).toBe("4.19.2");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/artifacts.test.ts -t "text capture"`
Expected: FAIL — `text_truncated` is not a property; `artifactTextMaxBytes` is not on `AnalysisOptions`.

- [ ] **Step 3: Add the options**

In `src/options/options.ts`, above `export interface AnalysisOptions`:

```ts
/** Default per-file byte cap for captured artifact text (256 KiB, python v1.3.0 parity). */
export const DEFAULT_ARTIFACT_TEXT_MAX_BYTES = 256 * 1024;
```

and inside the interface, next to `resolveInstalled`:

```ts
  /** Capture verbatim artifact text into `source` (default true). */
  artifactText?: boolean;
  /** Per-file byte cap for captured text; larger files store a flagged prefix. */
  artifactTextMaxBytes?: number;
```

- [ ] **Step 4: Wire the CLI flags**

In `src/cli.ts`, add the import `import { DEFAULT_ARTIFACT_TEXT_MAX_BYTES } from "./options";`, then in `buildProgram()` before `-c, --cache-dir`:

```ts
    .option("--no-artifact-text", "keep the artifact inventory but drop captured raw text")
    .option(
      "--artifact-text-max-bytes <n>",
      "per-file byte cap for captured artifact text; larger files are truncated and flagged",
      String(DEFAULT_ARTIFACT_TEXT_MAX_BYTES),
    )
```

and in the returned options object, next to `resolveInstalled`:

```ts
    artifactText: o.artifactText !== false,
    artifactTextMaxBytes: Number(o.artifactTextMaxBytes ?? DEFAULT_ARTIFACT_TEXT_MAX_BYTES),
```

- [ ] **Step 5: Add the schema field**

In `src/schema/schema.ts`, in `TSArtifact`, after `source`:

```ts
  text_truncated: boolean; // true when `source` is a prefix, not the full file
```

- [ ] **Step 6: Apply the policy in the walk**

In `src/artifacts/index.ts`: import the default (`import { DEFAULT_ARTIFACT_TEXT_MAX_BYTES } from "../options";`), then replace the node construction's `source` line and add the flag. The decoded `text` stays the FULL text (extraction uses it); only the stored copy is capped:

```ts
    const capture = opts.artifactText ?? true;
    const cap = opts.artifactTextMaxBytes ?? DEFAULT_ARTIFACT_TEXT_MAX_BYTES;
    const stored = !capture || text === undefined ? "" : text.length > cap ? text.slice(0, cap) : text;
    const node: TSArtifact = {
      id: "",
      kind: "artifact",
      path: rel,
      format: format as string,
      roles: roles as string[],
      size_bytes: raw.length,
      sha256: sha256(raw),
      source: stored,
      text_truncated: capture && text !== undefined && text.length > cap,
      extraction: "none",
      config_keys: [],
    };
```

(`config_keys: []` is added now so Task 4 only fills it; declare the field in Task 4's schema step — if `tsc` complains here, add `config_keys: TSConfigKey[]` to `TSArtifact` in this task and leave the type empty until Task 4.)

- [ ] **Step 7: Run tests**

Run: `bun test test/artifacts.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/options/options.ts src/cli.ts src/artifacts/index.ts src/schema/schema.ts test/artifacts.test.ts
git commit -m "feat(artifacts): text-capture policy — flags, cap, text_truncated (#101)"
```

---

### Task 2: Never-drop inventory (unit A)

**Files:**
- Modify: `src/artifacts/index.ts`
- Test: `test/artifacts.test.ts`, `test/fixtures/artifacts-app/`

**Interfaces:**
- Consumes: `matchRules(relPath)` from `src/artifacts/rules.ts` (exists)
- Produces: artifacts for every non-source file; `roles: ["unknown"]` and `format: "binary"` conventions

- [ ] **Step 1: Grow the fixture**

```bash
cd test/fixtures/artifacts-app
printf 'plain data, no rule matches this\n' > notes.dat
printf '\x00\x01\x02\xff\xfe binary\n' > logo.bin
```

- [ ] **Step 2: Write the failing test**

In `test/artifacts.test.ts`, inside the first describe block:

```ts
  test("never drops: unmatched files are unknown-role, binaries are hash-only", () => {
    const unknown = arts["notes.dat"];
    expect(unknown?.roles).toEqual(["unknown"]);
    expect(unknown?.format).toBe("text");
    expect(unknown?.source.length).toBeGreaterThan(0);

    const bin = arts["logo.bin"];
    expect(bin?.format).toBe("binary");
    expect(bin?.roles).toEqual(["unknown"]);
    expect(bin?.source).toBe("");
    expect(bin?.sha256.length).toBe(64);
    expect(bin?.size_bytes).toBeGreaterThan(0);
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/artifacts.test.ts -t "never drops"`
Expected: FAIL — `arts["notes.dat"]` is undefined (the walk skips unmatched files).

- [ ] **Step 4: Replace the skip with a fallback**

In `src/artifacts/index.ts`, replace the `if (!matched) { … continue; }` block with:

```ts
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
```

- [ ] **Step 5: Run tests**

Run: `bun test && bun run typecheck`
Expected: PASS. If a count assertion in `test/schema-v2.test.ts` fails, it is counting artifact rows — update the expected number, do not weaken the assertion.

- [ ] **Step 6: Commit**

```bash
git add src/artifacts/index.ts test/artifacts.test.ts test/fixtures/artifacts-app
git commit -m "feat(artifacts): never-drop inventory — unknown roles, binary hash-only (#101)"
```

---

### Task 3: Lockfile transitives (unit A)

**Files:**
- Modify: `src/artifacts/deps.ts`, `src/artifacts/index.ts`
- Test: `test/artifacts.test.ts`

**Interfaces:**
- Consumes: `readLock(fileName, text)` → `Record<string, string>`, `applyLockVersions(deps, lock)` (both exist)
- Produces: `transitiveRecords(pins, declaredNames, lockArtifactId)` → `TSDependency[]`

- [ ] **Step 1: Write the failing test**

In `test/artifacts.test.ts`, inside the dependencies describe block:

```ts
  test("lock-only packages become direct:false records attributed to the lock", () => {
    const t = deps.find((d) => d.name === "lockonly-transitive");
    expect(t).toBeDefined();
    expect(t?.direct).toBe(false);
    expect(t?.kind).toBe("runtime");
    expect(t?.prov).toEqual(["lockfile"]);
    expect(t?.locked_version).toBe("1.0.0");
    expect(t?.declared_in).toBe("can://artifact/artifacts-app/package-lock.json");
    // declared packages stay direct
    expect(byName.get("express")?.direct).toBe(true);
    // nested shadow entries are NOT records
    expect(deps.some((d) => d.name === "transitive-shadow")).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/artifacts.test.ts -t "lock-only"`
Expected: FAIL — no record for `lockonly-transitive`.

- [ ] **Step 3: Add the record builder**

Append to `src/artifacts/deps.ts`:

```ts
/**
 * Lock-only packages are TRANSITIVE: pinned with no manifest declaration. They earn records
 * (`direct: false`) because the dependency SURFACE and the dependency SUPPLY CHAIN are different
 * questions — a vulnerable package four levels down ships whether or not anyone named it.
 * `kind` is "runtime": a lock does not record why a package is present, and inferring it would
 * take a whole-graph walk this unit deliberately does not do.
 */
export function transitiveRecords(
  pins: Record<string, string>,
  declaredNames: Set<string>,
  lockArtifactId: string,
): TSDependency[] {
  const out: TSDependency[] = [];
  for (const name of Object.keys(pins).sort()) {
    if (declaredNames.has(name)) continue;
    out.push({
      name,
      spec: "",
      kind: "runtime",
      extras: [],
      declared_in: lockArtifactId,
      direct: false,
      locked_version: pins[name] as string,
      provides_imports: [name],
      prov: ["lockfile"],
    });
  }
  return out;
}
```

- [ ] **Step 4: Add `direct` to declared records**

In `src/artifacts/deps.ts`, in `parsePackageJson`'s pushed object, after `declared_in`:

```ts
        direct: true,
```

and in `src/schema/schema.ts`, in `TSDependency`, after `declared_in`:

```ts
  direct: boolean; // false = lockfile-only transitive (no manifest declares it)
```

- [ ] **Step 5: Emit them from the walk**

In `src/artifacts/index.ts`, import `transitiveRecords`, keep the lock artifact id alongside the pins, and after the manifest loop:

```ts
  const declaredNames = new Set(dependencies.map((d) => d.name));
  for (const [ownerRel, pins] of Object.entries(locks).sort(([a], [b]) => a.localeCompare(b))) {
    const lockRel = lockPathOf[ownerRel] as string;
    const lockArtifact = artifacts[lockRel];
    if (!lockArtifact) continue;
    dependencies.push(...transitiveRecords(pins, declaredNames, lockRel)); // rel path; assignIds re-stamps
  }
```

Record `lockPathOf[ownerRel] = rel` in the same branch that fills `locks[ownerRel]`.

- [ ] **Step 6: Extend assignIds for lock attribution**

`declared_in` currently re-stamps only manifest paths; the same call already converts any rel path to an artifact id, so no change is needed — verify with the test rather than assuming.

- [ ] **Step 7: Run tests**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/artifacts/deps.ts src/artifacts/index.ts src/schema/schema.ts test/artifacts.test.ts
git commit -m "feat(artifacts): lockfile transitives as direct:false records (#101)"
```

---

### Task 4: ConfigKey model + flat/JSONC extraction (unit B)

**Files:**
- Create: `src/artifacts/configKeys.ts`, `test/config-keys.test.ts`
- Modify: `src/schema/schema.ts`, `src/schema/ids.ts`, `src/schema/assignIds.ts`, `src/artifacts/index.ts`

**Interfaces:**
- Consumes: `TSArtifact`, `TSSpan`
- Produces: `TSConfigKey`, `configKeyIdOf(artifactId, dotted)`, `extractConfigKeys(format, roles, text): TSConfigKey[]`

- [ ] **Step 1: Grow the fixture**

```bash
cd test/fixtures/artifacts-app
cat > tsconfig.json <<'EOF'
{
  // JSONC: comments and trailing commas are legal in tsconfig
  "compilerOptions": { "strict": true, "target": "ES2022", },
  "include": ["src"],
}
EOF
```

- [ ] **Step 2: Write the failing test**

Create `test/config-keys.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
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
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/config-keys.test.ts`
Expected: FAIL — `config_keys` is always `[]`.

- [ ] **Step 4: Add the schema types and id helper**

In `src/schema/schema.ts`, before `TSArtifact`:

```ts
/** A configuration key flattened out of a config-bearing artifact (#101 unit B). */
export interface TSConfigKey {
  id: string; // `${artifactId}@key/${dotted}` — stamped per-run by assignIds
  key: string; // dotted path; numeric segments for arrays ("services.web.ports.0")
  namespace: string; // env|json|yaml|toml|ini|properties|dockerfile
  value?: string | number | boolean; // present by default; absent under --no-artifact-text
  span?: TSSpan; // best-effort: exact for json/yaml, line-based elsewhere
  references: string[]; // recognized ${VAR}/$VAR tokens, deduped, in order
}
```

and in `TSArtifact`, after `extraction`:

```ts
  config_keys: TSConfigKey[]; // contained children; containment mirrors DEFINES_CONFIG
```

In `src/schema/ids.ts`:

```ts
/** Config-key id: the owning artifact's id, `@key/`, then the dotted path. */
export function configKeyIdOf(artifactId: string, dotted: string): string {
  return `${artifactId}@key/${dotted}`;
}
```

In `src/schema/assignIds.ts`, inside the artifacts loop after `art.id = …`:

```ts
    for (const ck of art.config_keys) ck.id = configKeyIdOf(art.id, ck.key);
```

(import `configKeyIdOf` alongside `artifactIdOf`).

- [ ] **Step 5: Write the extractor**

Create `src/artifacts/configKeys.ts`:

```ts
/**
 * Config-key extraction (#101 unit B): a config-bearing artifact's text → flattened dotted keys.
 * Pure overlay — every parser returns [] on failure so the artifact node survives (the caller
 * marks `extraction: "partial"`). Parses the FULL on-disk text, never the stored `source`.
 */
import type { TSConfigKey, TSSpan } from "../schema";

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

/** Strip `//` and block comments and trailing commas — tsconfig/rc files are JSONC. */
export function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => (m.startsWith('"') ? m : ""))
    .replace(/,\s*([}\]])/g, "$1");
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

/** Dispatch by artifact format. YAML is handled by yamlKeys.ts (Task 5). */
export function extractConfigKeys(format: string, text: string): TSConfigKey[] {
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
    default:
      return [];
  }
}
```

- [ ] **Step 6: Attach keys in the walk**

In `src/artifacts/index.ts`, import `extractConfigKeys`, and in the extraction loop (after the `package.json` branch), replace the config branch with:

```ts
    // Config keys: attempted for every namespace-eligible format; a throw means the file is
    // config-shaped but unparseable → keep the node, mark partial (overlay posture).
    if (["env", "json", "jsonc", "ini", "properties", "yaml"].includes(node.format)) {
      try {
        const keys = extractConfigKeys(node.format, text);
        if (keys.length) {
          node.config_keys = keys;
          node.extraction = node.extraction === "none" ? "full" : node.extraction;
        }
      } catch {
        node.extraction = "partial";
      }
    }
```

Guard `value` on capture: after the loop, if `opts.artifactText === false`, delete every key's `value`.

- [ ] **Step 7: Run tests**

Run: `bun test test/config-keys.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/artifacts/configKeys.ts src/schema/schema.ts src/schema/ids.ts src/schema/assignIds.ts src/artifacts/index.ts test/config-keys.test.ts test/fixtures/artifacts-app
git commit -m "feat(artifacts): ConfigKey family — env/JSONC/ini extraction, key ids (#101)"
```

---

### Task 5: YAML config keys (unit B)

**Files:**
- Create: `src/artifacts/yamlKeys.ts`
- Modify: `package.json`, `src/artifacts/configKeys.ts`, `test/config-keys.test.ts`, `test/fixtures/artifacts-app/`

**Interfaces:**
- Consumes: `keyNode`, `TSConfigKey`
- Produces: `parseYamlKeys(text): TSConfigKey[]`

- [ ] **Step 1: Add the dependency and fixture**

```bash
bun add yaml
cd test/fixtures/artifacts-app
cat > docker-compose.yml <<'EOF'
services:
  web:
    image: node:22
    ports:
      - "3000:3000"
    environment:
      PAYMENT_HOST: https://pay.example.com
      FEATURE_FLAG: "on"
EOF
```

- [ ] **Step 2: Write the failing test**

Append to `test/config-keys.test.ts`:

```ts
describe("config keys — YAML (#101 unit B)", () => {
  test("nested maps and sequences flatten with numeric segments and real spans", () => {
    const k = keysOf("docker-compose.yml");
    expect(k["services.web.image"]?.value).toBe("node:22");
    expect(k["services.web.ports.0"]?.value).toBe("3000:3000");
    expect(k["services.web.image"]?.namespace).toBe("yaml");
    expect(k["services.web.image"]?.span?.start[0]).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/config-keys.test.ts -t "YAML"`
Expected: FAIL — no keys for the compose file.

- [ ] **Step 4: Write the YAML flattener**

Create `src/artifacts/yamlKeys.ts`:

```ts
/**
 * YAML config-key flattening (#101 unit B). Uses the `yaml` package's document AST so spans are
 * real offsets and anchors/flow style/multiline scalars parse correctly — a hand-rolled subset
 * would silently mis-parse them. Returns [] on a parse error (overlay posture).
 */
import { LineCounter, parseDocument, isMap, isSeq, isScalar, type Node as YamlNode } from "yaml";
import { keyNode } from "./configKeys";
import type { TSConfigKey, TSSpan } from "../schema";

export function parseYamlKeys(text: string): TSConfigKey[] {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, keepSourceTokens: false });
  if (doc.errors.length) return [];
  const out: TSConfigKey[] = [];
  const spanOf = (n: YamlNode): TSSpan | undefined => {
    const r = n.range;
    if (!r) return undefined;
    const s = lc.linePos(r[0]);
    const e = lc.linePos(r[1]);
    return { start: [s.line, s.col], end: [e.line, e.col], bytes: [r[0], r[1]] };
  };
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (depth > 24) return;
    if (isMap(node)) {
      for (const item of node.items) {
        const k = isScalar(item.key) ? String(item.key.value) : String(item.key);
        walk(item.value, prefix ? `${prefix}.${k}` : k, depth + 1);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => walk(item, `${prefix}.${i}`, depth + 1));
    } else if (isScalar(node)) {
      const v = node.value;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out.push(keyNode(prefix, "yaml", v, spanOf(node as YamlNode)));
      }
    }
  };
  walk(doc.contents, "", 0);
  return out;
}
```

- [ ] **Step 5: Dispatch YAML**

In `src/artifacts/configKeys.ts`, add `import { parseYamlKeys } from "./yamlKeys";` and a case:

```ts
    case "yaml":
      return parseYamlKeys(text);
```

- [ ] **Step 6: Run tests**

Run: `bun test && bun run typecheck && bun run build`
Expected: PASS, and the binary still compiles with the new dependency bundled.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/artifacts/yamlKeys.ts src/artifacts/configKeys.ts test/config-keys.test.ts test/fixtures/artifacts-app
git commit -m "feat(artifacts): YAML config keys with real spans (#101)"
```

---

### Task 6: Deployment-env namespaces (unit D)

**Files:**
- Create: `src/artifacts/deployEnv.ts`
- Modify: `src/artifacts/index.ts`, `test/config-keys.test.ts`, `test/fixtures/artifacts-app/Dockerfile`

**Interfaces:**
- Consumes: `keyNode`, `parseYamlKeys`
- Produces: `deploymentEnvKeys(format, roles, text): TSConfigKey[]`

- [ ] **Step 1: Grow the fixture**

```bash
cd test/fixtures/artifacts-app
cat > Dockerfile <<'EOF'
FROM node:22
ARG BUILD_ID=local
ENV PAYMENT_HOST=https://pay.example.com
ENV FEATURE_FLAG "on"
COPY . .
EOF
```

- [ ] **Step 2: Write the failing test**

Append to `test/config-keys.test.ts`:

```ts
describe("deployment-env namespaces (#101 unit D)", () => {
  test("Dockerfile ENV mints bindable env keys; ARG stays non-bindable dockerfile", () => {
    const k = keysOf("Dockerfile");
    expect(k["PAYMENT_HOST"]?.namespace).toBe("env");
    expect(k["PAYMENT_HOST"]?.value).toBe("https://pay.example.com");
    expect(k["FEATURE_FLAG"]?.namespace).toBe("env");
    expect(k["BUILD_ID"]?.namespace).toBe("dockerfile"); // build-time only, never joins a read
  });

  test("compose environment blocks mint env keys ALONGSIDE the structural yaml keys", () => {
    const k = keysOf("docker-compose.yml");
    expect(k["services.web.environment.PAYMENT_HOST"]?.namespace).toBe("yaml"); // structural
    const envKeys = (arts["docker-compose.yml"]?.config_keys ?? []).filter((x) => x.namespace === "env");
    expect(envKeys.map((x) => x.key).sort()).toEqual(["FEATURE_FLAG", "PAYMENT_HOST"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/config-keys.test.ts -t "deployment-env"`
Expected: FAIL — no `env`-namespace keys from Dockerfile or compose.

- [ ] **Step 4: Write the deployment-env extractor**

Create `src/artifacts/deployEnv.ts`:

```ts
/**
 * Deployment-env sources (#101 unit D): Dockerfile ENV, compose `environment`, and k8s container
 * `env` mint BINDABLE `env`-namespace keys — the ones a `process.env.X` read joins — in addition
 * to whatever structural key the file already produced. Dockerfile ARG mints a
 * `dockerfile`-namespace key that is deliberately NON-bindable: build-time only.
 */
import { keyNode } from "./configKeys";
import { parseYamlKeys } from "./yamlKeys";
import type { TSConfigKey, TSSpan } from "../schema";

const DOCKER_LINE = /^\s*(ENV|ARG)\s+(.*)$/i;

export function parseDockerfileEnv(text: string): TSConfigKey[] {
  const out: TSConfigKey[] = [];
  text.split("\n").forEach((line, i) => {
    const m = DOCKER_LINE.exec(line);
    if (!m) return;
    const directive = (m[1] as string).toUpperCase();
    const rest = (m[2] as string).trim();
    const span: TSSpan = { start: [i + 1, 1], end: [i + 1, line.length + 1], bytes: [0, 0] };
    // `ENV K=V` and the legacy `ENV K V` both occur; ARG may be bare (`ARG X`).
    const eq = rest.indexOf("=");
    const [name, raw] = eq > 0 ? [rest.slice(0, eq), rest.slice(eq + 1)] : (() => {
      const sp = rest.indexOf(" ");
      return sp > 0 ? [rest.slice(0, sp), rest.slice(sp + 1)] : [rest, ""];
    })();
    let value = raw.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out.push(keyNode(name.trim(), directive === "ENV" ? "env" : "dockerfile", value, span));
  });
  return out;
}

/**
 * compose `services.<svc>.environment` (map or list form) and k8s
 * `spec.containers[].env[].name/value` → bindable env keys. Derived from the already-flattened
 * yaml keys so there is exactly one YAML parse per artifact.
 */
export function yamlEnvKeys(text: string): TSConfigKey[] {
  const flat = parseYamlKeys(text);
  const out: TSConfigKey[] = [];
  const seen = new Set<string>();
  const push = (name: string, value: unknown, span?: TSSpan): void => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push(keyNode(name, "env", value, span));
  };
  for (const k of flat) {
    // compose map form: services.<svc>.environment.<NAME>
    const compose = /^services\.[^.]+\.environment\.([^.]+)$/.exec(k.key);
    if (compose) {
      push(compose[1] as string, k.value, k.span);
      continue;
    }
    // compose list form: services.<svc>.environment.<i> = "NAME=value"
    const composeList = /^services\.[^.]+\.environment\.\d+$/.exec(k.key);
    if (composeList && typeof k.value === "string") {
      const eq = k.value.indexOf("=");
      if (eq > 0) push(k.value.slice(0, eq), k.value.slice(eq + 1), k.span);
      continue;
    }
    // k8s: (spec|template.spec).containers.<i>.env.<j>.name = NAME (value on the sibling key)
    const k8s = /^(.*\.containers\.\d+\.env\.\d+)\.name$/.exec(k.key);
    if (k8s && typeof k.value === "string") {
      const sibling = flat.find((x) => x.key === `${k8s[1]}.value`);
      push(k.value, sibling?.value, k.span);
    }
  }
  return out;
}

/** Every bindable/deployment key an artifact contributes, by format. */
export function deploymentEnvKeys(format: string, text: string): TSConfigKey[] {
  if (format === "dockerfile") return parseDockerfileEnv(text);
  if (format === "yaml") return yamlEnvKeys(text);
  return [];
}
```

- [ ] **Step 5: Attach in the walk**

In `src/artifacts/index.ts`, import `deploymentEnvKeys` and, in the same extraction block as Task 4's keys:

```ts
      const deployKeys = deploymentEnvKeys(node.format, text);
      if (deployKeys.length) {
        node.config_keys = [...node.config_keys, ...deployKeys];
        node.extraction = "full";
      }
```

- [ ] **Step 6: Run tests**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/artifacts/deployEnv.ts src/artifacts/index.ts test/config-keys.test.ts test/fixtures/artifacts-app
git commit -m "feat(artifacts): deployment-env keys — Dockerfile ENV/ARG, compose, k8s (#101)"
```

---

### Task 7: `config_access` body nodes (unit C1)

**Files:**
- Modify: `src/schema/schema.ts`, `src/syntactic_analysis/builders.ts`, `src/schema/l1Body.ts`
- Test: `test/config-use.test.ts`, `test/fixtures/artifacts-app/src/config.ts`

**Interfaces:**
- Consumes: `walkBody` handlers in `builders.ts`
- Produces: `TSConfigAccess` (internal, on `TSCallable.config_accesses`), `config_access` body nodes with `root`, `key?`, `span`

- [ ] **Step 1: Grow the fixture**

```bash
cat > test/fixtures/artifacts-app/src/config.ts <<'EOF'
export function readHost(): string | undefined {
  return process.env.PAYMENT_HOST;
}
export function readFlag(): string | undefined {
  return process.env["FEATURE_FLAG"];
}
export function readDestructured(): string | undefined {
  const { NODE_OPTIONS } = process.env;
  return NODE_OPTIONS;
}
export function readVia(name: string): string | undefined {
  return process.env[name];
}
export function readIndirect(): string | undefined {
  const key = "PAYMENT_HOST";
  return process.env[key];
}
export function readUndeclared(): string | undefined {
  return process.env.NOT_DECLARED_ANYWHERE;
}
EOF
```

- [ ] **Step 2: Write the failing test**

Create `test/config-use.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import type { AnalysisOptions } from "../src/options";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/artifacts-app");
function options(level: number): AnalysisOptions {
  return {
    input: FIXTURE, output: null, emit: "json", appName: "artifacts-app", neo4jUri: null,
    neo4jUser: "neo4j", neo4jPassword: "", neo4jDatabase: null, analysisLevel: level,
    graphs: level >= 3 ? ["cfg", "dfg", "pdg", "sdg"] : [], graphFieldDepth: 3, jobs: 1,
    targetFiles: null, skipTests: true, eager: true, noBuild: true, phantoms: true,
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "cants-cu-")), verbosity: 0,
  } as AnalysisOptions;
}

const r1 = await analyze(options(1));
const mod = r1.application.application.symbol_table["src/config.ts"];

describe("config_access body nodes (#101 unit C1)", () => {
  test("member, element, and destructured env reads all mint nodes with keys", () => {
    const nodesOf = (fn: string) => Object.values(mod?.functions[fn]?.body ?? {}).filter((b) => b.kind === "config_access");
    expect(nodesOf("readHost").map((n) => n.key)).toEqual(["PAYMENT_HOST"]);
    expect(nodesOf("readFlag").map((n) => n.key)).toEqual(["FEATURE_FLAG"]);
    expect(nodesOf("readDestructured").map((n) => n.key)).toEqual(["NODE_OPTIONS"]);
    expect(nodesOf("readHost")[0]?.root).toBe("process.env");
    expect(nodesOf("readHost")[0]?.callee).toBeUndefined(); // a read is not a call
  });

  test("a dynamic key mints a node with no key", () => {
    const n = Object.values(mod?.functions["readVia"]?.body ?? {}).filter((b) => b.kind === "config_access");
    expect(n.length).toBe(1);
    expect(n[0]?.key).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/config-use.test.ts -t "config_access"`
Expected: FAIL — no `config_access` nodes exist.

- [ ] **Step 4: Add the schema shapes**

In `src/schema/schema.ts`:

```ts
/** INTERNAL — a recognized configuration read (env root access). Never on the wire; the wire's
 * view is the `config_access` node in the owning callable's `body{}` (built by the l1Body pass). */
export interface TSConfigAccess {
  root: string; // "process.env" | "import.meta.env" | "Bun.env"
  key?: string; // present when statically known
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  bytes: [number, number];
}
```

In `TSCallable`, next to `call_sites`:

```ts
  config_accesses: TSConfigAccess[]; // INTERNAL (stripped from the wire)
```

In `TSBodyNode`, after the call-node attributes:

```ts
  // config_access attributes (copied from the recorded access by the l1Body pass)
  root?: string;
  key?: string;
```

Add `"config_accesses"` to the structural strip in `src/schema/emit.ts`'s `stripCallable`.

- [ ] **Step 5: Record accesses in the builder**

In `src/syntactic_analysis/builders.ts`, add to `BodyHandlers`:

```ts
  onConfigAccess: (n: Node, root: string, key?: string) => void;
```

and inside `walkBody`'s `visit`, before the call check:

```ts
    const access = envRootAccess(node);
    if (access) h.onConfigAccess(node, access.root, access.key);
```

Add the recognizer (module scope):

```ts
const ENV_ROOTS = new Set(["process.env", "import.meta.env", "Bun.env"]);

/** `process.env.X` / `process.env["X"]` / `import.meta.env.X` — a read, not a call. */
function envRootAccess(node: Node): { root: string; key?: string } | null {
  if (Node.isPropertyAccessExpression(node)) {
    const root = node.getExpression().getText();
    if (!ENV_ROOTS.has(root)) return null;
    return { root, key: node.getName() };
  }
  if (Node.isElementAccessExpression(node)) {
    const root = node.getExpression().getText();
    if (!ENV_ROOTS.has(root)) return null;
    const arg = node.getArgumentExpression();
    return { root, ...(arg && Node.isStringLiteral(arg) ? { key: arg.getLiteralValue() } : {}) };
  }
  return null;
}
```

Destructuring (`const { X } = process.env`) is a VariableDeclaration whose initializer is an env root: handle it in the same `visit`, emitting one access per binding element:

```ts
    if (Node.isVariableDeclaration(node)) {
      const init = node.getInitializer();
      const name = node.getNameNode();
      if (init && ENV_ROOTS.has(init.getText()) && Node.isObjectBindingPattern(name)) {
        for (const el of name.getElements()) {
          h.onConfigAccess(el, init.getText(), el.getPropertyNameNode()?.getText() ?? el.getName());
        }
      }
    }
```

In `buildCallable`'s handlers object:

```ts
    onConfigAccess: (n, root, key) =>
      config_accesses.push({
        root,
        ...(key !== undefined ? { key } : {}),
        ...span(n),
        bytes: [n.getStart(), n.getEnd()],
      }),
```

declaring `const config_accesses: TSConfigAccess[] = [];` beside `call_sites`, adding it to the returned callable, and adding a no-op `onConfigAccess: () => {}` to the two other `walkBody` call sites (`buildStatemented`'s bare-anon sweep and any other handler literal) so module-scope accesses are not attributed to a callable.

- [ ] **Step 6: Emit the body nodes**

In `src/schema/l1Body.ts`, after the call-node loop inside `resetCallable`:

```ts
  // config_access nodes share the body key space with calls: allocate AFTER them, disambiguating
  // against keys already present so a read and a call on one line never collide.
  for (const ca of c.config_accesses) {
    const base = `${ca.start_line}:${ca.start_column}`;
    let key = base;
    for (let k = 2; key in body; k++) key = `${base}/${k}`;
    body[key] = {
      kind: "config_access",
      span: { start: [ca.start_line, ca.start_column], end: [ca.end_line, ca.end_column], bytes: ca.bytes },
      root: ca.root,
      ...(ca.key !== undefined ? { key: ca.key } : {}),
    };
  }
```

- [ ] **Step 7: Run tests**

Run: `bun test && bun run typecheck`
Expected: PASS. Monotonicity and count-parity gates in `test/schema-v2.test.ts` cover body nodes generically and should stay green; if a hard-coded count fails, update the number.

- [ ] **Step 8: Commit**

```bash
git add src/schema/schema.ts src/schema/l1Body.ts src/schema/emit.ts src/syntactic_analysis/builders.ts test/config-use.test.ts test/fixtures/artifacts-app/src/config.ts
git commit -m "feat(schema): config_access body nodes for env reads (#101)"
```

---

### Task 8: Literal tier + first-class unresolved reads (unit C2/C3)

**Files:**
- Create: `src/semantic_analysis/configUseRules.ts`, `src/semantic_analysis/configUse.ts`
- Modify: `src/schema/schema.ts`, `src/schema/emit.ts`, `src/core.ts`
- Test: `test/config-use.test.ts`

**Interfaces:**
- Consumes: `AnalysisInternal.artifacts` (config keys), `TSModule`, `forEachCallable`
- Produces: `TSConfigUse`, `TSConfigRead`, `resolveLiteralConfigUses(app, appId): { uses: TSConfigUse[]; reads: TSConfigRead[] }`

- [ ] **Step 1: Write the failing test**

Append to `test/config-use.test.ts`:

```ts
const r2 = await analyze(options(2));
const app2 = r2.application.application;
const useDsts = (fnFragment: string): string[] =>
  app2.config_uses.filter((u) => u.src.includes(fnFragment)).map((u) => u.dst).sort();

describe("config_use literal tier (#101 unit C3)", () => {
  test("a literal env read joins every declaring ConfigKey", () => {
    const dsts = useDsts("readHost");
    expect(dsts).toContain("can://artifact/artifacts-app/.env@key/PAYMENT_HOST");
    expect(dsts).toContain("can://artifact/artifacts-app/Dockerfile@key/PAYMENT_HOST");
    expect(app2.config_uses.every((u) => u.prov.includes("literal"))).toBe(true);
  });

  test("src is a global ordinal body-node id", () => {
    const u = app2.config_uses.find((x) => x.src.includes("readHost"));
    expect(u?.src).toMatch(/^can:\/\/typescript\/artifacts-app\/src\/config\.ts\/readHost@\d+:\d+$/);
  });

  test("a literal with no declared key is an undefined-key read, not an edge", () => {
    const read = app2.config_reads.find((r) => r.key === "NOT_DECLARED_ANYWHERE");
    expect(read?.reason).toBe("undefined-key");
    expect(read?.prov).toEqual(["literal"]);
    expect(app2.config_uses.some((u) => u.src.includes("readUndeclared"))).toBe(false);
  });

  test("a dynamic key is a non-literal read at L2", () => {
    const read = app2.config_reads.find((r) => r.site.includes("readVia"));
    expect(read?.reason).toBe("non-literal");
    expect(read?.key).toBeUndefined();
  });

  test("Dockerfile ARG is never bindable", () => {
    expect(app2.config_uses.some((u) => u.dst.endsWith("@key/BUILD_ID"))).toBe(false);
  });
});
```

- [ ] **Step 1b: Add the call-rule fixture and test**

```bash
cat >> test/fixtures/artifacts-app/src/config.ts <<'EOF'
import nconf from "nconf";
export function readViaLibrary(): string | undefined {
  return nconf.get("PAYMENT_HOST");
}
EOF
```

Append to `test/config-use.test.ts`'s literal-tier describe block:

```ts
  test("a CALL rule resolves through the resolved external callee", () => {
    const dsts = useDsts("readViaLibrary");
    expect(dsts.some((d) => d.endsWith("@key/PAYMENT_HOST"))).toBe(true);
    const u = app2.config_uses.find((x) => x.src.includes("readViaLibrary"));
    expect(u?.src).toMatch(/@\d+:\d+$/); // the CALL node's ordinal id
  });
```

(`nconf` need not be installed: with `phantoms: true` the resolver homes the callee as an
external symbol keyed by the import specifier, which is exactly what the rule matches on.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config-use.test.ts -t "literal tier"`
Expected: FAIL — `config_uses` is not a property of the application.

- [ ] **Step 3: Add the wire shapes**

In `src/schema/schema.ts`:

```ts
/** One resolved config read: a recognized read whose key closed on exactly one literal that
 * matches a declared ConfigKey. `src` is the read's GLOBAL ordinal id; `dst` the key's id. */
export interface TSConfigUse {
  src: string;
  dst: string;
  prov: Array<"literal" | "dataflow">;
}

/** A recognized read that resolved to no declared key — first class, so an untraceable read is
 * as visible as a traced one. `config_reads` SHRINKS as levels rise (higher tiers resolve some);
 * that is deliberate and is the layer's one non-monotonic section. */
export interface TSConfigRead {
  site: string; // GLOBAL ordinal id
  callee: string; // the read root ("process.env") or the resolved callee id for call rules
  key?: string; // set only for reason "undefined-key"
  reason: "non-literal" | "undefined-key";
  prov: Array<"literal" | "dataflow">;
}
```

Add to `AnalysisInternal` and to `TSApplication`:

```ts
  config_uses: TSConfigUse[];
  config_reads: TSConfigRead[];
```

(optional on `AnalysisInternal`, required on `TSApplication`), and in `src/schema/emit.ts`'s root literal:

```ts
    config_uses: app.config_uses ?? [],
    config_reads: app.config_reads ?? [],
```

- [ ] **Step 4: Ship the detector table**

Create `src/semantic_analysis/configUseRules.ts`:

```ts
/**
 * Shipped config-use detector table (#101 unit C2). Two rule kinds: ACCESS rules name env roots
 * whose member/element reads are configuration reads (recognized in builders.ts, which mints the
 * `config_access` body node); CALL rules name a module+callable whose argument at `key_arg`
 * carries the key. No user-extension flag — same posture as the artifact rules table.
 */
export interface AccessRule {
  root: string;
  namespaces: string[];
}
export interface CallRule {
  id: string;
  module: string; // matched prefix-aware against the resolved callee's external module
  callable: string;
  key_arg: number;
  namespaces: string[];
}

export const ACCESS_RULES: AccessRule[] = [
  { root: "process.env", namespaces: ["env"] },
  { root: "import.meta.env", namespaces: ["env"] },
  { root: "Bun.env", namespaces: ["env"] },
];

export const CALL_RULES: CallRule[] = [
  { id: "deno.env.get", module: "Deno.env", callable: "get", key_arg: 0, namespaces: ["env"] },
  { id: "config.get", module: "config", callable: "get", key_arg: 0, namespaces: ["json", "yaml"] },
  { id: "config.has", module: "config", callable: "has", key_arg: 0, namespaces: ["json", "yaml"] },
  { id: "nconf.get", module: "nconf", callable: "get", key_arg: 0, namespaces: ["json", "yaml", "env"] },
  { id: "dotenv.parse", module: "dotenv", callable: "parse", key_arg: 0, namespaces: ["env"] },
];
```

- [ ] **Step 5: Write the literal tier**

Create `src/semantic_analysis/configUse.ts`:

```ts
/**
 * config_use literal tier (#101 unit C3). Runs with the call graph — the L2 stage — because call
 * rules need resolved callees. Joins a read's statically-known key to declared ConfigKeys on
 * (namespace, key); a read that resolves to nothing becomes a first-class `config_reads` record.
 * Deterministic: every output list is sorted.
 */
import type { AnalysisInternal, TSConfigRead, TSConfigUse } from "../schema";
import { forEachCallable, type TSCallable } from "../schema";
import { callBodyKeys } from "../schema/l1Body";
import { ACCESS_RULES, CALL_RULES, type CallRule } from "./configUseRules";

/** (namespace, key) → declared ConfigKey ids, sorted. */
export function keyIndex(app: AnalysisInternal): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const art of Object.values(app.artifacts ?? {})) {
    for (const ck of art.config_keys) {
      const k = `${ck.namespace} ${ck.key}`;
      const arr = idx.get(k) ?? [];
      arr.push(ck.id);
      idx.set(k, arr);
    }
  }
  for (const arr of idx.values()) arr.sort();
  return idx;
}

export interface LiteralTierResult {
  uses: TSConfigUse[];
  reads: TSConfigRead[];
}

export function resolveLiteralConfigUses(app: AnalysisInternal): LiteralTierResult {
  const idx = keyIndex(app);
  const uses: TSConfigUse[] = [];
  const reads: TSConfigRead[] = [];
  const rootNamespaces = new Map(ACCESS_RULES.map((r) => [r.root, r.namespaces]));

  for (const mod of Object.values(app.symbol_table)) {
    forEachCallable(mod, (c) => {
      for (const [local, node] of Object.entries(c.body)) {
        // CALL rules: a `call` node whose resolved callee matches module+callable, with the key
        // at `key_arg`. The key literal comes from the recorded call site's arguments; a call
        // whose key argument is not a literal is a non-literal read, same as a dynamic access.
        if (node.kind === "call") {
          const rule = matchCallRule(node.callee, externalIndex);
          if (!rule) continue;
          const site = `${c.id}@${local}`;
          const key = literalArgumentAt(c, local, rule.key_arg);
          if (key === undefined) {
            reads.push({ site, callee: String(node.callee), reason: "non-literal", prov: ["literal"] });
            continue;
          }
          const dsts = rule.namespaces.flatMap((ns) => idx.get(`${ns} ${key}`) ?? []);
          if (!dsts.length) {
            reads.push({ site, callee: String(node.callee), key, reason: "undefined-key", prov: ["literal"] });
            continue;
          }
          for (const dst of [...new Set(dsts)].sort()) uses.push({ src: site, dst, prov: ["literal"] });
          continue;
        }
        if (node.kind !== "config_access") continue;
        const site = `${c.id}@${local}`;
        const root = String(node.root ?? "");
        const namespaces = rootNamespaces.get(root) ?? ["env"];
        if (node.key === undefined) {
          reads.push({ site, callee: root, reason: "non-literal", prov: ["literal"] });
          continue;
        }
        const dsts = namespaces.flatMap((ns) => idx.get(`${ns} ${node.key}`) ?? []);
        if (!dsts.length) {
          reads.push({ site, callee: root, key: node.key as string, reason: "undefined-key", prov: ["literal"] });
          continue;
        }
        for (const dst of [...new Set(dsts)].sort()) uses.push({ src: site, dst, prov: ["literal"] });
      }
    });
  }
  uses.sort((a, b) => a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst));
  reads.sort((a, b) => a.site.localeCompare(b.site) || (a.key ?? "").localeCompare(b.key ?? ""));
  return { uses, reads };
}

/**
 * A call node's resolved `callee` id names an external as
 * `can://…/@external/<module>/<member>`. Match prefix-aware on module (python's rule: a rule for
 * `config` matches `config` and `config/lib/x`) and exactly on the member.
 */
export function matchCallRule(callee: unknown, externals: Map<string, { module: string; name: string }>): CallRule | null {
  if (typeof callee !== "string") return null;
  const ext = externals.get(callee);
  if (!ext) return null;
  for (const rule of CALL_RULES) {
    if (rule.callable !== ext.name) continue;
    if (ext.module === rule.module || ext.module.startsWith(`${rule.module}/`)) return rule;
  }
  return null;
}

/** The string literal at `argIndex` of the call site backing this body key, or undefined. */
export function literalArgumentAt(c: TSCallable, bodyKey: string, argIndex: number): string | undefined {
  for (const [key, cs] of callBodyKeys(c.call_sites)) {
    if (key !== bodyKey) continue;
    const raw = cs.arguments?.[argIndex];
    if (raw === undefined) return undefined;
    const m = /^["'`](.*)["'`]$/.exec(raw.trim());
    return m ? (m[1] as string) : undefined;
  }
  return undefined;
}
```

`literalArgumentAt` needs the call site's argument TEXTS, which `TSCallsite` does not record today
(it stores `argument_types`). Add them in this task: in `src/schema/schema.ts` give `TSCallsite`

```ts
  arguments: string[]; // raw source text per argument — INTERNAL, feeds the config-use key match
```

and in `src/syntactic_analysis/builders.ts`'s `buildCallsite`, alongside `argument_types`:

```ts
    arguments: args.map((a) => a.getText()),
```

It is INTERNAL (never on the wire): `l1Body` does not copy it onto the body node, and python
records the same datum on its call sites for the same reason.

The external index is built from the application: `new Map(Object.entries(app.external_symbols ?? {}).map(([sig, e]) => [extIdOf(sig), e]))` — but the resolved `callee` is already the can:// external id, so pass `root.external_symbols` keyed by id directly (they are keyed by id after homing).

- [ ] **Step 6: Wire the pipeline**

In `src/core.ts`, after the call-graph block and before the program graphs, and only at `analysisLevel >= 2`:

```ts
  // config_use literal tier (#101): needs the artifact layer's keys and, for call rules, the
  // resolved call graph — so it runs with the L2 stage. Ids inside `src`/`dst` are stamped by
  // assignIds during finalize; the tier records them against the same per-run ids.
  let configUses: TSConfigUse[] = [];
  let configReads: TSConfigRead[] = [];
```

Because `src`/`dst` reference `can://` ids that `assignIds` stamps during `finalizeAnalysis`, run the tier **inside** `finalizeAnalysis` instead, immediately after `backfillCallees` at `level >= 2`:

```ts
    const literal = resolveLiteralConfigUses(app);
    root.config_uses = literal.uses;
    root.config_reads = literal.reads;
```

(import from `../semantic_analysis/configUse`). Delete the two `let` declarations from `core.ts` if you added them — the tier lives in `emit.ts` where the ids exist.

- [ ] **Step 7: Run tests**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/semantic_analysis/configUseRules.ts src/semantic_analysis/configUse.ts src/schema/schema.ts src/schema/emit.ts test/config-use.test.ts
git commit -m "feat(callgraph): config_use literal tier + first-class unresolved reads (#101)"
```

---

### Task 9: Dataflow tiers (unit C3)

**Files:**
- Create: `src/dataflow/configUse.ts`
- Modify: `src/schema/emit.ts`
- Test: `test/config-use.test.ts`

**Interfaces:**
- Consumes: `LiteralTierResult`, `ProgramGraphs`, `AnalysisInternal`
- Produces: `widenConfigUsesWithDataflow(app, pg, literal, level)` → `LiteralTierResult`

- [ ] **Step 1: Write the failing test**

Append to `test/config-use.test.ts`:

```ts
const r3 = await analyze(options(3));
const app3 = r3.application.application;

describe("config_use dataflow tiers (#101 unit C3)", () => {
  test("an indirect key resolves at -a 3 and carries prov dataflow", () => {
    const u = app3.config_uses.find((x) => x.src.includes("readIndirect"));
    expect(u?.dst).toContain("@key/PAYMENT_HOST");
    expect(u?.prov).toContain("dataflow");
  });

  test("config_uses is superset-monotonic L2 ⊆ L3", () => {
    const key = (u: { src: string; dst: string }): string => `${u.src} ${u.dst}`;
    const l3 = new Set(app3.config_uses.map(key));
    for (const u of app2.config_uses) expect(l3.has(key(u))).toBe(true);
  });

  test("config_reads shrinks as levels rise (the deliberate non-monotonic section)", () => {
    expect(app3.config_reads.length).toBeLessThan(app2.config_reads.length);
    // a read that never closes on a literal stays unresolved at every level
    expect(app3.config_reads.some((r) => r.site.includes("readVia"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config-use.test.ts -t "dataflow tiers"`
Expected: FAIL — `readIndirect` has no edge at L3.

- [ ] **Step 3: Write the widening pass**

Create `src/dataflow/configUse.ts`:

```ts
/**
 * config_use dataflow tiers (#101 unit C3). Widens the literal tier over the def-use substrate:
 *
 *  - INTRA (-a 3): the read's key expression is a local identifier whose reaching definitions in
 *    this callable all agree on ONE string literal.
 *  - INTERPROC (-a 4): the key is a parameter, and every resolved internal call site passes the
 *    same string literal at that position (one call boundary, no fixpoint).
 *
 * Superset-monotonic: it only ADDS uses, and only REMOVES the corresponding `config_reads`.
 */
import { Node, type Project } from "ts-morph";
import type { AnalysisInternal, TSConfigRead, TSConfigUse } from "../schema";
import { keyIndex } from "../semantic_analysis/configUse";

export interface ConfigUseSets {
  uses: TSConfigUse[];
  reads: TSConfigRead[];
}

/**
 * `project` gives the AST the tiers read; `astKeyOf` returns the literal a read's key expression
 * closes on, or null. Intra: an identifier with a single string-literal initializer whose binding
 * is never reassigned. Interproc (level >= 4): a parameter whose every resolved caller argument
 * is the same literal.
 */
export function widenConfigUses(
  app: AnalysisInternal,
  project: Project,
  literal: ConfigUseSets,
  level: number,
): ConfigUseSets {
  if (level < 3) return literal;
  const idx = keyIndex(app);
  const uses = [...literal.uses];
  const resolvedSites = new Set<string>();

  for (const read of literal.reads) {
    if (read.reason !== "non-literal") continue;
    const key = resolveKeyThroughDataflow(read, project, app, level);
    if (key === null) continue;
    const dsts = idx.get(`env ${key}`) ?? [];
    if (!dsts.length) continue;
    for (const dst of [...new Set(dsts)].sort()) {
      uses.push({ src: read.site, dst, prov: ["dataflow"] });
    }
    resolvedSites.add(read.site);
  }

  const reads = literal.reads
    .filter((r) => !resolvedSites.has(r.site))
    .map((r) => (resolvedSites.size ? { ...r, prov: [...new Set([...r.prov, "dataflow" as const])] } : r));
  uses.sort((a, b) => a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst));
  return { uses, reads };
}
```

Implement `resolveKeyThroughDataflow` in the same file: locate the read's AST node by span (the `site` id's `@line:col` suffix plus the callable's file), take its key expression, and

```ts
function resolveKeyThroughDataflow(
  read: TSConfigRead,
  project: Project,
  app: AnalysisInternal,
  level: number,
): string | null {
  const node = accessNodeFor(read.site, project, app);
  if (!node || !Node.isElementAccessExpression(node)) return null;
  const arg = node.getArgumentExpression();
  if (!arg || !Node.isIdentifier(arg)) return null;
  const decl = arg.getSymbol()?.getDeclarations()?.[0];
  if (!decl) return null;
  // INTRA: `const key = "LITERAL"` in the same callable, never reassigned.
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && Node.isStringLiteral(init) && !isReassigned(decl)) return init.getLiteralValue();
    return null;
  }
  // INTERPROC (-a 4): a parameter whose every resolved caller passes one identical literal.
  if (level >= 4 && Node.isParameterDeclaration(decl)) return uniqueLiteralArgument(decl, app, project);
  return null;
}
```

with `accessNodeFor` (span lookup, mirroring `indexCallExpressions`'s keying), `isReassigned` (any assignment whose left side resolves to the same declaration), and `uniqueLiteralArgument` (walk `app.call_graph` edges whose `target` is the enclosing callable's signature, fetch each call AST node, read the argument at the parameter's index, return the literal when all agree). Each helper stays under 30 lines; write them alongside the tests below.

- [ ] **Step 4: Wire it into finalize**

In `src/schema/emit.ts`, `finalizeAnalysis` gains an optional `project` parameter (the root ts-morph `Project`, already available in `core.ts`), and after the literal tier:

```ts
  if (level >= 3 && project) {
    const widened = widenConfigUses(app, project, { uses: root.config_uses, reads: root.config_reads }, level);
    root.config_uses = widened.uses;
    root.config_reads = widened.reads;
  }
```

`core.ts` passes `project` through.

- [ ] **Step 5: Run tests**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dataflow/configUse.ts src/schema/emit.ts src/core.ts test/config-use.test.ts
git commit -m "feat(dataflow): config_use intra + interprocedural tiers (#101)"
```

---

### Task 10: Neo4j projection + version revert

**Files:**
- Modify: `src/build/neo4j/schema.ts`, `src/build/neo4j/project.ts`, `schema.neo4j.json`
- Test: `test/config-use.test.ts`, `test/neo4j-schema.test.ts`, `test/schema-v2.test.ts`

**Interfaces:**
- Consumes: `TSApplication.artifacts[].config_keys`, `config_uses`
- Produces: `ConfigKey` node label, `DEFINES_CONFIG` and `TS_USES_CONFIG` relationship types

- [ ] **Step 1: Write the failing test**

Append to `test/config-use.test.ts`:

```ts
import { project as neoProject } from "../src/build/neo4j";

describe("Neo4j projection of the config layer (#101)", () => {
  const rows = neoProject(r2.application);

  test("ConfigKey nodes are neutral and hang off their artifact", () => {
    const id = "can://artifact/artifacts-app/.env@key/PAYMENT_HOST";
    const n = rows.nodes.find((x) => x.value === id);
    expect(n?.labels).toContain("ConfigKey");
    expect(n?.labels).not.toContain("TSConfigKey");
    expect(rows.edges.some((e) => e.type === "DEFINES_CONFIG" && e.to.value === id)).toBe(true);
  });

  test("TS_USES_CONFIG carries prov and points at a ConfigKey", () => {
    const e = rows.edges.find((x) => x.type === "TS_USES_CONFIG");
    expect(e?.props["prov"]).toEqual(["literal"]);
    expect(String(e?.to.value)).toContain("@key/");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config-use.test.ts -t "Neo4j projection of the config"`
Expected: FAIL — no `ConfigKey` rows.

- [ ] **Step 3: Revert the version and declare the vocabulary**

In `src/build/neo4j/schema.ts`: set `export const SCHEMA_VERSION = "2.1.0";` (reverting #103's bump), add the label beside `Package`:

```ts
  {
    label: "ConfigKey",
    mergeLabel: "ConfigKey",
    key: "id",
    properties: { id: "string", key: "string", namespace: "string", value: "string", references: "string[]" },
  },
```

and the relationships beside the artifact-layer block:

```ts
  { type: "DEFINES_CONFIG", from: ["Artifact"], to: ["ConfigKey"], properties: {} },
  { type: "TS_USES_CONFIG", from: ["TSBodyNode"], to: ["ConfigKey"], properties: { prov: "string[]" } },
```

- [ ] **Step 4: Project the rows**

In `src/build/neo4j/project.ts`, inside the artifact loop after `b.edge("HAS_ARTIFACT", …)`:

```ts
    for (const ck of art.config_keys) {
      const kRef = b.node(["ConfigKey"], "id", ck.id, prune({
        id: ck.id, key: ck.key, namespace: ck.namespace,
        value: ck.value !== undefined ? String(ck.value) : null,
        references: ck.references.length ? ck.references : null,
      }));
      b.edge("DEFINES_CONFIG", aRef, kRef);
    }
```

and after the dependency/unresolved block:

```ts
  for (const u of root.config_uses ?? []) {
    b.edge("TS_USES_CONFIG", ref(u.src), { label: "ConfigKey", keyProp: "id", value: u.dst }, prune({ prov: u.prov }));
  }
```

- [ ] **Step 5: Teach the gates**

In `test/neo4j-schema.test.ts`, add `"ConfigKey"` to `NEUTRAL_LABELS` and `"DEFINES_CONFIG"` to `NEUTRAL_RELS`. In `test/schema-v2.test.ts`, add config-key rows to the node-count expectation and `"DEFINES_CONFIG"`/`"TS_USES_CONFIG"` to the artifact-layer edge sum.

- [ ] **Step 6: Regenerate and run**

Run: `bun run gen:schema && bun test && bun run typecheck`
Expected: PASS; `schema.neo4j.json` shows the new labels with `schema_version` still `2.1.0`.

- [ ] **Step 7: Commit**

```bash
git add src/build/neo4j/schema.ts src/build/neo4j/project.ts schema.neo4j.json test/config-use.test.ts test/neo4j-schema.test.ts test/schema-v2.test.ts
git commit -m "feat(neo4j): ConfigKey/DEFINES_CONFIG/TS_USES_CONFIG; revert the version bump (#101)"
```

---

### Task 11: Consumer skill, docs, and the payload measurement

**Files:**
- Create: `docs/skills/analyzing-cants-graphs/SKILL.md`, `references/vocabulary.md`, `references/analyses.md`
- Modify: `CLAUDE.md`, `README.md`, `.claude/SCHEMA_DECISIONS.md`, `docs/design/specs/artifacts-and-dependencies.md`

**Interfaces:**
- Consumes: the shipped vocabulary from Tasks 1–10
- Produces: consumer documentation; no code

- [ ] **Step 1: Measure the transitive payload**

```bash
S=/private/tmp/claude-501/-Users-rkrsn-workspace-codellm-devkit-codeanalyzer-typescript/aa8a01c3-0b52-4850-81f9-c37f12e945a4/scratchpad
bun run src/index.ts -i "$S/vscode" -a 1 -o /tmp/vscode-artifacts >/dev/null
python3 - <<'PY'
import json
d = json.load(open("/tmp/vscode-artifacts/analysis.json"))["application"]
deps = d["dependencies"]
print("artifacts:", len(d["artifacts"]))
print("dependencies:", len(deps), "direct:", sum(1 for x in deps if x["direct"]), "transitive:", sum(1 for x in deps if not x["direct"]))
print("payload MB:", round(len(json.dumps(d)) / 1e6, 1))
PY
```

Record the numbers — they go in the PR body and in the skill's dependency section.

- [ ] **Step 2: Write the skill**

Create `docs/skills/analyzing-cants-graphs/SKILL.md` with YAML frontmatter (`name: analyzing-cants-graphs`, a `description` naming the query surface), a level table (which nodes/edges exist at `-a 1|2|3|4`), an identity section (`can://` code ids, `can://artifact/...`, purl, `@key/`), and a **standing traps** section carrying the guidance verbatim from the spec's consumer-documentation section:

> Your dependency *surface* and your dependency *supply chain* are different questions.
> "What does this app declare?" filters `direct: true`. "What actually ships / where does
> CVE-XXXX live?" needs the transitives — a vulnerable package four levels down is in your
> bundle whether or not you named it.

plus the `config_reads` shrink, the `--app-name` join precondition, `sha256`-vs-truncated-`source`, `value` absent under `--no-artifact-text`, `ARG` non-bindable, and `config_access` carrying no `callee`.

- [ ] **Step 3: Write the references**

`references/vocabulary.md`: every label, relationship, and property this analyzer emits, in tables — including `direct: false` = lockfile-only transitive on `DECLARES_DEPENDENCY`.
`references/analyses.md`: runnable Cypher recipes, each stating its minimum `-a` level, including both dependency queries side by side:

```cypher
// declared surface only
MATCH (:Artifact)-[d:DECLARES_DEPENDENCY {direct: true}]->(p:Package) RETURN p.name, d.kind, d.spec;
// full shipped set, transitives included (supply chain / CVE questions)
MATCH (:Artifact)-[d:DECLARES_DEPENDENCY]->(p:Package)
OPTIONAL MATCH (:Artifact)-[l:LOCKS]->(p) RETURN p.name, d.direct, coalesce(l.version, d.spec);
// which code reads a config key
MATCH (b:TSBodyNode)-[u:TS_USES_CONFIG]->(k:ConfigKey) RETURN b.id, k.key, k.namespace, u.prov;
// config reads nobody can trace (JSON only — not in the graph)
```

- [ ] **Step 4: Update repo docs**

`CLAUDE.md`: replace the artifact-layer paragraph with the v1.3.0 contract (three sections, config keys, config_use tiers, the skill's location).
`README.md`: run `bun run gen:readme` for the `--help` block; add a short artifact-layer bullet to the feature list.
`.claude/SCHEMA_DECISIONS.md`: append the decisions — `config_access` as new L1 vocabulary, the deliberate `config_reads` shrink, `direct: false` transitives, `SCHEMA_VERSION` held.
`docs/design/specs/artifacts-and-dependencies.md`: add a `> Superseded by 2026-08-30-artifact-layer-v130-parity.md` line at the top.

- [ ] **Step 5: Full verification**

```bash
bun test && bun run typecheck && bun run build && bun run gen:schema && git diff --stat schema.neo4j.json
```

Expected: all green; `schema.neo4j.json` unchanged by the regen (Task 10 already committed it).

- [ ] **Step 6: Commit**

```bash
git add docs/skills CLAUDE.md README.md .claude/SCHEMA_DECISIONS.md docs/design/specs
git commit -m "docs: consumer query skill + artifact-layer docs (#101)"
```

- [ ] **Step 7: Update the PR**

```bash
git push
gh pr edit 103 --body-file <(cat <<'EOF'
Closes #101. Stacked on #102. Spec: docs/design/specs/2026-08-30-artifact-layer-v130-parity.md
Plan: docs/design/plans/2026-08-30-artifact-layer-v130-parity.md
EOF
)
```

Then extend the body with the measured payload numbers from Step 1 and the unit-by-unit summary.

---

## Self-Review

**Spec coverage (re-checked after fixing the call-rule gap):** unit A → Tasks 1–3; unit B → Tasks 4–5; unit D → Task 6; unit C → Tasks 7–9; Neo4j section → Task 10; consumer-documentation section → Task 11; gates section → assertions distributed across Tasks 1–10 plus Task 11 Step 5; the payload measurement → Task 11 Step 1.

**Type consistency:** `TSConfigKey` (Task 4) is consumed by name in Tasks 5, 6, 10; `TSConfigUse`/`TSConfigRead` (Task 8) by Tasks 9, 10; `TSConfigAccess` (Task 7) by Task 8's tier via `body[].root`/`key`; `keyIndex`/`resolveLiteralConfigUses` (Task 8) by Task 9; `deploymentEnvKeys` (Task 6) and `extractConfigKeys` (Task 4) by `src/artifacts/index.ts` in their own tasks.

**Known follow-ups (not in this plan, by decision):** `env_file:` indirection in compose (spec §D); extending `CALL_RULES` beyond the shipped five entries as fixtures demand — the matching machinery itself ships in Task 8.
