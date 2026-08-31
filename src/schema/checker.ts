/**
 * Guarded access to tsc's checker.
 *
 * ts-morph's symbol queries run the TypeScript checker, and the checker THROWS on some nodes it
 * cannot resolve instead of returning undefined. The reproducible case: a `.js` file that no
 * tsconfig `include` covers is still discovered as source, so it lands in a program with no
 * default lib — and resolving an ordinary global there (`throw new Error(...)`) dies inside
 * `getSymbolOfDeclaration`. Observed on vscode, where one such mock
 * (`extensions/microsoft-authentication/packageMocks/dpapi/dpapi.js`) aborted the entire
 * 9,351-module analysis at every level above 1.
 *
 * Every caller already has an unresolved path — a call site whose callee will not resolve simply
 * contributes no edge — so degrading a throw to `undefined` costs the edges at that one node and
 * nothing else. Unguarded, it costs the whole run.
 *
 * The failures are counted, not swallowed silently: `analyze()` reports the total, because
 * "some edges are missing" must never be indistinguishable from "there were no edges".
 */
import type { Node, Symbol as TsSymbol } from "ts-morph";

let failures = 0;

/** `node.getSymbol()`, returning undefined where the checker throws. */
export function symbolAt(node: Node): TsSymbol | undefined {
  try {
    return node.getSymbol();
  } catch {
    failures++;
    return undefined;
  }
}

/** `symbol.getAliasedSymbol()`, returning undefined where the checker throws. */
export function aliasedSymbolOf(symbol: TsSymbol): TsSymbol | undefined {
  try {
    return symbol.getAliasedSymbol();
  } catch {
    failures++;
    return undefined;
  }
}

/** How many checker calls have thrown since the last reset. */
export function checkerFailures(): number {
  return failures;
}

/** Per-run reset — the count is reported per analysis, and one process may run several. */
export function resetCheckerFailures(): void {
  failures = 0;
}
