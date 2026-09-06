import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze } from "../src/core";
import { globToRegExp, routeFromFileKey } from "../src/entrypoints/matching";
import type { AnalysisOptions } from "../src/options";
import type { TSApplication } from "../src/schema";
import { forEachCallable } from "../src/schema";

function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cants-epf-"));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020" }, include: ["**/*.ts"] }));
  return dir;
}
const opts = (input: string) => ({ input, appName: "f", analysisLevel: 1, eager: true, noBuild: true, emit: "json", graphs: ["cfg","dfg","pdg","sdg"],
  graphFieldDepth: 3, jobs: 1, skipTests: true, phantoms: true, entrypointRules: null }) as unknown as AnalysisOptions;
const rootOf = (r: { application: unknown }) => (r.application as { application: TSApplication }).application;

describe("file-convention matcher", () => {
  test("globToRegExp", () => {
    expect(globToRegExp("app/**/route.{ts,js}").test("app/users/[id]/route.ts")).toBe(true);
    expect(globToRegExp("app/**/route.{ts,js}").test("app/route.ts")).toBe(true);
    expect(globToRegExp("app/**/route.{ts,js}").test("src/app/route.ts")).toBe(false);
    expect(globToRegExp("**/+server.ts").test("src/routes/x/+server.ts")).toBe(true);
    expect(globToRegExp("pages/api/*.ts").test("pages/api/a/b.ts")).toBe(false);
  });

  test("routeFromFileKey: strips the glob's literal `app/`/`pages/` prefix and a trailing route/+server segment", () => {
    expect(routeFromFileKey("app/users/route.ts", "app/**/route.{ts,tsx,js,mjs}")).toBe("/users");
    expect(routeFromFileKey("app/route.ts", "app/**/route.{ts,tsx,js,mjs}")).toBe("/");
    expect(routeFromFileKey("pages/api/hello.ts", "pages/api/**/*.{ts,tsx,js,mjs}")).toBe("/api/hello");
    expect(routeFromFileKey("src/routes/x/+server.ts", "**/+server.{ts,js}")).toBe("/src/routes/x");
  });

  test("Next.js app router: exported verb functions are entrypoints, gated on the `next` dependency", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({ name: "x", dependencies: { next: "^14.0.0" } }),
      "app/users/route.ts": "export async function GET(): Promise<void> {}\nexport function POST(): void {}\nfunction helper(): void {}",
      "pages/api/hello.ts": "export default function handler(): void {}\nexport function notDefault(): void {}",
      "src/other.ts": "export function GET(): void {}",
    });
    const root = rootOf(await analyze(opts(dir)));
    const eps: Record<string, unknown[]> = {};
    for (const [key, m] of Object.entries(root.symbol_table)) forEachCallable(m, (c) => { eps[`${key}:${c.name}`] = c.entrypoints ?? []; });
    expect(eps["app/users/route.ts:GET"]?.[0]).toMatchObject({ framework: "nextjs", rule: "nextjs.app-route", confidence: "certain", evidence: "app/users/route.ts", route: "/users", http_methods: ["GET"] });
    expect(eps["app/users/route.ts:POST"]?.[0]).toMatchObject({ http_methods: ["POST"] });
    expect(eps["app/users/route.ts:helper"]).toEqual([]);
    expect(eps["pages/api/hello.ts:handler"]?.[0]).toMatchObject({ rule: "nextjs.pages-api", route: "/api/hello" });
    expect(eps["pages/api/hello.ts:notDefault"]).toEqual([]);
    expect(eps["src/other.ts:GET"]).toEqual([]); // not under the convention path
    expect(root.entrypoint_report.frameworks_detected).toEqual(["nextjs"]);
  });

  test("without the dependency, the same files register nothing", async () => {
    const dir = fixture({ "app/users/route.ts": "export function GET(): void {}" });
    const root = rootOf(await analyze(opts(dir)));
    for (const m of Object.values(root.symbol_table)) forEachCallable(m, (c) => { expect(c.entrypoints ?? []).toEqual([]); });
  });
});
