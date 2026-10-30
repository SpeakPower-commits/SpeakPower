/**
 * Talking to the free AI (brain-worker.js): what to ask it, and how to read
 * its answers.
 *
 * A small model is asked small, concrete questions -- "rate this passage",
 * "write a title" -- with a fixed answer format, and answers are read
 * forgivingly (a stray word or missing label doesn't lose the answer). Any
 * question that fails or times out returns null, and the automatic editor
 * uses its plain fallback for that one decision.
 */

const SYSTEM =
  'You are a senior video editor at SpeakPower, a communications company. You turn raw podcast and ' +
  'interview recordings into engaging social media videos. Answer in exactly the format asked, with no extra text.';

const MAX_PASSAGE = 1400; // characters of transcript per question: keeps each answer quick
const TIMEOUT_MS = 180000;

const clip = (text, size = MAX_PASSAGE) => {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > size ? `${value.slice(0, size)}…` : value;
};

// --- Reading answers (exported for tests) ---------------------------------------

/** "SCORE: 8", "8/10", "I'd say 7." -> 8, 8, 7. */
export function parseScore(reply) {
  const labelled = String(reply || '').match(/score\s*[:=-]?\s*(\d{1,2})/i);
  const any = String(reply || '').match(/\b(\d{1,2})\b/);
  const value = Number((labelled || any)?.[1]);
  return Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
}

const unquote = (text) => String(text || '').trim().replace(/^["'“”‘’*\s]+|["'“”‘’*\s]+$/g, '');

function field(reply, label) {
  const match = String(reply || '').match(new RegExp(`${label}\\s*[:：-]\\s*(.+)`, 'i'));
  return match ? match[1].trim() : '';
}

/** TITLE: ... / PHRASES: a | b | c */
export function parseHook(reply) {
  let title = unquote(field(reply, 'title'));
  if (!title) title = unquote(String(reply || '').split('\n')[0]);
  const phrases = field(reply, 'phrases').split(/\s*[|;]\s*|\s*,\s*(?=\S)/)
    .map(unquote).filter((phrase) => phrase && phrase.split(/\s+/).length <= 4);
  return { title: title.split(/\s+/).slice(0, 10).join(' '), phrases: phrases.slice(0, 5) };
}

/** TITLE / DESCRIPTION / HASHTAGS */
export function parsePost(reply) {
  const title = unquote(field(reply, 'title'));
  const description = unquote(field(reply, 'description'));
  const hashtags = (field(reply, 'hashtags').match(/#?[\p{L}\p{N}_]+/gu) || [])
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`)).slice(0, 8);
  return title || description ? { title, description, hashtags } : null;
}

export function parseChapter(reply) {
  const title = unquote(field(reply, 'chapter') || String(reply || '').split('\n')[0]);
  return title ? title.split(/\s+/).slice(0, 6).join(' ') : null;
}

// --- The client ---------------------------------------------------------------------

export class Brain {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.device = null;
    this.error = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  /**
   * Load the model. Resolves true when ready, false when it can't be used
   * (network blocked, too little memory); never throws.
   */
  async load(onProgress = () => {}, signal) {
    try {
      this.worker = new Worker(new URL('./brain-worker.js', import.meta.url), { type: 'module' });
      signal?.addEventListener('abort', () => this.dispose(), { once: true });
      await new Promise((resolve, reject) => {
        this.worker.onmessage = ({ data }) => {
          if (data.type === 'download' && data.total) onProgress(data.loaded / data.total);
          else if (data.type === 'ready') { this.device = data.device; resolve(); }
          else if (data.type === 'error') reject(new Error(data.message));
        };
        this.worker.onerror = (event) => reject(new Error(event.message || 'The AI stopped.'));
        this.worker.postMessage({ type: 'load' });
      });
      this.worker.onmessage = ({ data }) => this.settle(data);
      this.worker.onerror = (event) => this.failAll(new Error(event.message || 'The AI stopped.'));
      this.ready = true;
      return true;
    } catch (error) {
      this.error = error.message;
      this.dispose();
      return false;
    }
  }

  settle(data) {
    const waiting = this.pending.get(data.id);
    if (!waiting) return;
    this.pending.delete(data.id);
    clearTimeout(waiting.timer);
    if (data.type === 'answer') waiting.resolve(data.text);
    else waiting.resolve(null);
  }

  failAll() {
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.resolve(null); }
    this.pending.clear();
    this.ready = false;
  }

  /** One question; the answer text, or null on any failure. */
  ask(user, maxTokens = 48) {
    if (!this.ready) return Promise.resolve(null);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      this.worker.postMessage({ type: 'ask', id, system: SYSTEM, user, maxTokens });
    });
  }

  async score(passage, instruction) {
    const reply = await this.ask(
      `The client asked for: "${clip(instruction, 300)}"\n\n` +
      `Passage from the recording:\n"""${clip(passage)}"""\n\n` +
      'How good is this passage as a stand-alone social media clip for that request? Consider whether it ' +
      'matches the request, has a strong point or story, and makes sense without context. ' +
      'Reply with one line: SCORE: <0-10>',
      8,
    );
    return reply === null ? null : parseScore(reply);
  }

  async hook(passage, instruction) {
    const reply = await this.ask(
      `The client asked for: "${clip(instruction, 300)}"\n\n` +
      `This is a short clip's transcript:\n"""${clip(passage)}"""\n\n` +
      'Write a punchy on-screen title for the clip (at most 8 words, no hashtags, no emojis), and copy up to ' +
      '4 short key phrases (1-3 words each) EXACTLY as they appear in the transcript, for pop-up graphics.\n' +
      'Reply in exactly two lines:\nTITLE: <title>\nPHRASES: <phrase> | <phrase> | <phrase>',
      64,
    );
    return reply === null ? null : parseHook(reply);
  }

  async chapter(passage) {
    const reply = await this.ask(
      `Transcript of one part of a podcast:\n"""${clip(passage, 1000)}"""\n\n` +
      'Give this part a chapter title of 2 to 5 words. Reply with one line: CHAPTER: <title>',
      16,
    );
    return reply === null ? null : parseChapter(reply);
  }

  async post(gist, instruction) {
    const reply = await this.ask(
      `The client asked for: "${clip(instruction, 300)}"\n\n` +
      `Main points of the recording:\n"""${clip(gist, 1800)}"""\n\n` +
      'Write the text for posting the video online: a catchy title (at most 12 words), a description of 2-3 ' +
      'sentences, and 5 relevant hashtags.\nReply in exactly three lines:\n' +
      'TITLE: <title>\nDESCRIPTION: <description>\nHASHTAGS: #one #two #three #four #five',
      180,
    );
    return reply === null ? null : parsePost(reply);
  }

  dispose() {
    this.failAll();
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  }
}
