/**
 * Members' transcription: the website's own Whisper (large-v3-turbo, the
 * Rehearsal Room's), far more accurate on names and accents than the small
 * model a browser can run.
 *
 *   startJob(seconds)        -> reserves one use: { job, chunkSeconds } (POST /video/start)
 *   transcribeRemote(...)    -> the sound in two-minute pieces, cut at quiet
 *                               moments, as 16 kHz mu-law WAV (the format the
 *                               Rehearsal Room already sends) -> timed words
 *   refundJob(job)           -> gives the use back if nothing could be heard
 *
 * Only the sound goes; the video never leaves the computer, and the Worker
 * keeps neither the sound nor the words.
 */

import { SPEECH_RATE, isSilent, planWindows } from './speech.js';
import { segmentsFromLines, segmentsFromWords } from './captions.js';

const account = () => window.SPAccount;

/** Is a member signed in, with the website's service connected? */
export function memberSession() {
  const A = account();
  return Boolean(window.SP && window.SP.connected && A && A.session());
}

export function startJob(seconds) {
  return account().call('/video/start', {
    seconds: Math.ceil(seconds),
    anonId: window.SP && window.SP.anonId,
    page: location.pathname,
  });
}

export function refundJob(job) {
  return account().call('/video/refund', { job }).catch(() => ({ refunded: false }));
}

/** G.711 mu-law, as rehearse.js encodes it. */
function muLaw(x) {
  const s = Math.max(-1, Math.min(1, x)) * 32767;
  const sign = s < 0 ? 0x80 : 0;
  const v = Math.min(32635, Math.abs(s)) + 132;
  let exp = 7;
  for (let mask = 0x4000; (v & mask) === 0 && exp > 0; mask >>= 1) exp -= 1;
  return ~(sign | (exp << 4) | ((v >> (exp + 3)) & 0x0f)) & 0xff;
}

/** 16 kHz mono mu-law WAV: 16 KB a second, so two minutes is under 2 MB. */
export function muLawWav(pcm) {
  const out = new DataView(new ArrayBuffer(44 + pcm.length));
  const write = (offset, text) => { for (let i = 0; i < text.length; i += 1) out.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF'); out.setUint32(4, 36 + pcm.length, true); write(8, 'WAVE');
  write(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 7, true); out.setUint16(22, 1, true);
  out.setUint32(24, SPEECH_RATE, true); out.setUint32(28, SPEECH_RATE, true); out.setUint16(32, 1, true); out.setUint16(34, 8, true);
  write(36, 'data'); out.setUint32(40, pcm.length, true);
  for (let i = 0; i < pcm.length; i += 1) out.setUint8(44 + i, muLaw(pcm[i]));
  return new Uint8Array(out.buffer);
}

function base64(bytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes]));
  });
}

/**
 * Transcribe through the Worker. Each piece is retried once; if a piece still
 * fails, this throws and the caller finishes in the browser instead.
 *
 * @returns { segments, wordLevel, heard }  heard: how many pieces the Worker heard
 */
export async function transcribeRemote(samples, { job, chunkSeconds = 120, language = 'english', onProgress = () => {}, signal } = {}) {
  // Pieces end at the quietest moment in the last 20 seconds before the limit.
  const windows = planWindows(samples, SPEECH_RATE, { min: Math.max(10, chunkSeconds - 20), max: chunkSeconds - 2 });
  const words = [];
  const lines = [];
  let heard = 0;
  for (let index = 0; index < windows.length; index += 1) {
    signal?.throwIfAborted();
    onProgress(index / windows.length);
    const { start, end } = windows[index];
    if (isSilent(samples, start, end)) continue;
    const audio = await base64(muLawWav(samples.subarray(start, end)));
    const offset = start / SPEECH_RATE;
    let reply = null;
    for (let attempt = 0; attempt < 2 && !reply; attempt += 1) {
      signal?.throwIfAborted();
      try {
        reply = await account().call('/video/transcribe', { job, index, audio, language });
      } catch (error) {
        // Out of edits or signed out mid-way is not worth a retry.
        if (attempt === 1 || [401, 402, 404, 410, 429].includes(error.status)) throw error;
      }
    }
    heard += 1;
    for (const word of reply.words || []) words.push({ text: word.text, start: word.start + offset, end: word.end + offset });
    for (const line of reply.lines || []) lines.push({ text: line.text, start: line.start + offset, end: line.end + offset });
  }
  onProgress(1);
  const wordLevel = !lines.length;
  const segments = wordLevel
    ? segmentsFromWords(words)
    : segmentsFromLines([...lines, ...segmentsFromWords(words).map(({ start, end, text }) => ({ start, end, text }))]
      .sort((a, b) => a.start - b.start));
  return { segments, wordLevel, heard };
}
