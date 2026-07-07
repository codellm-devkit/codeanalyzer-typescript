/**
 * Source → sink pair (one raw, one sanitized). The taint client is a staged follow-up
 * (issue #2 PR E); the fixture carries the flows now so that PR only adds the query.
 */

export function source(): string {
  return "user-input";
}

export function sanitize(s: string): string {
  return s.replace(/dangerous/g, "");
}

export function sink(s: string): void {
  void s;
}

export function unsafeFlow(): void {
  const s = source();
  sink(s);
}

export function safeFlow(): void {
  const s = sanitize(source());
  sink(s);
}
