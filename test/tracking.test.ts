import * as assert from 'assert';
import { computeLineKeys, splitLines } from '../src/tracking/lineKeys';
import { focusLines } from '../src/tracking/focus';
import { computeNewLines } from '../src/tracking/newLines';
import { bucketOf, bumpScore, categoryOf, progressRatio, pruneScores, ScoreMap, summarize } from '../src/tracking/scoring';
import { mix, parseColor, toCss } from '../src/ui/color';

const newIdx = (a: Uint8Array) => [...a].flatMap((v, i) => (v ? [i] : []));

describe('computeNewLines', () => {
  it('marks every line new for a file that does not exist on base', () => {
    assert.deepStrictEqual(newIdx(computeNewLines(null, ['a', 'b'], false)), [0, 1]);
  });

  it('marks added and modified lines only', () => {
    const base = 'a\nb\nc\n';
    const cur = splitLines('a\nB\nc\nd\n');
    assert.deepStrictEqual(newIdx(computeNewLines(base, cur, false)), [1, 3]);
  });

  it('ignores CRLF vs LF differences', () => {
    const base = 'a\nb\n';
    const cur = splitLines('a\r\nb\r\nc\r\n');
    assert.deepStrictEqual(newIdx(computeNewLines(base, cur, false)), [2]);
  });

  it('can skip whitespace-only lines', () => {
    const cur = ['x', '   ', '', 'y'];
    assert.deepStrictEqual(newIdx(computeNewLines(null, cur, true)), [0, 3]);
  });
});

describe('line keys', () => {
  it('keeps keys when lines shift', () => {
    const before = computeLineKeys(['foo()', 'bar()']);
    const after = computeLineKeys(['inserted()', 'foo()', 'bar()']);
    assert.strictEqual(after[1], before[0]);
    assert.strictEqual(after[2], before[1]);
  });

  it('changes key when content changes', () => {
    const [a] = computeLineKeys(['return 1;']);
    const [b] = computeLineKeys(['return 2;']);
    assert.notStrictEqual(a, b);
  });

  it('ignores indentation changes', () => {
    const [a] = computeLineKeys(['return 1;']);
    const [b] = computeLineKeys(['    return 1;']);
    assert.strictEqual(a, b);
  });

  it('gives duplicate lines distinct keys', () => {
    const keys = computeLineKeys(['}', 'x', '}']);
    assert.notStrictEqual(keys[0], keys[2]);
    assert.strictEqual(new Set(keys).size, 3);
  });
});

describe('scoring', () => {
  it('a reviewed line that is modified starts unseen again', () => {
    const map: ScoreMap = new Map();
    const v1 = computeLineKeys(['const a = 1;', 'const b = 2;']);
    bumpScore(map, v1[0], 1);
    bumpScore(map, v1[1], 1);
    const v2 = computeLineKeys(['const a = 1;', 'const b = 3;']);
    const isNew = new Uint8Array([1, 1]);
    const p = summarize(v2, isNew, map, 0.8);
    assert.deepStrictEqual(p, { total: 2, sum: 1, reviewed: 1 });
    assert.strictEqual(progressRatio(p), 0.5);
  });

  it('clamps to [0,1]', () => {
    const map: ScoreMap = new Map();
    bumpScore(map, 'k', 0.7);
    bumpScore(map, 'k', 0.7);
    assert.strictEqual(map.get('k'), 1);
    assert.strictEqual(bumpScore(map, 'k', 0.1), false);
  });

  it('prunes dead keys', () => {
    const map: ScoreMap = new Map([['a', 1], ['b', 0.5]]);
    assert.strictEqual(pruneScores(map, ['a']), 1);
    assert.deepStrictEqual([...map.keys()], ['a']);
  });

  it('buckets scores', () => {
    assert.strictEqual(bucketOf(0, 10), 0);
    assert.strictEqual(bucketOf(0.54, 10), 5);
    assert.strictEqual(bucketOf(2, 10), 10);
  });
});

describe('color', () => {
  it('parses and mixes colours', () => {
    const fb = { r: 0, g: 0, b: 0, a: 1 };
    const blue = parseColor('rgba(0, 0, 255, 0.2)', fb);
    const pink = parseColor('#ff00ff', fb);
    assert.deepStrictEqual(blue, { r: 0, g: 0, b: 255, a: 0.2 });
    assert.strictEqual(toCss(mix(blue, pink, 0.5)), 'rgba(128, 0, 255, 0.6)');
    assert.deepStrictEqual(parseColor('nonsense', fb), fb);
  });
});

describe('categoryOf', () => {
  it('splits files into unseen / partial / reviewed', () => {
    assert.strictEqual(categoryOf({ total: 0, sum: 0, reviewed: 0 }), 'reviewed');
    assert.strictEqual(categoryOf({ total: 10, sum: 0, reviewed: 0 }), 'unseen');
    assert.strictEqual(categoryOf({ total: 10, sum: 0.9, reviewed: 0 }), 'unseen');
    assert.strictEqual(categoryOf({ total: 10, sum: 1, reviewed: 0 }), 'partial');
    assert.strictEqual(categoryOf({ total: 10, sum: 9.5, reviewed: 9 }), 'partial');
    assert.strictEqual(categoryOf({ total: 10, sum: 8.5, reviewed: 10 }), 'reviewed');
  });
});

describe('categoryOf with a custom partially-seen threshold', () => {
  it('uses the given threshold', () => {
    assert.strictEqual(categoryOf({ total: 10, sum: 1, reviewed: 0 }, 0.3), 'unseen');
    assert.strictEqual(categoryOf({ total: 10, sum: 3, reviewed: 0 }, 0.3), 'partial');
  });
});

describe('focusLines', () => {
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  it('takes the middle band when scrolled into the file', () => {
    // 50 lines visible (100..149) in a 1000-line file, 30% band = 15 lines.
    assert.deepStrictEqual(focusLines(range(100, 149), 1000, 0.3), range(117, 131));
  });

  it('returns everything when the area is the whole screen', () => {
    assert.deepStrictEqual(focusLines(range(0, 9), 100, 1), range(0, 9));
  });

  it('slides to the top edge at the start of a file without skipping lines', () => {
    assert.deepStrictEqual(focusLines(range(0, 49), 1000, 0.3), range(0, 14));
    assert.deepStrictEqual(focusLines(range(1, 50), 1000, 0.3), range(2, 16));
    // Every line from 0 up to the centred band is reachable while scrolling down.
    const covered = new Set<number>();
    for (let top = 0; top < 30; top++) {
      focusLines(range(top, top + 49), 1000, 0.3).forEach((l) => covered.add(l));
    }
    assert.ok(range(0, 60).every((l) => covered.has(l)));
  });

  it('slides to the bottom edge at the end of a file', () => {
    assert.deepStrictEqual(focusLines(range(950, 999), 1000, 0.3), range(985, 999));
  });

  it('counts the whole screen when the file barely scrolls', () => {
    assert.deepStrictEqual(focusLines(range(0, 29), 32, 0.3), range(0, 29));
  });
});
