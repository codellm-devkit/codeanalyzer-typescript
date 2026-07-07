/** Module-level global state: written in one function, read in another. */

export let counter = 0;

export function bump(by: number): void {
  counter = counter + by; // global write
}

export function readCounter(): number {
  return counter; // global read that flows to the return value
}

export function churn(by: number): number {
  bump(by); // transitive global write lands on this callsite node
  return readCounter(); // transitive global read
}
