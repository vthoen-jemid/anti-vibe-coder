import * as assert from 'assert';
import { diffArrays } from 'diff';
import { computeNewLines, longestIncreasing } from '../src/tracking/newLines';

function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lines left unmarked must form a subsequence of the base, in order. */
function assertValidMatch(base: string[], cur: string[], isNew: Uint8Array): void {
  let i = 0;
  for (let j = 0; j < cur.length; j++) {
    if (isNew[j]) {
      continue;
    }
    while (i < base.length && base[i] !== cur[j]) {
      i++;
    }
    assert.ok(i < base.length, `line ${j} ("${cur[j]}") is marked old but has no base counterpart in order`);
    i++;
  }
}

/** Number of new lines according to a plain (optimal) Myers diff. */
function myersNewCount(base: string[], cur: string[]): number {
  return diffArrays(base, cur)
    .filter((p) => p.added)
    .reduce((n, p) => n + p.value.length, 0);
}

const count = (a: Uint8Array) => a.reduce((n, v) => n + v, 0);

describe('computeNewLines (fast diff)', () => {
  it('accepts pre-split base lines', () => {
    assert.deepStrictEqual([...computeNewLines(['a', 'b'], ['a', 'x', 'b'], false)], [0, 1, 0]);
  });

  it('handles moved blocks with a valid in-order match', () => {
    const base = ['a', 'b', 'c', 'd', 'e', 'f'];
    const cur = ['d', 'e', 'f', 'a', 'b', 'c'];
    const isNew = computeNewLines(base, cur, false);
    assertValidMatch(base, cur, isNew);
    assert.strictEqual(count(isNew), 3);
  });

  it('marks everything new when nothing is in common', () => {
    assert.strictEqual(count(computeNewLines(['a', 'b'], ['c', 'd', 'e'], false)), 3);
  });

  it('matches duplicate-only lines (no unique anchors) via Myers', () => {
    const base = ['}', '}', 'x', '}'];
    const cur = ['}', 'y', '}', '}'];
    const isNew = computeNewLines(base, cur, false);
    assertValidMatch(base, cur, isNew);
    assert.strictEqual(count(isNew), myersNewCount(base, cur));
  });

  it('agrees with an optimal Myers diff on random edits', () => {
    const r = rng(42);
    const vocab = ['{', '}', 'return x;', 'const a = 1;', 'if (y) {', 'foo();', 'bar();', '', '// note'];
    let worse = 0;
    for (let round = 0; round < 300; round++) {
      const base = Array.from({ length: 5 + Math.floor(r() * 60) }, () =>
        r() < 0.5 ? vocab[Math.floor(r() * vocab.length)] : `line ${Math.floor(r() * 200)}`,
      );
      const cur = base.flatMap((l) => {
        const x = r();
        return x < 0.1 ? [] : x < 0.2 ? [`new ${Math.floor(r() * 50)}`] : x < 0.25 ? [l, vocab[Math.floor(r() * vocab.length)]] : [l];
      });
      const isNew = computeNewLines(base, cur, false);
      assertValidMatch(base, cur, isNew);
      const optimal = myersNewCount(base, cur);
      assert.ok(count(isNew) >= optimal);
      if (count(isNew) > optimal) {
        worse++;
        // Patience diffs may give up a few matches; never many.
        assert.ok(count(isNew) - optimal <= Math.max(2, Math.ceil(optimal * 0.25)), `round ${round}: ${count(isNew)} vs ${optimal}`);
      }
    }
    assert.ok(worse < 30, `${worse} of 300 rounds were not minimal`);
  });

  it('stays fast and valid on a large file without unique lines', () => {
    // Only a handful of distinct lines: no anchors, Myers budget exceeded → greedy fallback.
    const r = rng(7);
    for (const vocab of [['{', '}', 'a;', 'b;', 'c;'], ['a', 'b', 'c']]) {
      const base = Array.from({ length: 20_000 }, () => vocab[Math.floor(r() * vocab.length)]);
      const cur = Array.from({ length: 20_000 }, () => vocab[Math.floor(r() * vocab.length)]);
      const t0 = Date.now();
      const isNew = computeNewLines(base, cur, false);
      assert.ok(Date.now() - t0 < 2000, 'took too long');
      assertValidMatch(base, cur, isNew);
      // Random sequences over a tiny alphabet share most lines; the fallback must still find many.
      assert.ok(count(isNew) < cur.length / 2, `${count(isNew)} marked new`);
    }
  });

  it('keeps a block of duplicate lines when unique lines around it swap places', () => {
    // Anchors alone would keep one moved unique line and lose the block in between.
    for (const filler of ['}', 'return;']) {
      const block = Array(100).fill(filler);
      const base = ['import a;', ...block, 'export b;'];
      const cur = ['export b;', ...block, 'import a;'];
      const isNew = computeNewLines(base, cur, false);
      assertValidMatch(base, cur, isNew);
      assert.strictEqual(count(isNew), myersNewCount(base, cur));
    }
  });

  it('stays valid when a large rewrite moves blocks around', () => {
    const r = rng(11);
    const base = Array.from({ length: 6000 }, (_, i) => (r() < 0.3 ? '}' : `line ${i}`));
    const cur = [...base.slice(3000), ...base.slice(0, 3000)].map((l) => (r() < 0.3 ? `changed ${r()}` : l));
    const isNew = computeNewLines(base, cur, false);
    assertValidMatch(base, cur, isNew);
  });

  it('treats CRLF and LF as equal inside the changed middle too', () => {
    const base = 'a\nb\nc\nd\n';
    const cur = ['a\r', 'x\r', 'b\r', 'c\r', 'y\r', 'd\r', ''];
    assert.deepStrictEqual([...computeNewLines(base, cur, false)], [0, 1, 0, 0, 1, 0, 0]);
  });
});

describe('longestIncreasing', () => {
  it('returns indices of a longest strictly increasing subsequence', () => {
    const v = [3, 1, 4, 1, 5, 9, 2, 6];
    const idx = longestIncreasing(v);
    assert.strictEqual(idx.length, 4);
    for (let k = 1; k < idx.length; k++) {
      assert.ok(idx[k] > idx[k - 1] && v[idx[k]] > v[idx[k - 1]]);
    }
  });

  it('handles empty input', () => {
    assert.deepStrictEqual(longestIncreasing([]), []);
  });
});
