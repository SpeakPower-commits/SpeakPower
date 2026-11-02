/**
 * Renders the edit to an MP4, entirely in the browser.
 *
 * Source files are read where they sit on the user's computer; nothing is
 * uploaded. Mediabunny handles the containers (reading and writing MP4) and
 * drives the browser's own video and audio encoders, which on most PCs means
 * the graphics card does the heavy lifting.
 *
 * The finished video is built on a fixed grid of frames. For each frame the
 * main video and every layer showing at that moment are decoded at exactly
 * the right time -- each source once, front to back -- and drawn by the same
 * drawFrame() the preview uses.
 */

import { FORMATS, drawFrame } from './renderer.js';
import { keptRanges, outputToSource } from './project.js';
import { VIDEO_TRACKS, isActive, mediaOf, timelineDuration } from './tracks.js';
import { audibleClips, mixAudio } from './mixer.js';

// Pinned to an exact release. Loaded on first export, not on page load, so
// opening the editor stays fast.
export const MEDIABUNNY_URL =
  'https://cdn.jsdelivr.net/npm/mediabunny@1.61.6/dist/bundles/mediabunny.min.mjs';

let mediabunny = null;

export async function loadMediabunny() {
  if (!mediabunny) {
    mediabunny = import(MEDIABUNNY_URL).catch((error) => {
      mediabunny = null; // let a later attempt retry, e.g. after a network blip
      throw new Error(
        `Could not load the video engine (${error.message}). Check the internet ` +
        'connection; if the office network blocks cdn.jsdelivr.net, ask IT to allow it.',
      );
    });
  }
  return mediabunny;
}

// Preferred first. H.264 and AAC are what every social platform accepts; the
// others are fallbacks for browsers without those encoders.
const VIDEO_PREFERENCE = ['avc', 'hevc', 'vp9', 'av1'];
const AUDIO_PREFERENCE = ['aac', 'opus'];

// Standard frame rates; the export uses the one nearest the main video's own.
const FRAME_RATES = [24, 25, 30, 50, 60];
const DEFAULT_FRAME_RATE = 30;

async function chooseFrameRate(videoTrack) {
  try {
    const { averagePacketRate } = await videoTrack.computePacketStats(120);
    if (!(averagePacketRate > 0)) return DEFAULT_FRAME_RATE;
    return FRAME_RATES.reduce((best, rate) =>
      (Math.abs(rate - averagePacketRate) < Math.abs(best - averagePacketRate) ? rate : best));
  } catch {
    return DEFAULT_FRAME_RATE;
  }
}

/** Choose the best audio codec this browser can encode, resampling if needed. */
async function chooseAudio(mb, format, sourceRate) {
  const supported = format.getSupportedAudioCodecs();
  const codecs = AUDIO_PREFERENCE.filter((codec) => supported.includes(codec));
  const numberOfChannels = 2;

  // First at the source's own rate; then at 48 kHz, which every encoder
  // accepts. Phone video is usually 44.1 kHz, and some encoders (Opus) refuse
  // it -- without this fallback the export would silently lose its sound.
  for (const sampleRate of [sourceRate, 48000]) {
    const codec = await mb.getFirstEncodableAudioCodec(codecs, { numberOfChannels, sampleRate });
    if (codec) return { codec, numberOfChannels, sampleRate };
  }
  return null;
}

/**
 * Frames for one source, decoded front to back at exactly the times needed.
 * next() is called once per frame where the source is showing, in order.
 */
function frameStream(mb, track, times, firstTimestamp) {
  const sink = new mb.CanvasSink(track, { poolSize: 2 });
  // A frame asked for just before the first one in the file gets the first one.
  const iterator = sink.canvasesAtTimestamps(times.map((time) => Math.max(time, firstTimestamp)));
  return {
    async next() {
      const { value } = await iterator.next();
      return value ? { image: value.canvas, width: value.canvas.width, height: value.canvas.height } : null;
    },
    close: () => iterator.return().catch(() => {}),
  };
}

/**
 * Export the edit.
 *
 * @param project   the edit (project.js, tracks.js)
 * @param assets    fonts and logos (renderer.loadAssets)
 * @param options   { onProgress(fraction, message), signal }
 * @returns         { blob, videoCodec, audioCodec, duration, warnings }
 */
export async function exportVideo(project, assets, { onProgress = () => {}, signal } = {}) {
  const mb = await loadMediabunny();
  const { width, height } = FORMATS[project.format];
  const total = timelineDuration(project);
  const warnings = [];

  if (!keptRanges(project).length && !project.clips.length) {
    throw new Error('Nothing is left to export: the whole video has been trimmed or removed.');
  }
  if (!(total > 0)) throw new Error('Nothing is left to export.');

  // One reader per file, shared by every clip that uses it.
  const inputs = new Map();
  const openInput = async (file) => {
    if (!inputs.has(file)) inputs.set(file, new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(file) }));
    return inputs.get(file);
  };
  const streams = [];
  let output = null;

  try {
    onProgress(0, 'Reading the video');
    const input = await openInput(project.file);
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('This file has no video in it.');
    if (!(await videoTrack.canDecode())) {
      throw new Error(
        `This browser cannot read this video's format (${videoTrack.codec || 'unknown'}). ` +
        'Try current Chrome or Edge, or convert the file to a standard MP4 first.',
      );
    }

    let audioTrack = await input.getPrimaryAudioTrack();
    if (audioTrack && !(await audioTrack.canDecode())) {
      warnings.push("The sound in the main video couldn't be read, so it is left out.");
      audioTrack = null;
    }

    const frameRate = await chooseFrameRate(videoTrack);
    const frameCount = Math.max(1, Math.round(total * frameRate));
    const timeOf = (index) => index / frameRate;

    // Which source time each frame needs from the main video.
    const mainTimes = [];
    const mainShown = new Uint8Array(frameCount);
    for (let index = 0; index < frameCount; index += 1) {
      const source = outputToSource(project, timeOf(index));
      if (source !== null) { mainTimes.push(source); mainShown[index] = 1; }
    }
    const mainStream = mainTimes.length
      ? frameStream(mb, videoTrack, mainTimes, await videoTrack.getFirstTimestamp())
      : null;
    if (mainStream) streams.push(mainStream);

    // The same for every video layer.
    const layers = [];
    for (const clip of project.clips) {
      if (!VIDEO_TRACKS.includes(clip.track) || project.trackOff?.[clip.track]) continue;
      const media = mediaOf(project, clip);
      if (clip.kind === 'image' && media?.image) {
        layers.push({ clip, still: { image: media.image, width: media.width, height: media.height } });
        continue;
      }
      if (clip.kind !== 'video' || !media) continue;
      const track = await (await openInput(media.file)).getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) {
        warnings.push(`"${media.name}" couldn't be read by this browser, so it is left out.`);
        continue;
      }
      const shown = new Uint8Array(frameCount);
      const times = [];
      for (let index = 0; index < frameCount; index += 1) {
        const time = timeOf(index);
        if (isActive(clip, time)) { shown[index] = 1; times.push(clip.in + (time - clip.start)); }
      }
      if (!times.length) continue;
      const stream = frameStream(mb, track, times, await track.getFirstTimestamp());
      streams.push(stream);
      layers.push({ clip, stream, shown });
    }

    const format = new mb.Mp4OutputFormat();
    output = new mb.Output({ format, target: new mb.BufferTarget() });

    const videoCodecs = VIDEO_PREFERENCE.filter((codec) => format.getSupportedVideoCodecs().includes(codec));
    const videoCodec = await mb.getFirstEncodableVideoCodec(videoCodecs, { width, height });
    if (!videoCodec) {
      throw new Error("This browser can't encode video. Use current Chrome or Edge.");
    }
    if (videoCodec !== 'avc') {
      warnings.push(
        `Exported as ${videoCodec.toUpperCase()} because this browser has no H.264 encoder. ` +
        'Some social platforms may reject it; Chrome or Edge on Windows or Mac exports H.264.',
      );
    }

    const frameCanvas = new OffscreenCanvas(width, height);
    const ctx = frameCanvas.getContext('2d', { alpha: false });
    const videoSource = new mb.CanvasSource(frameCanvas, { codec: videoCodec, bitrate: mb.QUALITY_HIGH });
    output.addVideoTrack(videoSource, { frameRate });

    // Sound: the main video's, plus every audible clip.
    let audioSource = null;
    let audioCodec = null;
    let mixRate = null;
    if (audioTrack || audibleClips(project).length) {
      mixRate = audioTrack?.sampleRate || 48000;
      const audio = await chooseAudio(mb, format, mixRate);
      if (audio) {
        audioCodec = audio.codec;
        audioSource = new mb.AudioBufferSource({
          codec: audio.codec,
          bitrate: mb.QUALITY_HIGH,
          transform: { sampleRate: audio.sampleRate, numberOfChannels: audio.numberOfChannels },
        });
        output.addAudioTrack(audioSource);
        if (audio.codec !== 'aac') {
          warnings.push(
            `Sound exported as ${audio.codec.toUpperCase()} because this browser has no AAC encoder. ` +
            'Chrome or Edge on Windows or Mac exports AAC.',
          );
        }
      } else {
        warnings.push("This browser can't encode sound, so the export is silent.");
      }
    }

    await output.start();

    // Video and audio run side by side so the file is written interleaved and
    // each side waits for the encoder when it falls behind (backpressure).
    const renderVideo = async () => {
      for (let index = 0; index < frameCount; index += 1) {
        signal?.throwIfAborted();
        const time = timeOf(index);
        const main = mainShown[index] ? await mainStream.next() : null;
        const frameLayers = new Map();
        for (const layer of layers) {
          if (layer.still) {
            if (isActive(layer.clip, time)) frameLayers.set(layer.clip.id, layer.still);
          } else if (layer.shown[index]) {
            const picture = await layer.stream.next();
            if (picture) frameLayers.set(layer.clip.id, picture);
          }
        }
        drawFrame(ctx, {
          time,
          source: mainShown[index] ? outputToSource(project, time) : null,
          main,
          layers: frameLayers,
        }, project, assets);
        await videoSource.add(time, 1 / frameRate);
        if (index % 5 === 0) onProgress(Math.min(0.99, (index + 1) / frameCount), 'Rendering');
      }
      videoSource.close();
    };

    const renderAudio = async () => {
      if (!audioSource) return;
      await mixAudio(mb, project, {
        mainTrack: audioTrack, openInput, rate: mixRate, total, audioSource, signal, warnings,
      });
    };

    await Promise.all([renderVideo(), renderAudio()]);

    onProgress(0.995, 'Finishing the file');
    await output.finalize();

    const blob = new Blob([output.target.buffer], { type: format.mimeType });
    onProgress(1, 'Done');
    return { blob, videoCodec, audioCodec, duration: total, warnings, frameRate };
  } catch (error) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => {});
    }
    throw error;
  } finally {
    await Promise.all(streams.map((stream) => stream.close()));
    for (const input of inputs.values()) input.dispose();
  }
}
