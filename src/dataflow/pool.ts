/**
 * A minimal fixed-size worker pool over Bun's Worker (one in-flight task per worker, FIFO
 * queue). Used by the level-3 pipeline for the stage-1–4 extraction fan-out and the SCC
 * wavefront. Construction or task failure is surfaced to the caller, which falls back to the
 * sequential (--jobs 1) path — parallelism is an optimization, never a correctness dependency.
 *
 * Failure discipline: a worker that errors is retired (never re-idled), and when the last live
 * worker dies every queued task is rejected — a task must never sit in the queue with nothing
 * left to run it, or the awaiting pipeline would dangle unresolved and the process could exit
 * without emitting output.
 */

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * The worker entry URL differs between dev and the compiled binary. Dev/test runs load the
 * TypeScript source relative to this module. `bun build --compile` embeds the extra entrypoint
 * under its BUILT name and its path relative to the entries' common root (src/) inside the
 * `$bunfs` virtual filesystem — `src/dataflow/worker.ts` → `/$bunfs/root/dataflow/worker.js`,
 * while `import.meta.url` here is the bundled main (`/$bunfs/root/<binary>`). Coupled to the
 * `build` script's entry list in package.json; a mismatch degrades to the sequential path via
 * the pool's failure fallback (with a warning), never to wrong output.
 */
function workerUrl(): string {
  const compiled = import.meta.url.includes("$bunfs");
  return new URL(compiled ? "./dataflow/worker.js" : "./worker.ts", import.meta.url).href;
}

export class WorkerPool {
  private workers = new Set<Worker>();
  private idle: Worker[] = [];
  private pending = new Map<Worker, Pending>();
  private queue: Array<{ msg: unknown; p: Pending }> = [];
  private closed = false;

  constructor(size: number) {
    const url = workerUrl();
    for (let i = 0; i < size; i++) {
      const w = new Worker(url);
      w.onmessage = (ev: MessageEvent) => this.settle(w, ev.data as { ok: boolean; result?: unknown; error?: string });
      w.onerror = (ev: ErrorEvent) => this.retire(w, new Error(`worker error: ${ev.message ?? "unknown"}`));
      this.workers.add(w);
      this.idle.push(w);
    }
  }

  get size(): number {
    return this.workers.size;
  }

  exec<T>(msg: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("worker pool is closed"));
    if (this.workers.size === 0) return Promise.reject(new Error("worker pool has no live workers"));
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve: resolve as (v: unknown) => void, reject };
      const w = this.idle.pop();
      if (w) this.dispatch(w, msg, p);
      else this.queue.push({ msg, p });
    });
  }

  close(): void {
    this.closed = true;
    this.rejectQueue(new Error("worker pool closed"));
    for (const w of this.workers) w.terminate();
    this.workers.clear();
    this.idle = [];
  }

  private dispatch(w: Worker, msg: unknown, p: Pending): void {
    this.pending.set(w, p);
    w.postMessage(msg);
  }

  private settle(w: Worker, reply: { ok: boolean; result?: unknown; error?: string }): void {
    const p = this.pending.get(w);
    this.pending.delete(w);
    const next = this.queue.shift();
    if (next) this.dispatch(w, next.msg, next.p);
    else this.idle.push(w);
    if (!p) return;
    if (reply.ok) p.resolve(reply.result);
    else p.reject(new Error(reply.error ?? "worker task failed"));
  }

  /** A worker died: fail its task, drop it from the pool, and never strand the queue. */
  private retire(w: Worker, err: Error): void {
    const p = this.pending.get(w);
    this.pending.delete(w);
    this.workers.delete(w);
    this.idle = this.idle.filter((x) => x !== w);
    w.terminate();
    p?.reject(err);
    if (this.workers.size === 0) this.rejectQueue(err);
  }

  private rejectQueue(err: Error): void {
    for (const q of this.queue) q.p.reject(err);
    this.queue = [];
  }
}
