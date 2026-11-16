import { diffArrays } from 'diff';
import { splitLines } from './lineKeys';

/**
 * Myers work budget for one attempt, in "cells": range length × the maximum
 * edit length explored. Small on purpose: a range that needs more is split on
 * anchors instead, which is much cheaper than a long Myers run.
 */
const MYERS_BUDGET = 400_000;
/**
 * Total Myers work allowed per call. Once spent, ranges go straight to
 * anchors / the chunked fallback, so failed attempts can't add up.
 */
const TOTAL_MYERS_BUDGET = 8_000_000;
/** Hard wall-clock cap for one Myers run, as a safety net on top of the budget. */
const MYERS_TIMEOUT_MS = 100;
/** Fallback: lines per chunk (current side) for chunked Myers. */
const CHUNK = 128;

/**
 * Returns, for every line of `currentLines`, whether it is new compared to the
 * base version (added or modified on this branch).
 *
 * `base` is the file at the merge-base, as text or as lines; `null` means the
 * file does not exist on the base, so every line is new.
 *
 * Lines are compared without a trailing CR, so CRLF/LF differences (autocrlf)
 * don't make every line look changed.
 *
 * Algorithm (see docs/decisions/0012-fast-line-diff.md): the common prefix and
 * suffix are matched on the raw strings, the rest is interned to integers.
 * Each range is first tried with a budgeted Myers diff (optimal when it fits);
 * a range too expensive for that is split on anchors, lines unique on both
 * sides (longest increasing subsequence, as in patience diff), and the gaps
 * are solved the same way. A range without anchors whose Myers attempt fails
 * falls back to Myers on small consecutive chunks.
 *
 * The result is always a valid in-order common subsequence: optimal for
 * typical edits, close to it for large rewrites, and never quadratic.
 */
export function computeNewLines(
  base: string | readonly string[] | null,
  currentLines: readonly string[],
  ignoreWhitespaceOnly: boolean,
): Uint8Array {
  const isNew = new Uint8Array(currentLines.length);
  isNew.fill(1);

  if (base !== null) {
    const baseLines = typeof base === 'string' ? splitLines(base) : base;
    // Common prefix/suffix first, on the raw strings: the typical case (a few
    // edits in a big file) then never pays for interning the whole file.
    const n = baseLines.length;
    const m = currentLines.length;
    let pre = 0;
    while (pre < n && pre < m && sameLine(baseLines[pre], currentLines[pre])) {
      pre++;
    }
    let suf = 0;
    while (suf < n - pre && suf < m - pre && sameLine(baseLines[n - 1 - suf], currentLines[m - 1 - suf])) {
      suf++;
    }
    isNew.fill(0, 0, pre);
    isNew.fill(0, m - suf, m);

    const ids = new Map<string, number>();
    const intern = (s: string): number => {
      const k = stripCr(s);
      let id = ids.get(k);
      if (id === undefined) {
        id = ids.size;
        ids.set(k, id);
      }
      return id;
    };
    const a = Int32Array.from(baseLines.slice(pre, n - suf), intern);
    const b = Int32Array.from(currentLines.slice(pre, m - suf), intern);
    const middle = isNew.subarray(pre, m - suf); // a view: writes go to isNew
    matchLines(a, b, ids.size, middle);
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

/**
 * Clears `isNew[j]` for every line `b[j]` that is matched to a line of `a`.
 * `a` and `b` hold interned line ids in `[0, idCount)`.
 */
export function matchLines(a: Int32Array, b: Int32Array, idCount: number, isNew: Uint8Array): void {
  // Scratch tables indexed by line id; always reset to 0 after use.
  const countA = new Int32Array(idCount);
  const countB = new Int32Array(idCount);
  const posB = new Int32Array(idCount);
  const budget = { left: TOTAL_MYERS_BUDGET };

  // Explicit stack of [aLo, aHi, bLo, bHi) ranges: no recursion depth limit.
  const stack: number[] = [0, a.length, 0, b.length];
  while (stack.length > 0) {
    let bHi = stack.pop()!;
    let bLo = stack.pop()!;
    let aHi = stack.pop()!;
    let aLo = stack.pop()!;

    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
      isNew[bLo] = 0;
      aLo++;
      bLo++;
    }
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
      isNew[bHi - 1] = 0;
      aHi--;
      bHi--;
    }
    if (aLo === aHi || bLo === bHi) {
      continue; // only insertions or only deletions left
    }

    for (let i = aLo; i < aHi; i++) {
      countA[a[i]]++;
    }
    for (let j = bLo; j < bHi; j++) {
      countB[b[j]]++;
      posB[b[j]] = j;
    }
    // Anchors: lines unique on both sides, in base order.
    const anchorA: number[] = [];
    const anchorB: number[] = [];
    let anyCommon = false;
    for (let i = aLo; i < aHi; i++) {
      const id = a[i];
      if (countB[id] > 0) {
        anyCommon = true;
        if (countA[id] === 1 && countB[id] === 1) {
          anchorA.push(i);
          anchorB.push(posB[id]);
        }
      }
    }
    for (let i = aLo; i < aHi; i++) {
      countA[a[i]] = 0;
    }
    for (let j = bLo; j < bHi; j++) {
      countB[b[j]] = 0;
    }

    if (!anyCommon) {
      continue; // nothing in common: every current line in the range is new
    }
    // An optimal diff when it is affordable. Anchors alone can lose matches,
    // e.g. when a moved unique line cuts off a block of duplicate lines.
    if (myers(a, aLo, aHi, b, bLo, bHi, isNew, budget)) {
      continue;
    }
    if (anchorA.length > 0) {
      let prevA = aLo;
      let prevB = bLo;
      for (const k of longestIncreasing(anchorB)) {
        const i = anchorA[k];
        const j = anchorB[k];
        isNew[j] = 0;
        if (i > prevA && j > prevB) {
          stack.push(prevA, i, prevB, j);
        }
        prevA = i + 1;
        prevB = j + 1;
      }
      if (aHi > prevA && bHi > prevB) {
        stack.push(prevA, aHi, prevB, bHi);
      }
      continue;
    }
    chunked(a, aLo, aHi, b, bLo, bHi, isNew);
  }
}

/**
 * Budgeted Myers diff of one range. Returns false (and charges the attempt to
 * `budget`) when the range needs more edits than the budget allows.
 */
function myers(
  a: Int32Array,
  aLo: number,
  aHi: number,
  b: Int32Array,
  bLo: number,
  bHi: number,
  isNew: Uint8Array,
  budget: { left: number },
  attemptBudget = MYERS_BUDGET,
): boolean {
  const size = aHi - aLo + (bHi - bLo);
  const maxEditLength = Math.min(size, Math.floor(Math.min(attemptBudget, budget.left) / size));
  if (maxEditLength < 1) {
    return false;
  }
  // `timeout` exists at runtime since jsdiff 5.2 but is missing from @types/diff 5.2.
  const options = { maxEditLength, timeout: MYERS_TIMEOUT_MS } as { maxEditLength: number };
  // Returns undefined (despite the typings) when maxEditLength or timeout is exceeded.
  const parts = diffArrays(Array.from(a.subarray(aLo, aHi)), Array.from(b.subarray(bLo, bHi)), options) as
    | ReturnType<typeof diffArrays<number, number>>
    | undefined;
  if (!parts) {
    budget.left -= size * maxEditLength;
    return false;
  }
  let edits = 0;
  let j = bLo;
  for (const part of parts) {
    const count = part.value.length;
    if (part.added || part.removed) {
      edits += count;
    }
    if (part.removed) {
      continue;
    }
    if (!part.added) {
      isNew.fill(0, j, j + count);
    }
    j += count;
  }
  budget.left -= size * Math.max(1, edits);
  return true;
}

/**
 * Fallback for a large range without unique lines when a whole-range diff is
 * too slow: cut both sides into consecutive, proportionally sized chunks
 * (CHUNK current lines each) and diff chunk by chunk. Chunks are disjoint and
 * in order, so the result is a valid in-order match; lines that moved across
 * a chunk border may be marked new. Cost is linear in the range size.
 */
function chunked(a: Int32Array, aLo: number, aHi: number, b: Int32Array, bLo: number, bHi: number, isNew: Uint8Array): void {
  const ratio = (aHi - aLo) / (bHi - bLo);
  for (let j0 = bLo; j0 < bHi; j0 += CHUNK) {
    const j1 = Math.min(bHi, j0 + CHUNK);
    const i0 = aLo + Math.round((j0 - bLo) * ratio);
    const i1 = j1 === bHi ? aHi : aLo + Math.round((j1 - bLo) * ratio);
    if (i1 > i0) {
      // A chunk is small, so an unbounded per-chunk budget stays cheap.
      myers(a, i0, i1, b, j0, j1, isNew, { left: Infinity }, Infinity);
    }
  }
}

/**
 * Indices of a longest strictly increasing subsequence of `values`
 * (patience sorting, O(n log n)).
 */
export function longestIncreasing(values: readonly number[]): number[] {
  const n = values.length;
  const tails: number[] = []; // tails[k] = index of the smallest tail of an increasing run of length k+1
  const prev = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (values[tails[mid]] < v) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const out = new Array<number>(tails.length);
  for (let k = tails.length - 1, i = tails[tails.length - 1] ?? -1; k >= 0; k--, i = prev[i]) {
    out[k] = i;
  }
  return out;
}

function sameLine(x: string, y: string): boolean {
  return x === y || stripCr(x) === stripCr(y);
}

function stripCr(s: string): string {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}
