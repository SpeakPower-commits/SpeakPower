/**
 * Reading what a file is -- video, sound or picture -- and how long and how
 * big, before it goes on a track. Nothing is uploaded: the browser reads the
 * file where it is.
 */

import { loadMediabunny } from './exporter.js';
import { newId } from './tracks.js';

const EXTENSIONS = {
  video: /\.(mp4|m4v|mov|webm|mkv)$/i,
  audio: /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/i,
  image: /\.(png|jpe?g|gif|webp|avif|bmp)$/i,
};

function kindOf(file) {
  const type = file.type || '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  return Object.keys(EXTENSIONS).find((kind) => EXTENSIONS[kind].test(file.name)) || null;
}

function waitFor(element, success) {
  return new Promise((resolve, reject) => {
    element.addEventListener(success, resolve, { once: true });
    element.addEventListener('error', () => reject(new Error('unreadable')), { once: true });
  });
}

/** Recordings made in the browser can report no length; read it from the file itself. */
export async function measuredDuration(file) {
  const mb = await loadMediabunny();
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(file) });
  try {
    return await input.computeDuration();
  } finally {
    input.dispose();
  }
}

/**
 * Describe a file for the tracks:
 *   { id, file, name, kind, duration, width, height, url, image? }
 * Throws with a plain-language message when the browser can't use it.
 */
export async function probeMedia(file) {
  const kind = kindOf(file);
  if (!kind) throw new Error(`"${file.name}" isn't a video, sound or picture file.`);
  const url = URL.createObjectURL(file);
  const media = { id: newId('m'), file, name: file.name, kind, duration: 0, width: 0, height: 0, url };

  try {
    if (kind === 'image') {
      const image = new Image();
      image.src = url;
      await image.decode();
      return { ...media, image, width: image.naturalWidth, height: image.naturalHeight };
    }

    const element = document.createElement(kind === 'audio' ? 'audio' : 'video');
    element.preload = 'metadata';
    element.muted = true;
    element.src = url;
    await waitFor(element, 'loadedmetadata');

    let duration = element.duration;
    if (!Number.isFinite(duration) || duration <= 0) duration = await measuredDuration(file);
    if (!(duration > 0)) throw new Error('no length');

    // An .mp4 with no picture is a sound file (an interview recorded as audio).
    const isVideo = kind === 'video' && element.videoWidth > 0;
    return {
      ...media,
      kind: isVideo ? 'video' : 'audio',
      duration,
      width: isVideo ? element.videoWidth : 0,
      height: isVideo ? element.videoHeight : 0,
    };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(`This browser can't open "${file.name}". Try an MP4, MP3, M4A, WAV, PNG or JPG file.`);
  }
}
