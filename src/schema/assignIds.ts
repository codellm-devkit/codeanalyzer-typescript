/**
 * Walk the symbol-table tree and stamp every node with its `can://` id — python's
 * `assign_ids.py`. Runs once per analysis run (ids embed the per-invocation app name, so the
 * cached tree is stored id-free and re-stamped on every run; stamping is overwrite-idempotent).
 *
 * Returns the `signature → id` map the later passes join on (callee backfill, call-graph
 * re-identification, dataflow attach), the callable locator for the L3/L4 attach, and the
 * id-uniqueness gate's collision list.
 */

import { applicationIdOf, artifactIdOf, configKeyIdOf, idFromSig, memberKey, moduleIdOf, modulePrefixOf } from "./ids";
import type { AnalysisInternal, TSCallable, TSField, TSType } from "./schema";

export interface AssignedIds {
  appId: string;
  idBySig: Map<string, string>; // signature → can:// id (types + callables)
  callableBySig: Map<string, TSCallable>; // locates each callable's node for the L3/L4 attach
  collisions: string[]; // signatures that mapped to two distinct ids (L1 id-uniqueness gate)
}

export function assignIds(app: AnalysisInternal, appName: string): AssignedIds {
  const appId = applicationIdOf(appName);
  const idBySig = new Map<string, string>();
  const callableBySig = new Map<string, TSCallable>();
  const collisions: string[] = [];

  const register = (sig: string, id: string): void => {
    if (idBySig.has(sig) && idBySig.get(sig) !== id) collisions.push(sig);
    idBySig.set(sig, id);
  };

  const doFields = (parentId: string, fields: Record<string, TSField> | undefined): void => {
    for (const [name, f] of Object.entries(fields ?? {})) f.id = `${parentId}/${name}`;
  };

  const doCallable = (moduleId: string, modulePrefix: string, c: TSCallable): void => {
    c.id = idFromSig(moduleId, modulePrefix, c.signature);
    register(c.signature, c.id);
    callableBySig.set(c.signature, c);
    for (const nested of Object.values(c.callables ?? {})) doCallable(moduleId, modulePrefix, nested);
    for (const t of Object.values(c.types ?? {})) doType(moduleId, modulePrefix, t);
  };

  const doType = (moduleId: string, modulePrefix: string, t: TSType): void => {
    t.id = idFromSig(moduleId, modulePrefix, t.signature);
    register(t.signature, t.id);
    doFields(t.id, t.fields);
    for (const m of Object.values(t.callables ?? {})) doCallable(moduleId, modulePrefix, m);
    for (const f of Object.values(t.functions ?? {})) doCallable(moduleId, modulePrefix, f); // namespace
    for (const nt of Object.values(t.types ?? {})) doType(moduleId, modulePrefix, nt); // namespace
  };

  for (const [fileKey, mod] of Object.entries(app.symbol_table)) {
    const moduleId = moduleIdOf(appName, fileKey);
    const modulePrefix = modulePrefixOf(fileKey);
    mod.id = moduleId;
    // Module-scope execution is a call-graph SOURCE (python #131 parity: a call in module scope
    // is attributed to the MODULE). The prefix is the module's "signature", so those edges
    // re-identify onto the module node's id instead of dangling.
    register(modulePrefix, moduleId);
    doFields(moduleId, mod.fields);
    for (const fn of Object.values(mod.functions ?? {})) doCallable(moduleId, modulePrefix, fn);
    for (const t of Object.values(mod.types ?? {})) doType(moduleId, modulePrefix, t);
  }

  // Repository-artifact layer: same per-run rule (ids embed --app-name). Artifact ids are
  // language-NEUTRAL (`can://artifact/...`); dependency/import records are flat evidence rows
  // with no node id of their own (the graph's :Package node is purl-keyed).
  for (const [relPath, art] of Object.entries(app.artifacts ?? {})) {
    art.id = artifactIdOf(appName, relPath);
    // Deployment-env id disambiguation (#101 unit D fix round 1, python v1.3.0 parity verbatim):
    // the `key` FIELD always stays the bare variable name — env-namespace resolution still joins
    // on a plain `key ===` match — but a bare name can collide across mints on the SAME artifact
    // (Dockerfile: `ARG VERSION` + `ENV VERSION=$VERSION`; yaml: a top-level `PAYMENT_HOST:` leaf
    // vs. the `env` dual-mint from `services.web.environment.PAYMENT_HOST`), so only the ID gets
    // an internal prefix: `arg.` for a dockerfile-namespace (ARG) mint, `env.` for a yaml
    // artifact's env dual-mint. Dockerfile's own ENV mint and every ordinary structural key stay
    // unprefixed.
    for (const ck of art.config_keys) {
      let idKey = ck.key;
      if (ck.namespace === "dockerfile") idKey = `arg.${ck.key}`;
      else if (art.format === "yaml" && ck.namespace === "env") idKey = `env.${ck.key}`;
      ck.id = configKeyIdOf(art.id, idKey);
    }
  }
  for (const dep of app.dependencies ?? []) {
    const artPath = dep.declared_in; // scanners record the REL PATH; re-stamp onto the id
    dep.declared_in = artifactIdOf(appName, artPath.startsWith("can://") ? artPath.split("/").slice(4).join("/") : artPath);
  }

  return { appId, idBySig, callableBySig, collisions };
}
