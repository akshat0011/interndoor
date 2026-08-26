/**
 * Turning word timings into caption cues.
 *
 * The aligner gives one span per word. A caption that changed on every word
 * would strobe, and one that held a whole sentence would be a paragraph on a
 * phone — so words are grouped into cues, and the cue is what appears. The
 * highlighted word inside it is what moves.
 *
 * Ported from storygasted's `caption.group`, minus the ASS rendering: these
 * captions are drawn by the card itself, in the band it already reserves at
 * y~1400, so they inherit the site's type and colour instead of ffmpeg's. That
 * also keeps the whole reel a pure function of `t` — see the note on `seek` in
 * bin/render-reel.js. Nothing here knows about video.
 */

/**
 * Defaults, measured against the card's caption band rather than guessed.
 *
 * `maxChars` stands in for storygasted's real text measurement. Measured in
 * the card: the band is 680px wide at 46px, which holds about 26 characters a
 * line, and 52 is therefore two full lines. The band has room for three (a
 * 65-character cue rendered 163px into a 170px band), so 52 keeps a line in
 * hand. It is a proxy, and it is the right kind of proxy: it errs toward
 * SHORTER cues, and a short cue is only ever a faster cut.
 */
export const CAPTION = {
  maxWords: 5,
  maxChars: 52,
  maxDur: 2.4,
  maxGap: 0.45,
  minDur: 0.5,
};

const display = (w) => String(w ?? '').trim();
const width = (words) => words.reduce((n, w) => n + display(w.word).length + 1, -1);

/**
 * Group word spans into cues.
 *
 * A cue breaks when the silence before a word is long enough to be a real
 * pause, when it has run too long, when it holds too many words, or when it
 * would not fit the band. Anything else and the word joins the cue in progress.
 */
export function groupCues(words, opts = {}) {
  const cfg = { ...CAPTION, ...opts };
  const usable = (words ?? []).filter((w) => display(w.word));
  const cues = [];
  let cur = [];

  for (const w of usable) {
    if (cur.length) {
      const gap = w.start - cur[cur.length - 1].end;
      const span = w.end - cur[0].start;
      if (gap > cfg.maxGap || span > cfg.maxDur || cur.length >= cfg.maxWords
          || width([...cur, w]) > cfg.maxChars) {
        cues.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) cues.push(cur);

  // A cue of ONE word reads as a stutter — it flashes up and is gone before it
  // can be read. Pull it back onto the cue before it, walking backwards so a
  // run of orphans collapses rather than only its last member. storygasted
  // does the same, for the same reason.
  //
  // THE WORD CAP IS SOFT BY ONE HERE, and the character budget is not. The cap
  // is a readability heuristic; the budget is the width of the band, which is
  // physical. Enforcing the cap during the merge produced
  // "Find it on InternDoor dot" | "com." on a real voiceover — the site's own
  // URL broken across two cues so that "com." flashed alone for 0.44s, which is
  // a worse readability outcome than the six-word cue it was protecting
  // against. One over, never two: a cue already carrying a rescued orphan does
  // not take another.
  for (let i = cues.length - 1; i > 0; i--) {
    if (cues[i].length !== 1) continue;
    const prev = cues[i - 1];
    const one = cues[i][0];
    if (prev.length > cfg.maxWords) continue;
    const gap = one.start - prev[prev.length - 1].end;
    const span = one.end - prev[0].start;
    if (gap <= cfg.maxGap && span <= cfg.maxDur && width([...prev, one]) <= cfg.maxChars) {
      prev.push(one);
      cues.splice(i, 1);
    }
  }

  return cues.map((group) => shape(group, cfg));
}

/**
 * A cue's own start and end.
 *
 * The end is stretched to the next cue's start when the gap is small, so the
 * band does not blink empty between two halves of one sentence. Across a real
 * pause it closes shortly after the last word instead, because holding a
 * finished line through three seconds of silence reads as a freeze.
 *
 * `minDur` keeps a genuinely short cue on screen long enough to read.
 */
function shape(group, cfg) {
  return {
    words: group.map((w) => ({ word: display(w.word), start: w.start, end: w.end })),
    text: group.map((w) => display(w.word)).join(' '),
    start: group[0].start,
    end: Math.max(group[group.length - 1].end, group[0].start + cfg.minDur),
  };
}

/** Close each cue against the next, once they are all known. */
export function closeCues(cues, opts = {}) {
  const cfg = { ...CAPTION, ...opts };
  return cues.map((cue, i) => {
    const next = cues[i + 1];
    if (!next) return { ...cue, end: cue.end + 0.2 };
    const gap = next.start - cue.end;
    return { ...cue, end: gap <= cfg.maxGap ? next.start : cue.end + 0.12 };
  });
}

/** Word timings to finished cues, which is all the renderer wants. */
export function captionsFor(words, opts = {}) {
  return closeCues(groupCues(words, opts), opts);
}
