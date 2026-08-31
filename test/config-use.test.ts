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

  test("a property-initializer env read attributes to the constructor, not module scope", () => {
    const ctor = mod?.types["Client"]?.callables?.["constructor"];
    const nodes = Object.values(ctor?.body ?? {}).filter((b) => b.kind === "config_access");
    expect(nodes.map((n) => n.key)).toEqual(["PAYMENT_HOST"]);
  });

  test("a call and a config read sharing a start position get distinct body keys", () => {
    const body = mod?.functions["readList"]?.body ?? {};
    const call = Object.entries(body).find(([, b]) => b.kind === "call");
    const access = Object.entries(body).find(([, b]) => b.kind === "config_access");
    expect(call).toBeDefined();
    expect(access).toBeDefined();
    const [callKey] = call!;
    const [accessKey, accessNode] = access!;
    expect(accessNode.key).toBe("LIST");
    expect(accessKey).not.toBe(callKey);
    expect(accessKey).toBe(`${callKey}/2`);
  });
});

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
    // Assert the real invariant (namespace, resolved from the TSConfigKey) rather than sniffing
    // the id's "arg." prefix — a dockerfile-namespace key's id is ALWAYS "arg.<name>" (assignIds),
    // so `dst.endsWith("@key/BUILD_ID")` can never be true regardless of what the rule tables do;
    // that made the old assertion pass even if an access/call rule started resolving "dockerfile".
    const namespaceOf = new Map<string, string>();
    for (const art of Object.values(app2.artifacts)) {
      for (const ck of art.config_keys) namespaceOf.set(ck.id, ck.namespace);
    }
    expect(app2.config_uses.some((u) => namespaceOf.get(u.dst) === "dockerfile")).toBe(false);
  });

  test("a CALL rule resolves through the resolved external callee", () => {
    const dsts = useDsts("readViaLibrary");
    expect(dsts.some((d) => d.endsWith("@key/PAYMENT_HOST"))).toBe(true);
    const u = app2.config_uses.find((x) => x.src.includes("readViaLibrary"));
    expect(u?.src).toMatch(/@\d+:\d+$/); // the CALL node's ordinal id
  });

  test("an interpolated template-literal key is a non-literal read (not a bogus undefined-key)", () => {
    const read = app2.config_reads.find((r) => r.site.includes("readTemplateInterpolated"));
    expect(read?.reason).toBe("non-literal");
    expect(read?.key).toBeUndefined();
    expect(app2.config_uses.some((u) => u.src.includes("readTemplateInterpolated"))).toBe(false);
  });

  test("a non-interpolated template literal still resolves like a quoted string", () => {
    const dsts = useDsts("readTemplateLiteral");
    expect(dsts.some((d) => d.endsWith("@key/PAYMENT_HOST"))).toBe(true);
  });
});
