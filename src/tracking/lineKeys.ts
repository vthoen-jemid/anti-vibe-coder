/**
 * Stable line identity.
 *
 * Review progress is attached to the *content* of a line rather than to its
 * line number. A line that merely moves (because code was inserted above it)
 * keeps its key and therefore its colour. A line whose content changes gets a
 * new key and therefore starts as "unseen" again.
 *
 * Key = hash(trimmed text) + '#' + n, where n is how many times that exact
 * trimmed text already occurred earlier in the file (so duplicate lines such
 * as `}` get distinct keys).
 */

/** Split text into lines the same way VS Code numbers them. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** cyrb53: fast, well-distributed 53-bit string hash. */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function computeLineKeys(lines: readonly string[]): string[] {
  const seen = new Map<string, number>();
  const keys: string[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const h = hashString(lines[i].trim());
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    keys[i] = n === 0 ? h : `${h}#${n}`;
  }
  return keys;
}
