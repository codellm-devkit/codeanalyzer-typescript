/**
 * Schema conformance test (no container needed). Projects the sample fixture and asserts that the
 * real emitter only ever produces node labels, relationship types and properties that the schema
 * (src/build/neo4j/schema.ts) declares. This is the anti-drift guard: if project.ts grows a label
 * or property that schema.ts doesn't declare, this fails — keeping the published schema.json
 * honest. It also checks the checked-in schema.neo4j.json is regenerated (run `bun gen:schema`).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pkg from "../package.json";
import {
  MARKER_LABELS,
  NODE_LABELS,
  REL_TYPES,
  buildSchemaDocument,
  project,
  renderCypher,
  writeCypherFile,
} from "../src/build/neo4j";
import { analyze } from "../src/core";
import { sha256 } from "../src/utils/fs";
import type { AnalysisOptions } from "../src/options";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/dataflow-app");

async function fixtureRows() {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-schema-test-"));
  // --emit neo4j is always full-depth, so exercise every node/edge kind at L4.
  const opts: AnalysisOptions = {
    input: FIXTURE, output: null, emit: "neo4j", appName: "dataflow-app",
    neo4jUri: null, neo4jUser: "neo4j", neo4jPassword: "", neo4jDatabase: null,
    analysisLevel: 4, graphs: ["cfg", "dfg", "pdg", "sdg"], graphFieldDepth: 3, jobs: 1,
    targetFiles: null, skipTests: true, eager: true,
    noBuild: true, phantoms: true, cacheDir, verbosity: 0,
  };
  try {
    return project((await analyze(opts)).application);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

const byLabel = new Map(NODE_LABELS.map((n) => [n.label, n]));
const mergeOf = new Map(NODE_LABELS.map((n) => [n.label, n.mergeLabel]));
const relByType = new Map(REL_TYPES.map((r) => [r.type, r]));
const markers = new Set<string>(MARKER_LABELS);
const mergeLabelsFor = (specifics: string[]) => new Set(specifics.map((s) => mergeOf.get(s)));

/** The specific (schema) label for a node row: the non-merge, non-marker label (`TSApplication`
 * carries `Application` as its merge label; every `CanNode` carries exactly one specific kind label). */
function specificLabel(labels: string[]): string {
  const merge = labels[0];
  return labels.find((l) => l !== merge && !markers.has(l)) ?? merge;
}

const rows = await fixtureRows();

describe("neo4j schema conformance", () => {

  test("every emitted node label + property is declared in the schema", () => {
    for (const node of rows.nodes) {
      const specific = specificLabel(node.labels);
      const decl = byLabel.get(specific);
      expect(decl, `undeclared node label: ${node.labels.join(":")}`).toBeDefined();
      expect(node.labels[0]).toBe(decl!.mergeLabel);

      for (const label of node.labels) {
        const ok = label === decl!.mergeLabel || label === specific || markers.has(label);
        expect(ok, `unexpected label '${label}' on ${specific}`).toBe(true);
      }
      for (const key of Object.keys(node.props)) {
        expect(decl!.properties[key], `undeclared property '${specific}.${key}'`).toBeDefined();
      }
    }
  });

  test("TSApplication retains its display name while merging by id", () => {
    const application = rows.nodes.find((node) => node.labels.includes("TSApplication"));
    const declaration = byLabel.get("TSApplication");

    expect(application, "TSApplication row").toBeDefined();
    expect(application!.keyProp).toBe("id");
    expect(application!.value).toBe("can://dataflow-app");
    expect(application!.props.name).toBe("dataflow-app");
    expect(declaration?.key).toBe("id");
    expect(declaration?.properties.name).toBe("string");
  });

  test("every emitted relationship type + property + endpoint is declared", () => {
    for (const edge of rows.edges) {
      const decl = relByType.get(edge.type);
      expect(decl, `undeclared relationship type: ${edge.type}`).toBeDefined();
      expect(mergeLabelsFor(decl!.from).has(edge.from.label), `bad source ${edge.from.label} for ${edge.type}`).toBe(true);
      expect(mergeLabelsFor(decl!.to).has(edge.to.label), `bad target ${edge.to.label} for ${edge.type}`).toBe(true);
      for (const key of Object.keys(edge.props)) {
        expect(decl!.properties[key], `undeclared property on ${edge.type}.${key}`).toBeDefined();
      }
    }
  });

  // ----- #201: the graph resolves to text -----------------------------------------------------
  // `source` on :TSModule plus byte offsets on every span are what make a node's text reachable.
  // These assert the VALUES, not their presence: a truncated or placeholder source, or char offsets
  // mislabelled as bytes, all satisfy "the property is declared" and fail here.

  test("every :TSModule carries source, and its sha256 is the content_hash on that same node", () => {
    const modules = rows.nodes.filter((n) => specificLabel(n.labels) === "TSModule");
    expect(modules.length).toBeGreaterThan(0);
    for (const m of modules) {
      const src = m.props.source;
      // Always present, never absent: "" is the empty file, and absent must be unreachable.
      expect(typeof src, `no source on ${m.value}`).toBe("string");
      // The hash is over the raw file bytes, so this proves the WHOLE file survived serialization
      // rather than a prefix or a placeholder.
      expect(sha256(Buffer.from(src as string, "utf8")), `source is not the whole file: ${m.value}`)
        .toBe(m.props.content_hash);
    }
  });

  test("span byte offsets slice the module source to each node's own code", () => {
    const srcOf = new Map(
      rows.nodes.filter((n) => specificLabel(n.labels) === "TSModule").map((n) => [n.props.name as string, n.props.source as string]),
    );
    let checked = 0;
    for (const n of rows.nodes) {
      const { code, start_byte: lo, end_byte: hi } = n.props as Record<string, unknown>;
      if (typeof code !== "string" || typeof lo !== "number" || typeof hi !== "number") continue;
      const src = srcOf.get(n.module ?? "");
      if (src === undefined) continue;
      // BYTE offsets (#179), so Buffer — String.slice is wrong the moment a multibyte char precedes
      // the span, which is exactly what the fixture's non-ASCII modules exercise.
      expect(Buffer.from(src, "utf8").subarray(lo, hi).toString("utf8"), `bad slice for ${n.value}`).toBe(code);
      checked++;
    }
    expect(checked, "no node carried both code and byte offsets").toBeGreaterThan(0);
  });

  test("the fixture actually contains multibyte text, so the slice check cannot pass by coincidence", () => {
    const multibyte = rows.nodes
      .filter((n) => specificLabel(n.labels) === "TSModule")
      .filter((n) => Buffer.byteLength(n.props.source as string, "utf8") > (n.props.source as string).length);
    expect(multibyte.length, "no fixture module has a non-ASCII character; char offsets would pass as bytes").toBeGreaterThan(0);
  });

  test("every label that declares a span emits all six of its properties", () => {
    const SPAN_KEYS = ["start_line", "end_line", "start_column", "end_column", "start_byte", "end_byte"] as const;
    const spanned = NODE_LABELS.filter((n) => SPAN_KEYS.every((k) => k in n.properties)).map((n) => n.label);
    expect(spanned.length).toBeGreaterThan(0);
    for (const label of spanned) {
      const emitted = rows.nodes.filter((n) => specificLabel(n.labels) === label && "start_line" in n.props);
      if (!emitted.length) continue; // the fixture need not exercise every label
      for (const key of SPAN_KEYS) {
        expect(emitted.some((n) => key in n.props), `${label} declares ${key} but never emits it`).toBe(true);
      }
    }
  });

  test("checked-in schema.neo4j.json matches the schema (run `bun gen:schema` if this fails)", () => {
    const onDisk = fs.readFileSync(path.resolve(import.meta.dir, "..", "schema.neo4j.json"), "utf8").trim();
    const fresh = JSON.stringify(buildSchemaDocument(), null, 2).trim();
    expect(onDisk).toBe(fresh);
  });

  test("2.0.0 does not advertise never-populated surfaces (issues #55/#60)", async () => {
    const doc = buildSchemaDocument();
    // #140: the two marker labels ARE populated — one per language namespace this analyzer emits.
    // Prove each is emitted by a real projection, so this stays a "no dead surface" check.
    expect([...doc.marker_labels]).toEqual(["TSCanNode", "JSCanNode"]);
    const projectOf = async (fixture: string) => {
      const o = { input: path.resolve(import.meta.dir, "fixtures", fixture), appName: "mk", analysisLevel: 1, eager: true,
                  noBuild: true, emit: "neo4j", entrypointRules: null } as unknown as AnalysisOptions;
      return project((await analyze(o)).application);
    };
    expect((await projectOf("sample-app")).nodes.some((n) => n.labels.includes("TSCanNode"))).toBe(true);
    expect((await projectOf("unresolvable-js-app")).nodes.some((n) => n.labels.includes("JSCanNode"))).toBe(true);
    const allProps = doc.node_labels.flatMap((n) => Object.keys(n.properties));
    for (const dead of ["framework", "detection_source", "route_path", "http_methods", "entrypoint_count", "accessed_symbols_json"]) {
      expect(allProps, `dead property still advertised: ${dead}`).not.toContain(dead);
    }
  });

  test("TS-prefixed labels/rels, with the artifact layer's sanctioned NEUTRAL exception (#66, #101)", () => {
    // :Artifact/:Package (+ HAS_ARTIFACT/DECLARES_DEPENDENCY/LOCKS) are deliberately
    // language-neutral so sibling analyzers MERGE onto the same nodes (python PR #160's rule);
    // edges that stay this analyzer's own claim (TS_PROVIDES, TS_UNRESOLVED_IMPORT) keep TS_.
    const NEUTRAL_LABELS = new Set(["Artifact", "Package", "ConfigKey"]);
    const NEUTRAL_RELS = new Set(["HAS_ARTIFACT", "DECLARES_DEPENDENCY", "LOCKS", "DEFINES_CONFIG"]);
    for (const node of rows.nodes) {
      for (const l of node.labels) {
        const ok = l === "CanNode" || l === "Application" || l.startsWith("TS") || NEUTRAL_LABELS.has(l);
        expect(ok, `bare label leaked: ${l}`).toBe(true);
      }
    }
    for (const edge of rows.edges) {
      expect(edge.type.startsWith("TS_") || NEUTRAL_RELS.has(edge.type), `bare rel leaked: ${edge.type}`).toBe(true);
    }
  });
});

// ---- :Application analyzer identity (issue #43) ------------------------------------------------
// The JSON envelope advertises `analyzer{name,version}` (#29); the Neo4j :Application node is the
// co-primary projection of the same envelope and must not diverge on analyzer identity.

// #118: the incremental push diffs each module's stored `content_hash` to find what changed. The
// field was stripped from the wire and never projected, so the diff compared against NULL forever
// and every push was a full re-upsert. schema.ts declared the property, bolt.ts read it, and
// project.ts never wrote it -- three parts of the system disagreeing. The old bolt test seeded the
// value by hand, so it exercised the diff against data the projection could not produce.
describe("module content_hash reaches the graph (#118)", () => {
  test("every projected :TSModule carries a non-null content_hash", () => {
    const modules = rows.nodes.filter((n) => n.labels.includes("TSModule"));
    expect(modules.length).toBeGreaterThan(0);
    for (const m of modules) {
      expect(m.props["content_hash"], `no content_hash on ${m.value}`).toBeDefined();
      expect(typeof m.props["content_hash"]).toBe("string");
    }
  });
});

describe(":Application node carries analyzer identity (issue #43)", () => {
  test("version matches package.json (the same source the JSON envelope's analyzer.version uses)", () => {
    const appNode = rows.nodes.find((n) => n.labels.includes("Application"));
    expect(appNode, "no :Application node projected").toBeDefined();
    expect(appNode!.props.analyzer_version).toBe(pkg.version);
    expect(appNode!.props.analyzer_name).toBe("codeanalyzer-typescript");
  });
});

// ---- Class inheritance: EXTENDS/IMPLEMENTS (issue #33) ------------------------------------------
// dataflow-app's src/hierarchy.ts is a minimal, first-party heritage fixture: `Rectangle implements
// Shape`, `Square extends Rectangle implements Labeled`, `ColoredShape extends Shape` (interface→
// interface heritage — issue #45).

describe("neo4j inheritance edges (issue #33)", () => {
  test("EXTENDS and IMPLEMENTS are declared in the schema catalog", () => {
    expect(relByType.has("TS_EXTENDS")).toBe(true);
    expect(relByType.has("TS_IMPLEMENTS")).toBe(true);
  });

  function nodeBySignature(signature: string) {
    return rows.nodes.find((n) => n.props.signature === signature);
  }

  test("hierarchy.ts's first-party heritage projects the expected, non-dangling EXTENDS/IMPLEMENTS edges", () => {
    const square = nodeBySignature("src/hierarchy.Square");
    const rectangle = nodeBySignature("src/hierarchy.Rectangle");
    const shape = nodeBySignature("src/hierarchy.Shape");
    const labeled = nodeBySignature("src/hierarchy.Labeled");
    expect(square, "Square node").toBeDefined();
    expect(rectangle, "Rectangle node").toBeDefined();
    expect(shape, "Shape node").toBeDefined();
    expect(labeled, "Labeled node").toBeDefined();

    const ext = rows.edges.filter((e) => e.type === "TS_EXTENDS");
    const impl = rows.edges.filter((e) => e.type === "TS_IMPLEMENTS");
    expect(ext.length).toBeGreaterThan(0);
    expect(impl.length).toBeGreaterThan(0);

    expect(ext.some((e) => e.from.value === square!.value && e.to.value === rectangle!.value)).toBe(true);
    expect(impl.some((e) => e.from.value === rectangle!.value && e.to.value === shape!.value)).toBe(true);
    expect(impl.some((e) => e.from.value === square!.value && e.to.value === labeled!.value)).toBe(true);

    const nodeValues = new Set(rows.nodes.map((n) => n.value));
    for (const e of [...ext, ...impl]) {
      expect(nodeValues.has(e.from.value), `dangling EXTENDS/IMPLEMENTS source ${e.from.value}`).toBe(true);
      expect(nodeValues.has(e.to.value), `dangling EXTENDS/IMPLEMENTS target ${e.to.value}`).toBe(true);
    }
  });

  test("interface-extends-interface projects an EXTENDS edge with an Interface source AND target (issue #45)", () => {
    const coloredShape = nodeBySignature("src/hierarchy.ColoredShape");
    const shape = nodeBySignature("src/hierarchy.Shape");
    expect(coloredShape, "ColoredShape node").toBeDefined();
    expect(shape, "Shape node").toBeDefined();
    expect(specificLabel(coloredShape!.labels)).toBe("TSInterface");
    expect(specificLabel(shape!.labels)).toBe("TSInterface");

    const ext = rows.edges.filter((e) => e.type === "TS_EXTENDS");
    expect(ext.some((e) => e.from.value === coloredShape!.value && e.to.value === shape!.value)).toBe(true);

    const nodeValues = new Set(rows.nodes.map((n) => n.value));
    expect(nodeValues.has(coloredShape!.value)).toBe(true);
    expect(nodeValues.has(shape!.value)).toBe(true);
  });
});

test("streamed Cypher snapshot matches the compatibility renderer byte for byte", () => {
  const application = rows.nodes.find((node) => node.labels.includes("TSApplication"));
  expect(application, "TSApplication row").toBeDefined();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-cypher-test-"));
  const output = path.join(dir, "graph.cypher");
  try {
    writeCypherFile(output, rows, application!.value);
    expect(fs.readFileSync(output, "utf8")).toBe(renderCypher(rows, application!.value));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
