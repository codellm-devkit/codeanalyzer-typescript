import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { methodsOf, routeFromFileKey } from "../src/entrypoints/matching";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication, TSEntrypoint } from "../src/schema";
import { forEachCallable } from "../src/schema";

function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-ep206-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020" }, include: ["**/*.ts", "**/*.tsx"] }));
  return dir;
}
const opts = (input: string) => ({ input, appName: "f", analysisLevel: 1, eager: true, noBuild: true, emit: "json", graphs: ["cfg", "dfg", "pdg", "sdg"],
  graphFieldDepth: 3, jobs: 1, skipTests: true, phantoms: true, entrypointRules: null }) as unknown as AnalysisOptions;
const rootOf = (r: { application: unknown }) => (r.application as { application: TSApplication }).application;

/** `<fileKey>:<callable name>` → its entrypoint records. */
async function entrypointsOf(dir: string): Promise<{ eps: Record<string, TSEntrypoint[]>; root: TSApplication }> {
  const root = rootOf(await analyze(opts(dir)));
  const eps: Record<string, TSEntrypoint[]> = {};
  for (const [key, m] of Object.entries(root.symbol_table)) forEachCallable(m, (c) => { eps[`${key}:${c.name}`] = c.entrypoints ?? []; });
  return { eps, root };
}

describe("Remix / React Router v7 route modules (#206)", () => {
  test("`loader`, `action` and the route component each get their own rule id", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "x", dependencies: { "@remix-run/node": "^2.8.0" } }),
      "app/routes/users.ts": "export async function loader() { return []; }\nexport async function action() { return {}; }\nexport default function UsersRoute() {}\nfunction helper(): void {}",
      "src/elsewhere.ts": "export async function loader() { return []; }",
    });
    const { eps, root } = await entrypointsOf(dir);
    expect(eps["app/routes/users.ts:loader"]?.[0]).toMatchObject({
      framework: "remix", rule: "remix.loader", confidence: "certain", evidence: "app/routes/users.ts", route: "/users", http_methods: [],
    });
    expect(eps["app/routes/users.ts:action"]?.[0]).toMatchObject({ rule: "remix.action", route: "/users" });
    expect(eps["app/routes/users.ts:UsersRoute"]?.[0]).toMatchObject({ rule: "remix.route-component", route: "/users" });
    expect(eps["app/routes/users.ts:helper"]).toEqual([]);
    expect(eps["src/elsewhere.ts:loader"]).toEqual([]); // outside the convention path
    expect(root.entrypoint_report.frameworks_detected).toEqual(["remix"]);
  });

  test("detects on react-router alone (v7 absorbed Remix)", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "x", dependencies: { "react-router": "^7.0.0" } }),
      "app/routes/home.ts": "export async function loader() { return []; }",
    });
    const { eps } = await entrypointsOf(dir);
    expect(eps["app/routes/home.ts:loader"]?.[0]).toMatchObject({ framework: "remix", rule: "remix.loader", route: "/home" });
  });
});

describe("Astro API routes (#206)", () => {
  test("verb exports carry their method; `ALL` is not an HTTP method so it carries none", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "x", dependencies: { astro: "^4.5.0" } }),
      "src/pages/api/items.ts": "export function GET() {}\nexport function POST() {}\nexport function ALL() {}\nfunction helper(): void {}",
    });
    const { eps, root } = await entrypointsOf(dir);
    expect(eps["src/pages/api/items.ts:GET"]?.[0]).toMatchObject({
      framework: "astro", rule: "astro.api-route", confidence: "certain", route: "/api/items", http_methods: ["GET"],
    });
    expect(eps["src/pages/api/items.ts:POST"]?.[0]).toMatchObject({ http_methods: ["POST"] });
    expect(eps["src/pages/api/items.ts:ALL"]?.[0]).toMatchObject({ rule: "astro.api-route", http_methods: [] });
    expect(eps["src/pages/api/items.ts:helper"]).toEqual([]);
    expect(root.entrypoint_report.frameworks_detected).toEqual(["astro"]);
  });
});

describe("Next.js `src/` layout (#206)", () => {
  test("src/app/**/route.ts and src/pages/api/** match, and the route drops the `src/` prefix", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "x", dependencies: { next: "^14.0.0" } }),
      "src/app/users/route.ts": "export async function GET(): Promise<void> {}",
      "src/pages/api/hello.ts": "export default function handler(): void {}",
    });
    const { eps } = await entrypointsOf(dir);
    expect(eps["src/app/users/route.ts:GET"]?.[0]).toMatchObject({
      framework: "nextjs", rule: "nextjs.app-route-src", route: "/users", http_methods: ["GET"],
    });
    expect(eps["src/pages/api/hello.ts:handler"]?.[0]).toMatchObject({ rule: "nextjs.pages-api-src", route: "/api/hello" });
  });

  test("routeFromFileKey strips a leading `src/` from the glob's literal prefix only", () => {
    expect(routeFromFileKey("src/app/users/route.ts", "src/app/**/route.{ts,tsx,js,mjs}")).toBe("/users");
    expect(routeFromFileKey("src/app/route.ts", "src/app/**/route.{ts,tsx,js,mjs}")).toBe("/");
    expect(routeFromFileKey("src/pages/api/hello.ts", "src/pages/api/**/*.{ts,tsx,js,mjs}")).toBe("/api/hello");
    expect(routeFromFileKey("src/pages/api/items.ts", "src/pages/**/*.{ts,js}")).toBe("/api/items");
    // Unchanged: no literal prefix means the whole key is the route (#161).
    expect(routeFromFileKey("src/routes/x/+server.ts", "**/+server.{ts,js}")).toBe("/src/routes/x");
  });
});

describe("handler and default-export resolution gaps (#206)", () => {
  test("a NAMED function expression handler resolves, and stops being counted unresolved", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "x", dependencies: { express: "^4.19.0" } }),
      "src/server.ts": [
        'import express from "express";',
        "const app = express();",
        'app.get("/named", function namedFnExpr(req: any, res: any) { res.json(1); });',
        'app.get("/arrow", (req: any, res: any) => { res.json(2); });',
      ].join("\n"),
    });
    const { eps, root } = await entrypointsOf(dir);
    expect(eps["src/server.ts:namedFnExpr"]?.[0]).toMatchObject({
      framework: "heuristic", rule: "heuristic.http-verb-call", route: "/named", http_methods: ["GET"],
    });
    expect(eps["src/server.ts:(anonymous)"]?.[0]).toMatchObject({ route: "/arrow" });
    expect(root.entrypoint_report.unresolved["app.get"]).toBeUndefined();
  });

  test("a nested callable inside the handler is not mistaken for the handler", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "x", dependencies: { express: "^4.19.0" } }),
      "src/nested.ts": [
        'import express from "express";',
        "const app = express();",
        'app.post("/outer", function outerHandler(req: any, res: any) {',
        "  const inner = function innerFn() { return 1; };",
        "  res.json(inner());",
        "});",
      ].join("\n"),
    });
    const { eps } = await entrypointsOf(dir);
    expect(eps["src/nested.ts:outerHandler"]?.[0]).toMatchObject({ route: "/outer", http_methods: ["POST"] });
    expect(eps["src/nested.ts:innerFn"] ?? []).toEqual([]);
  });

  test("`export default defineEventHandler(handler)` resolves the wrapped callable (Nitro/Nuxt shape)", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "x", dependencies: { next: "^14.0.0" } }),
      "pages/api/wrapped.ts": [
        "declare function withMiddleware(h: (req: any, res: any) => any): any;",
        "export default withMiddleware(async (req: any, res: any) => { res.json(1); });",
      ].join("\n"),
    });
    const { eps, root } = await entrypointsOf(dir);
    const recs = Object.entries(eps).filter(([k, v]) => k.startsWith("pages/api/wrapped.ts") && v.length);
    expect(recs.length, `no entrypoint resolved for the wrapped default export: ${JSON.stringify(Object.keys(eps))}`).toBe(1);
    expect(recs[0]![1][0]).toMatchObject({ framework: "nextjs", rule: "nextjs.pages-api", route: "/api/wrapped" });
    expect(root.entrypoint_report.unresolved["pages/api/wrapped.ts#default"]).toBeUndefined();
  });

  test("a wrapper whose handler is not a direct argument stays unresolved rather than guessing", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "x", dependencies: { next: "^14.0.0" } }),
      "pages/api/opts.ts": [
        "declare function defineHandler(o: { onRequest: (e: any) => any }): any;",
        "export default defineHandler({ onRequest: (event: any) => 1 });",
      ].join("\n"),
    });
    const { root } = await entrypointsOf(dir);
    expect(root.entrypoint_report.unresolved["pages/api/opts.ts#default"]).toBe(1);
  });

  test("methodsOf(export_name) filters through the HTTP verb set", () => {
    expect(methodsOf([], {}, { from: "export_name" }, "GET")).toEqual(["GET"]);
    expect(methodsOf([], {}, { from: "export_name" }, "options")).toEqual(["OPTIONS"]);
    expect(methodsOf([], {}, { from: "export_name" }, "ALL")).toEqual([]);
    expect(methodsOf([], {}, { from: "export_name" }, "loader")).toEqual([]);
  });
});

describe("all three frameworks in one project (#206)", () => {
  test("frameworks_detected is exactly the three, and each rule claims only its own files", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "x", dependencies: { next: "^14.0.0", astro: "^4.5.0", "@remix-run/node": "^2.8.0" } }),
      "app/routes/a.ts": "export async function loader() { return []; }",
      "src/pages/api/b.ts": "export function GET() {}\nexport default function page() {}",
      "src/app/c/route.ts": "export async function POST(): Promise<void> {}",
    });
    const { eps, root } = await entrypointsOf(dir);
    expect(root.entrypoint_report.frameworks_detected).toEqual(["astro", "nextjs", "remix"]);
    expect(eps["app/routes/a.ts:loader"]?.map((e) => e.rule)).toEqual(["remix.loader"]);
    expect(eps["src/app/c/route.ts:POST"]?.map((e) => e.rule)).toEqual(["nextjs.app-route-src"]);
    // `src/pages/api/b.ts` sits under BOTH astro's `src/pages/**` and nextjs' `src/pages/api/**`,
    // and both frameworks are detected — but the two rules disagree on the EXPORT, so a verb export
    // is astro's alone. That is the file tier's real discriminator: the glob narrows the candidates,
    // the `exports:` list decides. A `default` export in the same file would be nextjs' alone.
    expect(eps["src/pages/api/b.ts:GET"]?.map((e) => e.rule)).toEqual(["astro.api-route"]);
    expect(eps["src/pages/api/b.ts:page"]?.map((e) => e.rule)).toEqual(["nextjs.pages-api-src"]);
  });
});
