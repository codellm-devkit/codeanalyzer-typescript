/**
 * phase memory log, enabled with CANTS_MEMLOG=1 (CANTS_MEMLOG=gc forces a full
 * collection first, so the number is retained heap rather than garbage). Off by default: no cost.
 */
export function memlog(phase: string): void {
  const mode = process.env.CANTS_MEMLOG;
  if (!mode) return;
  if (mode === "gc") Bun.gc(true);
  const m = process.memoryUsage();
  const gb = (n: number): string => (n / 2 ** 30).toFixed(2);
  process.stderr.write(`[codeanalyzer-ts] mem ${phase}: rss=${gb(m.rss)}G heapTotal=${gb(m.heapTotal)}G heapUsed=${gb(m.heapUsed)}G\n`);
}
