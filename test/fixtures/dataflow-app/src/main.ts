/** Multi-file flow: state and chain wired together (cross-module SDG edges). */
import { a } from "./chain";
import { bump, readCounter } from "./state";

export function main(): number {
  bump(3);
  const r = a(readCounter());
  return r;
}
