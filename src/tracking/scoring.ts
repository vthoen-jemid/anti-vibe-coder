/** Per-file map lineKey -> score in [0, 1]. */
export type ScoreMap = Map<string, number>;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function getScore(map: ScoreMap | undefined, key: string): number {
  return map?.get(key) ?? 0;
}

/** Adds `delta` to the score of `key`. Returns true when the value changed. */
export function bumpScore(map: ScoreMap, key: string, delta: number): boolean {
  const old = map.get(key) ?? 0;
  const next = clamp01(old + delta);
  if (next === old) {
    return false;
  }
  map.set(key, next);
  return true;
}

export function setScore(map: ScoreMap, key: string, value: number): boolean {
  const next = clamp01(value);
  const old = map.get(key) ?? 0;
  if (next === old) {
    return false;
  }
  if (next === 0) {
    map.delete(key);
  } else {
    map.set(key, next);
  }
  return true;
}

export interface Progress {
  /** Number of tracked (new) lines. */
  total: number;
  /** Sum of scores of tracked lines. */
  sum: number;
  /** Lines with score >= threshold. */
  reviewed: number;
}

export function summarize(
  keys: readonly string[],
  isNew: Uint8Array,
  map: ScoreMap | undefined,
  threshold: number,
): Progress {
  let total = 0;
  let sum = 0;
  let reviewed = 0;
  for (let i = 0; i < keys.length; i++) {
    if (!isNew[i]) {
      continue;
    }
    const s = getScore(map, keys[i]);
    total++;
    sum += s;
    if (s >= threshold) {
      reviewed++;
    }
  }
  return { total, sum, reviewed };
}

export function progressRatio(p: Progress): number {
  return p.total === 0 ? 1 : p.sum / p.total;
}

export type Category = 'unseen' | 'partial' | 'reviewed';

/** Default mean score below which a file counts as "unseen". */
export const UNSEEN_BELOW = 0.1;

/**
 * unseen   – mean score < `partialThreshold`
 * reviewed – every new line has reached the fully-seen threshold
 * partial  – everything in between
 */
export function categoryOf(p: Progress, partialThreshold = UNSEEN_BELOW): Category {
  if (p.total === 0 || p.reviewed >= p.total) {
    return 'reviewed';
  }
  if (progressRatio(p) < partialThreshold) {
    return 'unseen';
  }
  return 'partial';
}

/** Removes keys that no longer exist in the file. Returns number removed. */
export function pruneScores(map: ScoreMap, liveKeys: readonly string[]): number {
  const live = new Set(liveKeys);
  let removed = 0;
  for (const k of [...map.keys()]) {
    if (!live.has(k)) {
      map.delete(k);
      removed++;
    }
  }
  return removed;
}

/** Maps a score to one of `buckets + 1` colour steps (0..buckets). */
export function bucketOf(score: number, buckets: number): number {
  return Math.round(clamp01(score) * buckets);
}
