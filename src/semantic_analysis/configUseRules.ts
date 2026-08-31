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
