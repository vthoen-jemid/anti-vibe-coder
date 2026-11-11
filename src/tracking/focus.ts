/**
 * Picks the "focus area" of an editor: the band of visible lines the user is
 * most likely reading, instead of everything on screen.
 *
 * The band sits in the middle of the viewport. Near the top (or bottom) of a
 * file, where you cannot scroll a line into the middle, the band slides
 * towards that edge so every line can still be reached.
 *
 * @param visible   visible line numbers, top to bottom (folded lines excluded)
 * @param lineCount total number of lines in the document
 * @param fraction  size of the band as a fraction of the visible lines (0..1]
 */
export function focusLines(visible: readonly number[], lineCount: number, fraction: number): number[] {
  const n = visible.length;
  if (n === 0) {
    return [];
  }
  if (!(fraction < 1)) {
    return [...visible];
  }
  const size = Math.max(1, Math.min(n, Math.round(n * fraction)));
  const centered = Math.floor((n - size) / 2);
  const above = visible[0]; // lines you can still scroll up to
  const below = Math.max(0, lineCount - 1 - visible[n - 1]); // lines you can still scroll down to

  let offset = centered;
  if (above < centered && below < centered) {
    // The file barely scrolls: the middle band could never reach its edges.
    return [...visible];
  } else if (above < centered) {
    // Scrolling down one line moves the band down two, so no line is skipped.
    offset = above;
  } else if (below < centered) {
    offset = n - size - below;
  }
  return visible.slice(offset, offset + size);
}
