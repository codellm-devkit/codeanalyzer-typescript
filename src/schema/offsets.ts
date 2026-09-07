/**
 * Char ↔ UTF-8 byte offset conversion for one source text (#179).
 *
 * `span.bytes` is a UTF-8 BYTE range into the owning module's `source` — the canonical keystone's
 * meaning and codeanalyzer-python's (`byte_offsets`), so one slicing rule holds across languages:
 * `Buffer.from(source, "utf8").subarray(lo, hi)`. ts-morph and the yaml parser position nodes in
 * UTF-16 code units, so every producer converts on the way out and every consumer that needs a
 * compiler position converts on the way back in. Both directions go through here.
 *
 * ASCII fast path: when the text's byte length equals its char length, every offset is its own
 * byte offset and no table is built. Otherwise a cumulative table (one entry per char) is built
 * once per text and cached on the object that owns it (a SourceFile, a TSModule, an artifact) —
 * strings cannot key a WeakMap, so the caller hands in the owner.
 */

export interface OffsetMap {
  toByte(charPos: number): number;
  toChar(bytePos: number): number;
}

const IDENTITY: OffsetMap = { toByte: (c) => c, toChar: (b) => b };

export function offsetMapOf(source: string): OffsetMap {
  if (Buffer.byteLength(source, "utf8") === source.length) return IDENTITY;
  // byteAt[i] = byte offset of char i; byteAt[n] = total byte length. Surrogate pairs: both code
  // units map to the pair's START and the pair advances 4 bytes — ts-morph never points between
  // the two, and a byte inside the pair maps back to its high surrogate.
  const n = source.length;
  const byteAt = new Uint32Array(n + 1);
  let b = 0;
  for (let i = 0; i < n; i++) {
    byteAt[i] = b;
    const cu = source.charCodeAt(i);
    if (cu < 0x80) b += 1;
    else if (cu < 0x800) b += 2;
    else if (cu >= 0xd800 && cu <= 0xdbff && i + 1 < n) { byteAt[i + 1] = b; b += 4; i++; }
    else b += 3;
  }
  byteAt[n] = b;
  return {
    toByte: (c) => byteAt[Math.min(Math.max(c, 0), n)] as number,
    toChar: (bytePos) => {
      // binary search for the first char whose byte offset >= bytePos
      let lo = 0, hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((byteAt[mid] as number) < bytePos) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
  };
}

/** Per-owner cache: the same text is mapped once per run. */
const cache = new WeakMap<object, OffsetMap>();
export function offsetMapFor(owner: object, source: string): OffsetMap {
  let m = cache.get(owner);
  if (!m) cache.set(owner, (m = offsetMapOf(source)));
  return m;
}

/** The node's text — the one slicing rule every consumer of `span.bytes` uses. */
export function sliceBytes(source: string, bytes: [number, number]): string {
  return Buffer.from(source, "utf8").subarray(bytes[0], bytes[1]).toString("utf8");
}
