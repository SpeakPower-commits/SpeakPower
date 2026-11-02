/**
 * The automatic editor's decisions, as plain logic.
 *
 * Given a transcript (word timings from Whisper), the sound's loudness and the
 * user's instruction, this works out:
 *
 *   - what to cut: long pauses, "um"s and stutters
 *   - which moments make the best short clips
 *   - which graphics go where: hook card, name titles, pop-up key phrases,
 *     progress bar, chapter cards, logo, intro and end cards
 *
 * and builds ordinary editor projects from them (project.js, tracks.js), so
 * every automatic edit can be exported, or opened in the editor and changed.
 *
 * The free AI (brain.js) only ever adds judgement -- scores and titles. Every
 * step has a plain fallback, so an edit always finishes even when the AI
 * can't be downloaded.
 *
 * Times are seconds in the source video unless a name says otherwise.
 */

import { addCut, createProject, outputDuration, setTrim, sourceToOutput } from './project.js';
import { addClip } from './tracks.js';

// --- The instruction ---------------------------------------------------------

export const DEFAULT_SETTINGS = {
  episode: true,
  clips: true,
  postText: true,
  clipCount: 3,
  clipMin: 20,
  clipMax: 60,
  clipFormat: '9:16',
  episodeFormat: '16:9',
  framing: 'blur',
  captions: true,
  callouts: true,
  progress: true,
  logo: true,
  logoPosition: 'logo-tr',
  removeFillers: true,
  removePauses: true,
  endCard: true,
  cta: 'Follow SpeakPower for more',
  topic: '',
  people: [],
};

const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const toNumber = (value) => NUMBERS[value] ?? Number(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

const CLIP_WORDS = 'clips?|shorts?|reels?|tiktoks?|highlights?|teasers?';
const NAME = "[A-Z][\\w'’.-]*(?:\\s+[A-Z][\\w'’.-]*){0,3}";

/**
 * Read the user's instruction into settings. The checkboxes give the starting
 * point; the instruction can switch things on or off and fill in the details
 * (how many clips, how long, about what, who is speaking, the call to action).
 */
export function parseInstruction(text, base = DEFAULT_SETTINGS) {
  const settings = { ...base, people: [...(base.people || [])] };
  const original = String(text || '');
  const t = original.toLowerCase();

  const count = t.match(new RegExp(`\\b(\\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(?:[a-z'-]+\\s+){0,3}?(?:${CLIP_WORDS})\\b`));
  if (count) {
    settings.clipCount = clamp(toNumber(count[1]) || 3, 1, 10);
    settings.clips = true;
  } else if (new RegExp(`\\b(?:${CLIP_WORDS})\\b`).test(t)) {
    settings.clips = true;
  }

  const range = t.match(/(\d{1,3})\s*(?:-|to|–)\s*(\d{1,3})\s*(?:s|sec|secs|seconds?)\b/);
  const single = t.match(/(\d{1,3})\s*-?\s*(?:s|sec|secs|seconds?)\b/);
  const minutes = t.match(/(\d(?:\.\d)?)\s*-?\s*(?:min|mins|minutes?)\b/);
  if (range) {
    settings.clipMin = clamp(Number(range[1]), 5, 170);
    settings.clipMax = clamp(Number(range[2]), settings.clipMin + 5, 180);
  } else if (single) {
    const target = clamp(Number(single[1]), 8, 180);
    settings.clipMin = Math.max(5, Math.round(target * 0.6));
    settings.clipMax = Math.round(target * 1.1);
  } else if (minutes && Number(minutes[1]) <= 3) {
    const target = Number(minutes[1]) * 60;
    settings.clipMin = Math.round(target * 0.6);
    settings.clipMax = Math.round(target * 1.1);
  }

  if (/\b(full|whole|entire|long[- ]form|episode|youtube)\b/.test(t)) settings.episode = true;
  if (new RegExp(`\\b(only|just)\\b[^.]*\\b(?:${CLIP_WORDS})\\b`).test(t)) settings.episode = false;
  const cleanOnly = /\b(only|just)\b[^.]*\b(clean|ums?|pauses?|fillers?|tidy)\b/.test(t)
    || /\b(clean|ums?|pauses?|fillers?|tidy)\b[^.]*\bonly\b/.test(t);
  if (cleanOnly && !new RegExp(`\\b(?:${CLIP_WORDS})\\b`).test(t)) {
    settings.clips = false;
    settings.episode = true;
  }
  if (/\b(no|without|skip)\s+(?:the\s+)?(post|caption text|description|hashtags)\b/.test(t)) settings.postText = false;

  if (/\b(keep|don'?t remove|do not remove|leave)\b[^.]*\b(ums?|uhs?|fillers?)\b/.test(t)) settings.removeFillers = false;
  if (/\b(keep|don'?t remove|do not remove|leave)\b[^.]*\b(pauses?|silences?|gaps?)\b/.test(t)) settings.removePauses = false;

  if (/\b(no|without)\s+(?:burned[- ]in\s+)?(captions?|subtitles?)\b/.test(t)) settings.captions = false;
  if (/\b(no|without)\s+(pop-?ups?|callouts?|key ?words?|graphics)\b/.test(t)) settings.callouts = false;
  if (/\b(no|without)\s+(?:a\s+)?progress(?: bar)?\b/.test(t)) settings.progress = false;
  if (/\b(no|without)\s+(?:an?\s+)?end ?card\b/.test(t)) settings.endCard = false;
  if (/\b(no|without)\s+(?:the\s+|my\s+)?logo\b/.test(t)) settings.logo = false;
  const logoAt = t.match(/logo\b[^.]*?\b(top|bottom|upper|lower)[ -](left|right)\b/);
  if (logoAt) settings.logoPosition = `logo-${/top|upper/.test(logoAt[1]) ? 't' : 'b'}${logoAt[2][0]}`;

  if (/\b(square|1:1)\b/.test(t)) settings.clipFormat = '1:1';
  if (/\b(landscape|widescreen|16:9|horizontal)\b[^.]*\b(clips?|shorts?)\b/.test(t)) settings.clipFormat = '16:9';
  if (/\b(fill the screen|crop|full[- ]?screen|no blur)\b/.test(t)) settings.framing = 'crop';

  const about = t.match(/\b(?:about|on the topic of|focus(?:ing)? on|on)\s+([a-z0-9' -]{3,60}?)(?:[.,;!?]|\band\b|\bwith\b|\bfor\b|$)/);
  if (about && !/^(the screen|top|bottom|screen)\b/.test(about[1])) settings.topic = about[1].trim();

  const peopleRules = [
    // Names must be capitalised, so only the role words ignore case.
    new RegExp(`\\b([Gg]uest|[Hh]ost|[Ss]peaker|[Ii]nterviewee|[Ii]nterviewer)\\s*(?:is|:|-|—)\\s*(${NAME})(?:\\s*,\\s*([^.;\\n]+))?`, 'g'),
    new RegExp(`(?:\\b[Mm]y name is|\\bI am|\\bI['’]m)\\s+(${NAME})(?:\\s*,\\s*([^.;\\n]+))?`, 'g'),
  ];
  for (const match of original.matchAll(peopleRules[0])) {
    settings.people.push({ name: match[2].trim(), role: (match[3] || '').trim(), kind: match[1].toLowerCase() });
  }
  for (const match of original.matchAll(peopleRules[1])) {
    settings.people.push({ name: match[1].trim(), role: (match[2] || '').trim(), kind: 'host' });
  }
  settings.people = settings.people.filter((person, index, all) =>
    all.findIndex((other) => other.name === person.name) === index).slice(0, 4);

  const quoted = original.match(/(?:cta|call to action|end (?:card )?(?:with|saying))\s*[:\-–]?\s*["“']([^"”']{3,80})["”']/i);
  const action = original.match(/\b((?:follow|subscribe to|visit|book|call|join|dm|message)\b[^.,;!\n"]{2,60})/i);
  if (quoted) settings.cta = quoted[1].trim();
  else if (action) settings.cta = action[1].trim().replace(/^./, (letter) => letter.toUpperCase());

  return settings;
}

// --- Words -------------------------------------------------------------------

const STOPWORDS = new Set(('a an and are as at be been but by can could did do does doing for from had has have he her '
  + 'here him his how i if in into is it its just like me more most my no not now of on one or our out over really '
  + 'so some such than that the their them then there these they this those to too up us very was we were what when '
  + 'where which while who why will with would you your yes yeah okay ok gonna going got get thing things know mean '
  + 'think say said actually basically right well also about because people lot something kind sort want every '
  + 'today talk talking last year years time way much many make made take need needs come comes still even back '
  + 'good great new first other only same today day week let lets look see seen said tell told').split(' '));

export const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'erm', 'er', 'ah', 'ahh', 'hmm', 'mm', 'mhm', 'eh']);

export const normalize = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, '');
const endsSentence = (text) => /[.!?]["')\]]?$/.test(String(text || '').trim());

/** The meaningful words of a text, for matching topics and picking key phrases. */
export function keywords(text) {
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}%]+/u)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word) && !FILLERS.has(word));
}

// --- What to cut -------------------------------------------------------------------

export const FRAME = 0.02; // seconds per loudness frame

/** Loudness (RMS) of each 20 ms of the 16 kHz speech sound. */
export function frameLevels(samples, rate = 16000) {
  const size = Math.round(FRAME * rate);
  const levels = new Float32Array(Math.floor(samples.length / size));
  for (let frame = 0; frame < levels.length; frame += 1) {
    let sum = 0;
    for (let index = frame * size; index < (frame + 1) * size; index += 1) sum += samples[index] * samples[index];
    levels[frame] = Math.sqrt(sum / size);
  }
  return levels;
}

function percentile(values, fraction) {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0;
}

/**
 * Stretches of silence longer than minPause, minus a little breathing room at
 * each side so speech never sounds clipped. The silence level adapts to the
 * recording: a noisy room has a higher floor than a studio.
 */
export function findPauses(levels, { minPause = 0.6, keep = 0.12 } = {}) {
  if (!levels.length) return [];
  const floor = percentile(levels, 0.1);
  const loud = percentile(levels, 0.9);
  const threshold = Math.max(0.003, floor + 0.12 * (loud - floor));
  const pauses = [];
  let runStart = null;
  for (let frame = 0; frame <= levels.length; frame += 1) {
    const quiet = frame < levels.length && levels[frame] < threshold;
    if (quiet && runStart === null) runStart = frame;
    if (!quiet && runStart !== null) {
      const start = runStart * FRAME;
      const end = frame * FRAME;
      if (end - start >= minPause) pauses.push({ start: start + keep, end: end - keep });
      runStart = null;
    }
  }
  return pauses;
}

/** "Um", "uh" and the like, and stutters ("I I think"): the first of a doubled word goes. */
export function findFillers(words, { fillers = true, stutters = true } = {}) {
  const ranges = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const next = words[index + 1];
    const plain = normalize(word.text);
    const isFiller = fillers && FILLERS.has(plain);
    // A word that ends a sentence and starts the next ("...leadership. Leadership is") is not a stutter.
    const isStutter = stutters && next && plain && plain.length < 12 && !endsSentence(word.text)
      && plain === normalize(next.text);
    if (!isFiller && !isStutter) continue;
    const end = next ? Math.min(next.start, word.end + 0.08) : word.end;
    if (end > word.start) ranges.push({ start: word.start, end });
  }
  return ranges;
}

/** Everything the clean-up removes, merged and sorted. */
export function cleanupCuts({ levels, words, wordLevel }, settings) {
  const ranges = [];
  if (settings.removePauses && levels) ranges.push(...findPauses(levels));
  // Filler timings are only trustworthy with real word timings.
  if (settings.removeFillers && wordLevel) ranges.push(...findFillers(words));
  ranges.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 0.05) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged.filter((range) => range.end - range.start >= 0.08);
}

const insideAny = (time, ranges) => ranges.some((range) => time >= range.start && time < range.end);

/** Caption lines for a stretch of the video, without the words the clean-up removed. */
export function captionSegments(segments, from, to, cuts) {
  const result = [];
  for (const segment of segments) {
    if (segment.end <= from || segment.start >= to) continue;
    const words = segment.words.filter((word) => {
      const middle = (word.start + word.end) / 2;
      return middle >= from && middle < to && !insideAny(middle, cuts) && !FILLERS.has(normalize(word.text));
    });
    if (!words.length) continue;
    result.push({ start: words[0].start, end: words[words.length - 1].end, text: words.map((word) => word.text).join(' '), words });
  }
  return result;
}

// --- Finding the best moments -------------------------------------------------------

/** Group transcript lines into blocks of about `target` seconds, for the AI to rate. */
export function blocksFrom(units, target = 45) {
  const blocks = [];
  let current = null;
  units.forEach((unit, index) => {
    if (!current) current = { start: unit.start, end: unit.end, first: index, last: index, text: '' };
    current.end = unit.end;
    current.last = index;
    current.text += (current.text ? ' ' : '') + unit.text;
    if (current.end - current.start >= target) { blocks.push(current); current = null; }
  });
  if (current) blocks.push(current);
  return blocks;
}

/**
 * Every stretch that could be a clip: it starts where a sentence starts, ends
 * where one ends, and runs between min and max seconds.
 */
export function candidateWindows(units, { min = 20, max = 60 } = {}) {
  const build = (needSentenceEnds) => {
    const windows = [];
    for (let first = 0; first < units.length; first += 1) {
      const startsClean = first === 0
        || endsSentence(units[first - 1].text)
        || units[first].start - units[first - 1].end > 0.9;
      if (needSentenceEnds && !startsClean) continue;
      for (let last = first; last < units.length; last += 1) {
        const length = units[last].end - units[first].start;
        if (length > max) break;
        if (length >= min && (!needSentenceEnds || endsSentence(units[last].text) || last === units.length - 1)) {
          windows.push({ start: units[first].start, end: units[last].end, first, last });
        }
      }
    }
    return windows;
  };
  let windows = build(true);
  if (!windows.length) windows = build(false); // a transcript without punctuation
  if (!windows.length && units.length) {
    // Shorter than the shortest clip: the whole thing is the one candidate.
    windows = [{ start: units[0].start, end: units[units.length - 1].end, first: 0, last: units.length - 1 }];
  }
  return windows;
}

const windowText = (units, window) => units.slice(window.first, window.last + 1).map((unit) => unit.text).join(' ');

/**
 * A plain 0-10 score for a window, used alone without the AI and blended with
 * the AI's view when it is there: on-topic words, lively delivery, complete
 * sentences, few fillers.
 */
export function heuristicScore(units, window, topicWords = []) {
  const text = windowText(units, window);
  const words = text.split(/\s+/).filter(Boolean);
  const length = Math.max(1, window.end - window.start);
  const pace = clamp((words.length / length - 1.6) / 1.4, 0, 1);
  const fillers = words.filter((word) => FILLERS.has(normalize(word))).length / Math.max(1, words.length);
  const found = keywords(text);
  const topicHits = topicWords.length ? found.filter((word) => topicWords.includes(word)).length : 0;
  const topic = topicWords.length ? clamp(topicHits / 3, 0, 1) : 0.5;
  const complete = endsSentence(units[window.last].text) ? 1 : 0.4;
  const richness = clamp(new Set(found).size / Math.max(8, words.length * 0.45), 0, 1);
  return clamp(10 * (0.35 * topic + 0.2 * pace + 0.2 * complete + 0.25 * richness) - 10 * fillers, 0, 10);
}

/** Blend the AI's block ratings into each window: overlap-weighted average. */
export function aiWindowScore(window, blocks, blockScores) {
  let total = 0;
  let weight = 0;
  blocks.forEach((block, index) => {
    const score = blockScores[index];
    if (score === null || score === undefined) return;
    const overlap = Math.min(block.end, window.end) - Math.max(block.start, window.start);
    if (overlap > 0) { total += score * overlap; weight += overlap; }
  });
  return weight ? total / weight : null;
}

export function scoreWindows(units, windows, { blocks = [], blockScores = [], topicWords = [] } = {}) {
  return windows.map((window) => {
    const plain = heuristicScore(units, window, topicWords);
    const ai = blockScores.length ? aiWindowScore(window, blocks, blockScores) : null;
    return { ...window, score: ai === null ? plain : 0.7 * ai + 0.3 * plain };
  });
}

/** The best windows that don't overlap, in the order they happen. */
export function pickClips(scored, count, gap = 2) {
  const chosen = [];
  for (const window of [...scored].sort((a, b) => b.score - a.score)) {
    if (chosen.length >= count) break;
    if (chosen.every((other) => window.end + gap <= other.start || window.start >= other.end + gap)) chosen.push(window);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

// --- Words for graphics ----------------------------------------------------------------

/** A short opening line for a clip when the AI isn't there: its first sentence, trimmed. */
export function fallbackTitle(text, maxWords = 8) {
  const sentence = String(text || '').split(/(?<=[.!?])\s+/)[0] || '';
  const words = sentence.split(/\s+/).filter((word) => word && !FILLERS.has(normalize(word)));
  const title = words.slice(0, maxWords).join(' ').replace(/[,;:]$/, '');
  return words.length > maxWords ? `${title}…` : title;
}

/**
 * Where a phrase is said: the start time of its first word, or null. Matching
 * ignores case and punctuation, so the AI's copy of a phrase still lines up.
 */
export function locatePhrase(words, phrase, from = -Infinity, to = Infinity) {
  const target = String(phrase || '').split(/\s+/).map(normalize).filter(Boolean);
  if (!target.length) return null;
  for (let index = 0; index + target.length <= words.length; index += 1) {
    if (words[index].start < from || words[index].start >= to) continue;
    if (target.every((part, offset) => normalize(words[index + offset].text) === part)) return words[index].start;
  }
  return null;
}

/**
 * Key phrases to pop up when the AI isn't there: numbers, names and the
 * strongest on-topic words, spread at least four seconds apart.
 */
export function fallbackPhrases(words, from, to, topicWords = [], count = 4) {
  const candidates = [];
  words.forEach((word, index) => {
    if (word.start < from || word.start >= to) return;
    const plain = normalize(word.text);
    if (!plain || STOPWORDS.has(plain) || FILLERS.has(plain)) return;
    const previous = words[index - 1];
    const isName = /^[A-Z]/.test(word.text) && previous && !endsSentence(previous.text);
    let weight = 0;
    if (/\d/.test(plain)) weight += 3;
    if (topicWords.includes(plain)) weight += 3;
    if (isName) weight += 2;
    if (plain.length >= 8) weight += 1.5;
    if (weight > 0) candidates.push({ text: word.text.replace(/[^\p{L}\p{N}%'’-]/gu, ''), time: word.start, weight });
  });
  const chosen = [];
  const seen = new Set();
  for (const candidate of candidates.sort((a, b) => b.weight - a.weight)) {
    if (chosen.length >= count) break;
    const key = normalize(candidate.text);
    if (seen.has(key) || chosen.some((other) => Math.abs(other.time - candidate.time) < 4)) continue;
    seen.add(key);
    chosen.push(candidate);
  }
  return chosen.sort((a, b) => a.time - b.time);
}

/** Chapters for the full episode: about every three minutes, at a block boundary. */
export function chaptersFrom(blocks, every = 180) {
  const chapters = [];
  let current = null;
  for (const block of blocks) {
    if (!current || block.start - current.start >= every) {
      current = { start: block.start, end: block.end, text: '' };
      chapters.push(current);
    }
    current.end = block.end;
    current.text += (current.text ? ' ' : '') + block.text;
  }
  return chapters;
}

export function fallbackChapterTitle(text) {
  const counts = new Map();
  for (const word of keywords(text)) counts.set(word, (counts.get(word) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([word]) => word[0].toUpperCase() + word.slice(1));
  return top.join(' & ') || 'Part';
}

/** Text without "um"s and stutters, as the clean edit sounds. */
export function cleanText(text) {
  const words = String(text || '').split(/\s+/).filter((word) => word && !FILLERS.has(normalize(word)));
  const kept = words.filter((word, index) => !(index + 1 < words.length && normalize(word) && !endsSentence(word)
    && normalize(word) === normalize(words[index + 1])));
  return kept.join(' ').replace(/^./, (letter) => letter.toUpperCase());
}

/** Title, description and hashtags when the AI isn't there. */
export function fallbackPost(units, chapters, topicWords) {
  const all = cleanText(units.map((unit) => unit.text).join(' '));
  const counts = new Map();
  for (const word of keywords(all)) counts.set(word, (counts.get(word) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([word]) => word);
  // Hashtags from the words said most -- at least twice -- after the topic's own words.
  const repeated = top.filter((word) => counts.get(word) >= 2);
  const tags = [...new Set([...topicWords, ...repeated])].slice(0, 5).map((word) => `#${word[0].toUpperCase()}${word.slice(1)}`);
  const sentences = all.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.split(/\s+/).length > 5);
  return {
    title: fallbackTitle(sentences[0] || all, 10),
    description: sentences.slice(0, 3).join(' '),
    hashtags: [...tags, '#Podcast'],
  };
}

export function formatChapterTime(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

// --- Building the edits ----------------------------------------------------------------

/** Brand-kit pieces in use, added to a project's media list once each. */
function useMedia(project, media) {
  if (media && !project.media.includes(media)) project.media.push(media);
  return media;
}

function placeLogo(project, kit, settings, total) {
  if (!settings.logo) return;
  if (kit.logo) {
    useMedia(project, kit.logo);
    addClip(project, {
      kind: 'image', media: kit.logo, start: 0, length: total, layout: settings.logoPosition,
      size: 0.14, transitionIn: 'none', transitionOut: 'none',
    });
  } else {
    project.logo = 'speakpower';
  }
}

function placeOverlay(project, kit, total) {
  if (!kit.overlay) return;
  useMedia(project, kit.overlay);
  addClip(project, { kind: 'image', media: kit.overlay, start: 0, length: total, layout: 'full', transitionIn: 'none', transitionOut: 'none' });
}

/** The user's own intro (over the opening) and end card or the designed one (after the end). */
function placeIntroAndEnd(project, kit, settings, total, introLength = 2.5) {
  if (kit.intro) {
    useMedia(project, kit.intro);
    const length = kit.intro.kind === 'video' ? Math.min(kit.intro.duration, total) : Math.min(introLength, total / 3);
    const clip = addClip(project, { kind: kit.intro.kind, media: kit.intro, start: 0, length, layout: 'full', transitionIn: 'none', transitionOut: 'fade' });
    if (clip && kit.intro.kind === 'video') clip.out = clip.in + length;
  }
  if (kit.outro) {
    useMedia(project, kit.outro);
    const clip = addClip(project, { kind: kit.outro.kind, media: kit.outro, start: total, length: 3, layout: 'full', transitionIn: 'fade', transitionOut: 'none' });
    if (clip && kit.outro.kind === 'video') clip.out = clip.in + Math.min(kit.outro.duration, 8);
  } else if (settings.endCard) {
    // The client's own logo on their end card when the brand kit has one.
    const logo = kit.logo?.kind === 'image' ? useMedia(project, kit.logo) : null;
    addClip(project, {
      kind: 'card', style: 'end', media: logo, start: total, length: 3, title: settings.cta,
      subtitle: settings.handle || '', transitionIn: 'fade', transitionOut: 'none',
    });
  }
}

/**
 * Pictures from the brand kit, shown full screen when a word in their file
 * name is said ("teams.jpg" when someone says "teams"). Placed before any
 * titles, so they take the lower tracks and titles stay on top, and never
 * before `notBefore` seconds of the finished video (the opening card).
 */
function placePictures(project, kit, words, from, to, notBefore = 0) {
  const used = [];
  for (const picture of kit.pictures || []) {
    const names = new Set(keywords(picture.name.replace(/\.[^.]+$/, '')));
    const spoken = words.find((word) => word.start >= from && word.start < to
      && names.has(normalize(word.text)) && sourceToOutput(project, word.start) >= notBefore);
    if (!spoken) continue;
    useMedia(project, picture);
    const at = sourceToOutput(project, spoken.start);
    if (addClip(project, { kind: 'image', media: picture, start: at, length: 3, layout: 'full', transitionIn: 'fade', transitionOut: 'fade' })) {
      used.push(picture.name);
    }
  }
  return used;
}

function placeNames(project, people, at, gap = 5) {
  people.forEach((person, index) => {
    addClip(project, {
      kind: 'text', start: at + index * gap, length: 4, title: person.name, subtitle: person.role,
      transitionIn: 'slide', transitionOut: 'fade',
    });
  });
}

function baseProject(file, meta, settings, format) {
  const project = createProject(file, meta.duration, meta.width, meta.height);
  project.format = format;
  project.framing = settings.framing;
  project.logo = 'none';
  return project;
}

/**
 * The full episode: the whole recording, cleaned, with chapter cards, name
 * titles, logo, captions and an end card.
 *
 * @param input  { file, meta, segments, words, cuts, settings, kit, title, chapters: [{start, title}] }
 */
export function buildEpisode({ file, meta, segments, words, cuts, settings, kit = {}, title = '', chapters = [] }) {
  const project = baseProject(file, meta, settings, settings.episodeFormat);
  for (const cut of cuts) addCut(project, cut.start, cut.end);
  project.captions = { enabled: settings.captions, segments: captionSegments(segments, 0, meta.duration, cuts) };
  const total = outputDuration(project);
  const titleLength = title ? Math.min(3, total / 4) : 0;
  const pictures = placePictures(project, kit, words, 0, meta.duration, titleLength);

  if (title) {
    addClip(project, { kind: 'card', style: 'chapter', start: 0, length: titleLength, title, subtitle: settings.show || 'Episode', transitionIn: 'none', transitionOut: 'fade' });
  }
  chapters.slice(1).forEach((chapter, index) => {
    const at = sourceToOutput(project, chapter.start);
    addClip(project, { kind: 'card', style: 'chapter', start: at, length: 2.2, title: chapter.title, subtitle: `Chapter ${index + 2}`, transitionIn: 'fade', transitionOut: 'fade' });
  });
  placeNames(project, settings.people, Math.min(4, total / 3));
  placeOverlay(project, kit, total);
  placeLogo(project, kit, settings, total);
  placeIntroAndEnd(project, kit, settings, total);
  return { project, pictures };
}

/**
 * One short clip: the chosen stretch, cleaned, reframed for social, with a
 * hook card, the hook as its headline, pop-up key phrases, a progress bar,
 * the speaker's name, logo and an end card.
 *
 * @param input  { file, meta, segments, words, cuts, window, hook, phrases: [{text, time}], settings, kit }
 */
export function buildClip({ file, meta, segments, words, cuts, window, hook, phrases = [], settings, kit = {} }) {
  const project = baseProject(file, meta, settings, settings.clipFormat);
  setTrim(project, window.start, window.end);
  for (const cut of cuts) {
    if (cut.end > window.start && cut.start < window.end) addCut(project, cut.start, cut.end);
  }
  project.captions = { enabled: settings.captions, segments: captionSegments(segments, window.start, window.end, cuts) };
  const total = outputDuration(project);

  const hookLength = Math.min(2.2, total * 0.25);
  const pictures = placePictures(project, kit, words, window.start, window.end, hook ? hookLength + 0.2 : 0);
  if (hook) {
    addClip(project, { kind: 'card', style: 'hook', start: 0, length: hookLength, title: hook, transitionIn: 'none', transitionOut: 'fade', transitionDuration: 0.35 });
    project.headline = hook;
    project.headlineFrom = hookLength;
    project.captionsFrom = hookLength;
  }
  if (settings.progress) {
    addClip(project, { kind: 'progress', start: 0, length: total, transitionIn: 'none', transitionOut: 'none' });
  }
  if (settings.callouts) {
    for (const phrase of phrases) {
      if (phrase.time === null || phrase.time < window.start || phrase.time >= window.end) continue;
      const at = sourceToOutput(project, phrase.time);
      if (at < hookLength + 0.2) continue; // not under the hook card
      addClip(project, { kind: 'callout', start: at, length: 1.4, title: phrase.text, transitionIn: 'zoom', transitionOut: 'fade', transitionDuration: 0.25 });
    }
  }
  placeNames(project, settings.people.slice(0, 1), hookLength + 0.4);
  placeOverlay(project, kit, total);
  placeLogo(project, kit, settings, total);
  placeIntroAndEnd(project, { ...kit, intro: null }, settings, total);
  return { project, pictures };
}
