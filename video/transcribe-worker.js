/**
 * Whisper, running in a Web Worker so the editor stays responsive while it
 * listens. Driven by speech.js:
 *
 *   { type: 'load', model }                  -> 'download' progress..., then 'ready'
 *   { type: 'transcribe', audio, language }  -> { type: 'result', chunks, wordLevel }
 *   any failure                              -> { type: 'error', message }
 *
 * The model downloads from Hugging Face once and is then kept in the
 * browser's cache, so later runs start from disk.
 */

// Pinned to an exact release at least two weeks old.
//
// transformers.min.js, NOT transformers.web.min.js: the .web build imports
// "onnxruntime-web/webgpu" as a bare module name, which only resolves behind a
// bundler and fails outright in a browser. This build bundles the runtime.
const TRANSFORMERS_URL =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';

let transcriber = null;
// Word timings drive the word-by-word highlight. A model exported without the
// data they need fails on the first try; from then on, line timings are used
// and speech.js spreads each line's words across its time.
let wordLevel = true;

const post = (message) => self.postMessage(message);

function explain(error, stage) {
  const text = String(error?.message || error);
  if (/fetch|network|Failed to load|NetworkError|ERR_/i.test(text)) {
    return stage === 'load'
      ? "Couldn't download the speech model. The network may be blocking huggingface.co or " +
        'cdn.jsdelivr.net -- ask IT to allow both. You can still import an .srt file instead.'
      : `Network problem while listening: ${text}`;
  }
  return text;
}

async function load(model) {
  let library;
  try {
    library = await import(TRANSFORMERS_URL);
  } catch (error) {
    throw new Error(explain(error, 'load'));
  }
  const { pipeline, env } = library;
  env.allowLocalModels = false;

  try {
    // q8: an 8-bit model is about a quarter of the full download and runs on
    // any PC's processor, with little loss in accuracy for speech.
    transcriber = await pipeline('automatic-speech-recognition', model, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (event) => {
        if (event.status === 'progress' && event.total) {
          post({ type: 'download', file: event.file, loaded: event.loaded, total: event.total });
        }
      },
    });
  } catch (error) {
    throw new Error(explain(error, 'load'));
  }
}

async function transcribe(audio, language) {
  const options = { task: 'transcribe', language: language || null };
  let output;
  if (wordLevel) {
    try {
      output = await transcriber(audio, { ...options, return_timestamps: 'word' });
    } catch (error) {
      wordLevel = false;
    }
  }
  if (!output) output = await transcriber(audio, { ...options, return_timestamps: true });

  const chunks = (output.chunks || []).map((chunk) => ({
    text: String(chunk.text || '').trim(),
    start: chunk.timestamp?.[0] ?? null,
    end: chunk.timestamp?.[1] ?? null,
  })).filter((chunk) => chunk.text);

  // Some outputs carry text without chunks; keep it rather than lose it.
  if (!chunks.length && output.text?.trim()) {
    chunks.push({ text: output.text.trim(), start: 0, end: audio.length / 16000 });
    return { chunks, wordLevel: false };
  }
  return { chunks, wordLevel };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      if (!transcriber) await load(data.model);
      post({ type: 'ready' });
    } else if (data.type === 'transcribe') {
      if (!transcriber) throw new Error('The speech model is not loaded.');
      const result = await transcribe(data.audio, data.language);
      post({ type: 'result', ...result });
    }
  } catch (error) {
    post({ type: 'error', message: explain(error, data.type) });
  }
};
