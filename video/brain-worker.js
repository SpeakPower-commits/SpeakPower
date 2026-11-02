/**
 * The automatic editor's free AI: a small language model running in a Web
 * Worker, on this computer. Driven by brain.js:
 *
 *   { type: 'load' }                              -> 'download' progress..., then { type: 'ready', device }
 *   { type: 'ask', id, system, user, maxTokens }  -> { type: 'answer', id, text }
 *   any failure                                   -> { type: 'error', id?, message }
 *
 * The model downloads from Hugging Face once and is then kept in the
 * browser's cache. It uses the graphics card (WebGPU) when the PC has one the
 * browser can use, and the processor otherwise.
 */

// Same pinned build as the speech worker (transcribe-worker.js explains why
// it must be transformers.min.js).
const TRANSFORMERS_URL =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';

// Qwen2.5 1.5B Instruct: small enough for an office PC (about 1 GB at 4-bit),
// good at following a fixed answer format, and multilingual.
const MODEL = 'onnx-community/Qwen2.5-1.5B-Instruct';

let generator = null;
let device = null;

const post = (message) => self.postMessage(message);

function explain(error) {
  const text = String(error?.message || error);
  if (/fetch|network|Failed to load|NetworkError|ERR_/i.test(text)) {
    return "Couldn't download the AI model. The network may be blocking huggingface.co or cdn.jsdelivr.net.";
  }
  return text;
}

async function hasWebGpu() {
  try {
    return !!(self.navigator?.gpu && await self.navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function load() {
  const { pipeline, env } = await import(TRANSFORMERS_URL);
  env.allowLocalModels = false;
  const gpu = await hasWebGpu();
  const options = (useGpu) => ({
    device: useGpu ? 'webgpu' : 'wasm',
    dtype: useGpu ? 'q4f16' : 'q4',
    progress_callback: (event) => {
      if (event.status === 'progress' && event.total) {
        post({ type: 'download', file: event.file, loaded: event.loaded, total: event.total });
      }
    },
  });
  try {
    generator = await pipeline('text-generation', MODEL, options(gpu));
    device = gpu ? 'graphics card' : 'processor';
  } catch (error) {
    if (!gpu) throw error;
    // Some graphics drivers fail at the last step; the processor always works.
    generator = await pipeline('text-generation', MODEL, options(false));
    device = 'processor';
  }
}

async function ask({ system, user, maxTokens }) {
  const output = await generator(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { max_new_tokens: maxTokens || 64, do_sample: false },
  );
  const reply = output?.[0]?.generated_text;
  return Array.isArray(reply) ? String(reply.at(-1)?.content || '') : String(reply || '');
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      if (!generator) await load();
      post({ type: 'ready', device });
    } else if (data.type === 'ask') {
      if (!generator) throw new Error('The AI model is not loaded.');
      post({ type: 'answer', id: data.id, text: (await ask(data)).trim() });
    }
  } catch (error) {
    post({ type: 'error', id: data.id, message: explain(error) });
  }
};
