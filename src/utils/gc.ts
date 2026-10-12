/**
 * an explicit full collection at phase boundaries. The collector lets the heap grow
 * to roughly twice its live size before collecting, and this process holds a whole compiler program,
 * so that slack is gigabytes; each phase here leaves most of what it allocated as garbage. No effect
 * on output. (JavaScriptCore's own `gcMaxHeapSize` option — BUN_JSC_gcMaxHeapSize — pins the heap
 * further on a small machine.)
 */
export function collectGarbage(): void {
  const bun = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun;
  if (bun?.gc) bun.gc(true);
}
