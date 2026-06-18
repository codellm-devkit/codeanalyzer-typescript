#!/usr/bin/env node
/**
 * Multi-call binary entry. The compiled `cants` executable bundles BOTH the analyzer and the
 * `@cs-au-dk/jelly` CLI; this dispatcher picks which one runs based on argv:
 *
 *   cants __jelly <jelly args...>   -> run the embedded Jelly CLI (used internally by jellyProvider)
 *   cants <analyzer args...>        -> run the normal analyzer
 *
 * Both programs self-execute on import (analyzer's main() / Jelly's program.parse()), so dispatch is
 * "reshape argv, then dynamically import the right module". Bun's --compile bundles both branches.
 * The CANTS_SELF_JELLY marker tells jellyProvider it can re-exec THIS binary for Jelly instead of
 * shelling out to `node`; it is intentionally unset in source/dev runs (where the dispatcher is
 * bypassed and the provider falls back to `node @cs-au-dk/jelly/lib/main.js`).
 */
export {}; // mark as a module so top-level await is permitted

const argv = process.argv;
if (argv[2] === "__jelly") {
  // Jelly's commander reads process.argv as [node, script, ...args]; drop our "__jelly" sentinel.
  process.argv = [argv[0], "jelly", ...argv.slice(3)];
  // @ts-ignore — @cs-au-dk/jelly ships no type declarations for the lib subpath
  await import("@cs-au-dk/jelly/lib/main.js");
} else {
  process.env.CANTS_SELF_JELLY = process.execPath;
  await import("./index");
}
