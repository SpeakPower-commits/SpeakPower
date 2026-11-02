/**
 * Turning a video's speech into timed captions, entirely in the browser.
 *
 *   1. Read the sound out of the video (Mediabunny, the same engine as export)
 *      and resample it to the 16 kHz mono Whisper expects.
 *   2. Split it into windows of under 30 seconds, cutting at the quietest
 *      moment near each boundary so no word is sliced in half.
 *   3. Send each window to a Web Worker running Whisper, so the page stays
 *      responsive, and turn the results into caption segments.
 *
 * Doing the windowing here, rather than leaving it to the library, gives a
 * real progress bar and lets silent stretches be skipped -- Whisper invents
 * words ("Thank you.") when given silence.
 */

import { loadMediabunny } from './exporter.js';
import { segmentsFromLines, segmentsFromWords } from './captions.js';

export const SPEECH_RATE = 16000;

export const MODELS = {
  quick: { id: 'Xenova/whisper-base', label: 'Quick', note: 'about 80 MB, one-time download' },
  accurate: { id: 'Xenova/whisper-small', label: 'Accurate', note: 'about 250 MB, one-time download' },
};

// Windowing. Whisper reads 30 s at a time; cutting a little earlier, at a
// quiet point, keeps words whole.
const WINDOW_MIN = 20;
const WINDOW_MAX = 29;
const FRAME_SECONDS = 0.02;
// Below this loudness (RMS) a whole window counts as silence and is skipped.
const SILENCE_RMS = 0.004;
// Sound is resampled in blocks of this length, keeping memory flat.
const RESAMPLE_BLOCK = 30;

function rms(samples, from, to) {
  let sum = 0;
  for (let index = from; index < to; index += 1) sum += samples[index] * samples[index];
  return Math.sqrt(sum / Math.max(1, to - from));
}

/**
 * Plan the windows: [{ start, end }] in samples, each under 30 s, each ending
 * at the quietest 20 ms found between WINDOW_MIN and WINDOW_MAX seconds in.
 */
export function planWindows(samples, rate = SPEECH_RATE, { min = WINDOW_MIN, max = WINDOW_MAX } = {}) {
  const windows = [];
  const frame = Math.round(FRAME_SECONDS * rate);
  let start = 0;
  while (start < samples.length) {
    const hardEnd = Math.min(samples.length, start + max * rate);
    if (hardEnd === samples.length) {
      windows.push({ start, end: hardEnd });
      break;
    }
    let cut = hardEnd;
    let quietest = Infinity;
    for (let position = start + min * rate; position + frame <= hardEnd; position += frame) {
      const level = rms(samples, position, position + frame);
      if (level < quietest) { quietest = level; cut = position + Math.floor(frame / 2); }
    }
    windows.push({ start, end: cut });
    start = cut;
  }
  return windows;
}

export function isSilent(samples, start, end) {
  return rms(samples, start, end) < SILENCE_RMS;
}

/** Mix a block of decoded buffers to mono and resample it with the browser's own resampler. */
async function resampleBlock(buffers, sourceRate) {
  const frames = buffers.reduce((total, buffer) => total + buffer.length, 0);
  const mono = new Float32Array(frames);
  let offset = 0;
  for (const buffer of buffers) {
    const channels = buffer.numberOfChannels;
    for (let channel = 0; channel < channels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < data.length; index += 1) mono[offset + index] += data[index] / channels;
    }
    offset += buffer.length;
  }
  const block = new AudioBuffer({ length: frames, numberOfChannels: 1, sampleRate: sourceRate });
  block.copyToChannel(mono, 0);

  // OfflineAudioContext resamples with a proper low-pass filter; naive
  // decimation would alias, which measurably hurts recognition.
  const context = new OfflineAudioContext(1, Math.max(1, Math.round((frames * SPEECH_RATE) / sourceRate)), SPEECH_RATE);
  const node = context.createBufferSource();
  node.buffer = block;
  node.connect(context.destination);
  node.start();
  return (await context.startRendering()).getChannelData(0);
}

/** The video's sound as 16 kHz mono samples. */
export async function extractSpeechAudio(file, { onProgress = () => {}, signal } = {}) {
  const mb = await loadMediabunny();
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(file) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('This video has no sound, so there is nothing to caption.');
    if (!(await track.canDecode())) throw new Error("This browser can't read this video's sound.");

    const duration = await input.computeDuration();
    const samples = new Float32Array(Math.ceil(duration * SPEECH_RATE) + SPEECH_RATE);
    const sourceRate = track.sampleRate;
    const sink = new mb.AudioBufferSink(track);

    let pending = [];
    let pendingStart = null;
    let pendingSeconds = 0;
    const flush = async () => {
      if (!pending.length) return;
      const resampled = await resampleBlock(pending, sourceRate);
      // Place each block by its own timestamp, so a gap in the source stays a
      // gap and captions cannot drift out of sync over a long recording.
      const at = Math.max(0, Math.round(pendingStart * SPEECH_RATE));
      samples.set(resampled.subarray(0, Math.max(0, Math.min(resampled.length, samples.length - at))), at);
      pending = [];
      pendingStart = null;
      pendingSeconds = 0;
    };

    for await (const { buffer, timestamp } of sink.buffers()) {
      signal?.throwIfAborted();
      if (pendingStart === null) pendingStart = timestamp;
      pending.push(buffer);
      pendingSeconds += buffer.duration;
      if (pendingSeconds >= RESAMPLE_BLOCK) {
        await flush();
        onProgress(Math.min(1, (timestamp + buffer.duration) / duration));
      }
    }
    await flush();
    onProgress(1);
    return samples.subarray(0, Math.ceil(duration * SPEECH_RATE));
  } finally {
    input.dispose();
  }
}

/** Run the worker until it answers one request, or fail cleanly. */
function request(worker, message, transfer, onMessage, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.type === 'error') reject(new Error(data.message));
      else if (data.type === 'ready' || data.type === 'result') resolve(data);
      else onMessage?.(data);
    };
    worker.onerror = (event) => reject(new Error(event.message || 'The speech worker stopped.'));
    worker.postMessage(message, transfer);
  });
}

/**
 * Transcribe a video file into caption segments.
 *
 * @param file      the video (a File)
 * @param options   { model: 'quick'|'accurate', language, onProgress(stage, fraction), signal }
 * @returns         { segments, wordLevel, samples } -- samples: the 16 kHz mono sound, for finding pauses
 */
export async function transcribeFile(file, { model = 'accurate', language = 'english', onProgress = () => {}, signal } = {}) {
  onProgress('Reading the sound', 0);
  const samples = await extractSpeechAudio(file, {
    signal,
    onProgress: (fraction) => onProgress('Reading the sound', fraction),
  });
  return { ...(await transcribeSamples(samples, { model, language, onProgress, signal })), samples };
}

/** Transcribe 16 kHz sound already read from a video, with Whisper in this browser. */
export async function transcribeSamples(samples, { model = 'accurate', language = 'english', onProgress = () => {}, signal } = {}) {
  const worker = new Worker(new URL('./transcribe-worker.js', import.meta.url), { type: 'module' });
  signal?.addEventListener('abort', () => worker.terminate(), { once: true });
  try {
    onProgress('Getting the speech model ready', 0);
    await request(worker, { type: 'load', model: MODELS[model]?.id || MODELS.accurate.id }, [], (data) => {
      if (data.type === 'download' && data.total) {
        onProgress('Downloading the speech model (first time only)', data.loaded / data.total);
      }
    }, signal);

    const windows = planWindows(samples);
    const words = [];
    const lines = [];
    let wordLevel = true;
    for (let index = 0; index < windows.length; index += 1) {
      signal?.throwIfAborted();
      const { start, end } = windows[index];
      onProgress('Listening', index / windows.length);
      if (isSilent(samples, start, end)) continue;

      const audio = samples.slice(start, end); // a copy, so it can be transferred
      const offset = start / SPEECH_RATE;
      const reply = await request(worker, { type: 'transcribe', audio, language }, [audio.buffer], null, signal);
      wordLevel = wordLevel && reply.wordLevel;
      const windowEnd = (end - start) / SPEECH_RATE;
      for (const chunk of reply.chunks) {
        // The last chunk of a window can come back without an end time.
        const chunkStart = chunk.start ?? 0;
        const chunkEnd = chunk.end ?? Math.min(windowEnd, chunkStart + 0.4);
        const timed = { text: chunk.text, start: offset + chunkStart, end: offset + Math.max(chunkStart, chunkEnd) };
        (reply.wordLevel ? words : lines).push(timed);
      }
    }
    onProgress('Listening', 1);

    // If any window fell back to line timings, use lines for the whole video
    // so the captions behave consistently.
    const segments = wordLevel
      ? segmentsFromWords(words)
      : segmentsFromLines([...lines, ...segmentsFromWords(words).map(({ start, end, text }) => ({ start, end, text }))]
        .sort((a, b) => a.start - b.start));
    return { segments, wordLevel };
  } finally {
    worker.terminate();
  }
}
