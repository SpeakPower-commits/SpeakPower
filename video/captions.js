/**
 * Captions: the data, the editing, and the drawing.
 *
 * Captions are stored as segments (roughly a sentence each), and each segment
 * keeps its words with their own timings:
 *
 *   { start, end, text, words: [{ text, start, end }] }
 *
 * Segments are what the user sees and corrects in the transcript list. Words
 * drive the on-screen look: short bursts of three or four words, in heavy
 * uppercase, with the word being spoken lit up in SpeakPower gold. That is the
 * style modern short-form editors use for a reason -- most social video is
 * watched muted, and a word-by-word highlight holds attention.
 *
 * All times are seconds in the SOURCE video, so captions stay attached to the
 * right words however the video is trimmed and cut.
 */

import { CAPTION_FONT } from './text.js';

// On-screen bursts. A burst ends at whichever comes first.
const MAX_WORDS_PER_BURST = 4;
const MAX_CHARS_PER_BURST = 22;
const BURST_BREAK_GAP = 0.55;       // a pause this long starts a new burst
const ORPHAN_ALLOWANCE = 8;         // extra characters allowed to finish a sentence

// Transcript segments, for the editable list.
const MAX_WORDS_PER_SEGMENT = 14;
const SEGMENT_BREAK_GAP = 0.9;

const GOLD = '#E0BE55';
const WHITE = '#FFFFFF';
const POP = 1.08;      // how much larger the spoken word is drawn
const SHRINK_TO_FIT = 1.22; // shrink up to this much to keep a burst on one line
const OUTLINE = 14;    // black outline width, in 1080p pixels

// --- Building segments -------------------------------------------------------

/** Words that end a sentence end a segment, so each line reads as a thought. */
const endsSentence = (text) => /[.!?]["')\]]?$/.test(text);

/** Group timed words into transcript segments. */
export function segmentsFromWords(words) {
  const segments = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    segments.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((word) => word.text).join(' '),
      words: current,
    });
    current = [];
  };
  for (const word of words) {
    const text = String(word.text ?? '').trim();
    if (!text || !(word.end >= word.start)) continue;
    const previous = current[current.length - 1];
    if (previous && (word.start - previous.end > SEGMENT_BREAK_GAP || current.length >= MAX_WORDS_PER_SEGMENT)) {
      flush();
    }
    current.push({ text, start: word.start, end: word.end });
    if (endsSentence(text)) flush();
  }
  flush();
  return segments;
}

/** Spread a line's words evenly across its time when real word timings are unknown. */
export function spreadWords(text, start, end) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length || !(end > start)) return [];
  const step = (end - start) / tokens.length;
  return tokens.map((token, index) => ({
    text: token,
    start: start + index * step,
    end: start + (index + 1) * step,
  }));
}

/** Segments from line-level chunks ({ text, start, end }) with no word timings. */
export function segmentsFromLines(lines) {
  return lines
    .map((line) => ({ ...line, text: String(line.text ?? '').trim() }))
    .filter((line) => line.text && line.end > line.start)
    .map((line) => ({
      start: line.start,
      end: line.end,
      text: line.text,
      words: spreadWords(line.text, line.start, line.end),
    }));
}

// --- SRT ----------------------------------------------------------------------

const SRT_TIME = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/;

function srtSeconds(value) {
  const match = SRT_TIME.exec(value);
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}

/** Parse an .srt file into segments. Tolerant of blank-line and numbering quirks. */
export function segmentsFromSrt(text) {
  const lines = [];
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  for (const block of blocks) {
    const rows = block.split('\n').map((row) => row.trim()).filter(Boolean);
    const timing = rows.findIndex((row) => row.includes('-->'));
    if (timing === -1) continue;
    const [from, to] = rows[timing].split('-->');
    const start = srtSeconds(from);
    const end = srtSeconds(to);
    // Strip formatting tags such as <i> and {\an8}; they are not spoken text.
    const caption = rows.slice(timing + 1).join(' ').replace(/<[^>]+>|\{[^}]*\}/g, '').trim();
    if (start !== null && end !== null && caption) lines.push({ start, end, text: caption });
  }
  return segmentsFromLines(lines);
}

// --- Editing ------------------------------------------------------------------

/**
 * Change a segment's text, keeping its timing.
 *
 * If the corrected line has the same number of words, each word keeps its own
 * real timing -- the common case of fixing a misheard name. Otherwise the new
 * words are spread across the line's time.
 */
export function editSegmentText(segment, text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const tokens = cleaned ? cleaned.split(' ') : [];
  const words = tokens.length === segment.words.length
    ? segment.words.map((word, index) => ({ ...word, text: tokens[index] }))
    : spreadWords(cleaned, segment.start, segment.end);
  return { ...segment, text: cleaned, words };
}

/**
 * Replace a word or phrase everywhere -- whole words, any case. This is for the
 * mistake that recurs all through a recording, like a name the speech model
 * keeps mishearing. Returns the new segments and how many were changed.
 */
export function replaceEverywhere(segments, find, replacement) {
  const target = find.trim();
  if (!target) return { segments, count: 0 };
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'giu');
  let count = 0;
  const next = segments.map((segment) => {
    const updated = segment.text.replace(pattern, (match, lead) => {
      count += 1;
      return lead + replacement.trim();
    });
    return updated === segment.text ? segment : editSegmentText(segment, updated);
  });
  return { segments: next, count };
}

// --- Drawing ------------------------------------------------------------------

/** Short on-screen bursts, built once per set of segments and then reused. */
const burstCache = new WeakMap();

export function burstsFor(segments) {
  if (burstCache.has(segments)) return burstCache.get(segments);
  const words = segments.flatMap((segment) => segment.words);
  const bursts = [];
  let current = [];
  for (const word of words) {
    if (current.length) {
      const previous = current[current.length - 1];
      const length = current.reduce((total, item) => total + item.text.length + 1, 0) + word.text.length;
      // Let a burst run a little long rather than strand a sentence's last
      // word on screen alone -- "welcome to Speak" then a lone "Power." both
      // reads badly and splits the brand name.
      const finishesSentence = endsSentence(word.text)
        && current.length < MAX_WORDS_PER_BURST
        && length <= MAX_CHARS_PER_BURST + ORPHAN_ALLOWANCE;
      if (current.length >= MAX_WORDS_PER_BURST
          || (length > MAX_CHARS_PER_BURST && !finishesSentence)
          || word.start - previous.end > BURST_BREAK_GAP
          || endsSentence(previous.text)) {
        bursts.push(current);
        current = [];
      }
    }
    current.push(word);
  }
  if (current.length) bursts.push(current);

  const shaped = bursts.map((burst) => ({
    start: burst[0].start,
    end: burst[burst.length - 1].end,
    words: burst,
  }));
  burstCache.set(segments, shaped);
  return shaped;
}

/** The burst on screen at a time, found by binary search: exports call this per frame. */
export function burstAt(bursts, time) {
  let low = 0;
  let high = bursts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const burst = bursts[middle];
    if (time < burst.start) high = middle - 1;
    else if (time >= burst.end) low = middle + 1;
    else return burst;
  }
  return null;
}

/**
 * Draw the caption for this moment. Called by renderer.drawFrame for both the
 * preview and the export.
 */
export function drawCaptions(ctx, { width, height, unit, layout, times }, captions) {
  if (!captions?.enabled || !captions.segments?.length) return;
  const burst = burstAt(burstsFor(captions.segments), times.source);
  if (!burst) return;

  // Each word owns the highlight from when it is spoken until the next one
  // starts, so the gold never blinks off between words.
  let active = burst.words.length - 1;
  for (let index = 0; index < burst.words.length - 1; index += 1) {
    if (times.source < burst.words[index + 1].start) { active = index; break; }
  }

  let fontSize = 88 * unit;
  const maxWidth = width - 2 * 80 * unit;
  const tokens = burst.words.map((word) => word.text.toUpperCase());
  ctx.save();

  // Every word gets a slot sized for its ENLARGED width, and the gap allows
  // for the outline on both sides. The spoken word then grows into space that
  // is already reserved, so it never touches its neighbour ("OTIENOAND") and
  // the line never shifts as the highlight moves along it.
  const measure = () => {
    ctx.font = `${fontSize}px ${CAPTION_FONT}`;
    return {
      slots: tokens.map((token) => ctx.measureText(token).width * POP),
      gap: ctx.measureText(' ').width + OUTLINE * unit,
    };
  };
  const rowWidth = (slots, gap, from, to) =>
    slots.slice(from, to).reduce((total, slot) => total + slot, 0) + gap * Math.max(0, to - from - 1);

  let { slots, gap } = measure();
  const single = rowWidth(slots, gap, 0, tokens.length);
  let breaks = [0, tokens.length];

  if (single > maxWidth && (single <= maxWidth * SHRINK_TO_FIT || tokens.length === 1)) {
    // Only a little too wide (or one long word): shrink slightly and keep one
    // line, which reads faster than two.
    fontSize *= maxWidth / single;
    ({ slots, gap } = measure());
  } else if (single > maxWidth) {
    // Two lines, split where they come out most even -- greedy wrapping left a
    // lone word ("IS") hanging on the second line.
    let best = 1;
    let bestWidth = Infinity;
    for (let split = 1; split < tokens.length; split += 1) {
      const widest = Math.max(rowWidth(slots, gap, 0, split), rowWidth(slots, gap, split, tokens.length));
      if (widest < bestWidth) { bestWidth = widest; best = split; }
    }
    breaks = [0, best, tokens.length];
    if (bestWidth > maxWidth) {
      fontSize *= maxWidth / bestWidth;
      ({ slots, gap } = measure());
    }
  }

  const lines = breaks.slice(0, -1).map((from, index) => {
    const to = breaks[index + 1];
    return { tokens: tokens.slice(from, to), width: rowWidth(slots, gap, from, to) };
  });

  const lineHeight = fontSize * 1.12;
  const bottom = height - layout.captionBottom * height;
  const top = bottom - lines.length * lineHeight;

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  let wordIndex = 0;
  lines.forEach((line, lineIndex) => {
    let x = (width - line.width) / 2;
    const y = top + lineHeight * (lineIndex + 0.5);

    for (const token of line.tokens) {
      const isActive = wordIndex === active;
      const textWidth = ctx.measureText(token).width;
      const slot = textWidth * POP;
      const centre = x + slot / 2;
      ctx.save();
      if (isActive) {
        // Pop the spoken word, scaling around the centre of its slot.
        ctx.translate(centre, y);
        ctx.scale(POP, POP);
        ctx.translate(-centre, -y);
      }
      const left = centre - textWidth / 2;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 8 * unit;
      ctx.shadowOffsetY = 4 * unit;
      ctx.lineWidth = OUTLINE * unit;
      ctx.strokeStyle = '#000';
      ctx.strokeText(token, left, y);
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = isActive ? GOLD : WHITE;
      ctx.fillText(token, left, y);
      ctx.restore();
      x += slot + gap;
      wordIndex += 1;
    }
  });
  ctx.restore();
}
