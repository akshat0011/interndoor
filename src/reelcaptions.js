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
  /**
   * How long a silence may be before the band is allowed to go EMPTY.
   *
   * Deliberately larger than `maxGap`, because the two answer different
   * questions. `maxGap` asks "are these one cue?" — a 0.45s pause is a sentence
   * boundary and the next sentence deserves its own cue. `closeGap` asks
   * "should the band blink?", and half a second of empty band at 30fps is
   * sixteen blank frames, which reads as a dropped caption rather than as a
   * pause. Measured on a real voiceover: the gaps between its sentences were
   * 0.39s, 0.52s and 0.39s, so a single 0.45 threshold blanked the band once,
   * in the middle, for no reason a viewer could interpret.
   *
   * It is still bounded: past 0.9s the speaker really has stopped, and holding
   * a finished line through that reads as a freeze.
   */
  closeGap: 0.9,
};

const display = (w) => String(w ?? '').trim();

/**
 * Words a cue must not END on.
 *
 * A caption that stops on "in" or "a" reads as a sentence cut in half, because
 * it is one — the eye finishes the line and the phrase is not finished. It got
 * much worse when the script became ONE running sentence: with four sentences
 * the cues fell on full stops by luck, and with one they were chopped every
 * five words wherever the count ran out, giving "Zoho CRM Developer in" and
 * "yet, so you'd be first" on a real reel.
 *
 * Articles, prepositions, conjunctions and auxiliaries — the words that only
 * make sense attached to what comes next.
 */
const DANGLING = new Set(['a', 'an', 'the', 'in', 'on', 'at', 'to', 'of', 'for', 'and', 'or',
  'so', 'but', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'has',
  'have', 'had', 'they', 'you', 'your', 'their', 'its', 'it', 'this', 'that', 'just', 'only', 'dot']);

/** True when the word closes a clause — a natural place to end a cue. */
const closesClause = (w) => /[,.;:!?]$/.test(display(w.word));

const bare = (w) => display(w.word).toLowerCase().replace(/[^a-z']/g, '');

/** A capitalised word that is not merely the start of a sentence. */
const capitalised = (w) => /^[A-Z]/.test(display(w.word));
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
      const prev = cur[cur.length - 1];
      /* A comma or a full stop is where a reader expects the line to end, so
         break there rather than waiting for the word count to run out — that
         is what keeps a cue a phrase instead of five arbitrary words. Only
         once the cue is worth reading on its own: breaking after a one-word
         clause would just make the stutter this avoids elsewhere. */
      const atClause = closesClause(prev) && cur.length >= 2;
      /* DO NOT BREAK INSIDE A RUN OF CAPITALISED WORDS. A job title, a city or
         a company is a single thing to a reader, and splitting it across two
         cues reads as a stumble: the first published Philips reel showed
         "Philips is hiring an Intern" and then "Embedded System in Pune
         Division", which cuts the role in half at exactly the moment somebody
         is deciding whether it is for them. The word cap yields to this; the
         character budget does not, because that is the width of the band. */
      const insideName = capitalised(prev) && capitalised(w) && !closesClause(prev);
      /* The word cap AND the duration cap both yield to a name. Only the
         character budget and a real pause still force a break: the budget is
         the physical width of the band, and a gap is the speaker stopping. */
      const overCap = cur.length >= cfg.maxWords && !insideName;
      const tooLong = span > cfg.maxDur && !insideName;
      if (atClause || gap > cfg.maxGap || tooLong || overCap
          || width([...cur, w]) > cfg.maxChars) {
        cues.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) cues.push(cur);

  /* Never end a cue on a dangling word. Pushing it into the next cue is
     cheaper than re-planning the break: the next cue gains a word, and the
     caps below already tolerate one over for the orphan rescue. */
  for (let i = 0; i < cues.length - 1; i++) {
    /* Bounded by the BAND, not by the word count. A cue one or two words over
       still reads fine; a cue ending on "in" does not, so the caps that
       decided the break do not get to veto the repair. The character budget
       still does — it is the physical width of the band. */
    let moved = 0;
    while (cues[i].length > 1 && moved < 3
           && DANGLING.has(bare(cues[i][cues[i].length - 1]))
           && !closesClause(cues[i][cues[i].length - 1])
           && width([cues[i][cues[i].length - 1], ...cues[i + 1]]) <= cfg.maxChars) {
      cues[i + 1].unshift(cues[i].pop());
      moved++;
    }
  }

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
  /* Rescues a cue of ONE OR TWO words, not just one. "dot com." is two, and
     splitting the site's own address across two cues is the same fault as a
     one-word stutter — the domain is the thing the reel exists to have read.
     Bounded by the character budget rather than the word cap, for the reason
     above it: the budget is the band, the cap is a preference. */
  for (let i = cues.length - 1; i > 0; i--) {
    if (cues[i].length > 2) continue;
    const prev = cues[i - 1];
    const tail = cues[i];
    /* A clause boundary is a deliberate break, not an accident — do not undo
       one to tidy up a short cue. */
    if (closesClause(prev[prev.length - 1])) continue;
    const gap = tail[0].start - prev[prev.length - 1].end;
    const span = tail[tail.length - 1].end - prev[0].start;
    if (gap <= cfg.maxGap && span <= cfg.maxDur * 1.4 && width([...prev, ...tail]) <= cfg.maxChars) {
      prev.push(...tail);
      cues.splice(i, 1);
    }
  }

  return cues.map((group) => shape(collapseDomain(group), cfg));
}

/**
 * "InternDoor dot com." -> "interndoor.com"
 *
 * The voice has to SAY "dot com" or the model spells nothing useful, but a
 * reader should see the address they are meant to type. The three spoken words
 * collapse into one displayed word carrying their combined span, so the
 * highlight still lands on it at the right moment.
 *
 * Done here rather than in the script, because the script is what gets spoken
 * and what the aligner matches against — changing it there would break both.
 */
function collapseDomain(group) {
  const out = [];
  for (let i = 0; i < group.length; i++) {
    const a = group[i], b = group[i + 1], c = group[i + 2];
    if (b && c && bare(b) === 'dot' && /^com[.,!?]?$/i.test(display(c.word))) {
      /* NO trailing full stop. It is the last thing on screen and it is an
         address, not a sentence — "interndoor.com." invites somebody to type
         the stop as part of it. */
      out.push({ word: `${display(a.word).toLowerCase()}.com`, start: a.start, end: c.end });
      i += 2;
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * A cue's own start and end.
 *
 * `minDur` keeps a genuinely short cue on screen long enough to read. The
 * closing against the NEXT cue happens later, in closeCues, once they are all
 * known.
 */
function shape(group, cfg) {
  return {
    words: group.map((w) => ({ word: display(w.word), start: w.start, end: w.end })),
    text: group.map((w) => display(w.word)).join(' '),
    start: group[0].start,
    end: Math.max(group[group.length - 1].end, group[0].start + cfg.minDur),
  };
}

/**
 * Close each cue against the next, once they are all known.
 *
 * Held to the next cue's start across an ordinary pause, so the band does not
 * blink empty between two sentences. Across a genuinely long silence it closes
 * shortly after its last word instead — see `closeGap`.
 */
export function closeCues(cues, opts = {}) {
  const cfg = { ...CAPTION, ...opts };
  return cues.map((cue, i) => {
    const next = cues[i + 1];
    if (!next) return { ...cue, end: cue.end + 0.2 };
    const gap = next.start - cue.end;
    return { ...cue, end: gap <= cfg.closeGap ? next.start : cue.end + 0.12 };
  });
}

/** Word timings to finished cues, which is all the renderer wants. */
export function captionsFor(words, opts = {}) {
  return closeCues(groupCues(words, opts), opts);
}
