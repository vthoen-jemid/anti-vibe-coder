import { diffArrays } from 'diff';
import { splitLines } from './lineKeys';

/**
 * Returns, for every line of `currentLines`, whether it is new compared to the
 * base version (added or modified on this branch). `baseText === null` means
 * the file does not exist on the base: every line is new.
 */
export function computeNewLines(
  baseText: string | null,
  currentLines: readonly string[],
  ignoreWhitespaceOnly: boolean,
): Uint8Array {
  const isNew = new Uint8Array(currentLines.length);

  if (baseText === null) {
    isNew.fill(1);
  } else {
    // Compare without trailing CR so CRLF/LF differences (autocrlf) don't
    // make every line look changed.
    const base = splitLines(baseText).map(stripCr);
    const cur = currentLines.map(stripCr);
    const parts = diffArrays(base, cur);
    let idx = 0;
    for (const part of parts) {
      const count = part.value.length;
      if (part.removed) {
        continue;
      }
      if (part.added) {
        isNew.fill(1, idx, idx + count);
      }
      idx += count;
    }
  }

  if (ignoreWhitespaceOnly) {
    for (let i = 0; i < currentLines.length; i++) {
      if (isNew[i] && currentLines[i].trim() === '') {
        isNew[i] = 0;
      }
    }
  }
  return isNew;
}

function stripCr(s: string): string {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}
