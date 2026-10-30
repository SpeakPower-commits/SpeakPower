/**
 * The export's sound: the main video's sound, closed up across its cuts, mixed
 * with every audible clip -- music, voiceover and any layer whose sound is up.
 *
 * Work is done one second at a time, so memory stays flat however long the
 * video is. Only the clips' own sound is decoded in full, and only the part of
 * each that is used.
 */

import { keptRanges, joinTimes } from './project.js';
import { clipGainAt, isAudioTrack, isVideoTrack, mainGainAt, mediaOf } from './tracks.js';

const CHANNELS = 2;
const GAIN_STEP = 64;          // gain is worked out every 64 samples (~1.4 ms): smooth and cheap
const DECODE_BLOCK = 30;       // seconds of a clip's sound decoded at a time
// Beyond this much decoded clip sound the browser tab is at risk; say so instead of crashing.
const MAX_CLIP_SAMPLES = 2 * 60 * 60 * 48000;

/** Clips whose sound belongs in the export. */
export function audibleClips(project) {
  const off = project.trackOff || {};
  return project.clips.filter((clip) => {
    if (off[clip.track] || !(clip.volume > 0)) return false;
    if (clip.kind === 'audio') return isAudioTrack(clip.track);
    return clip.kind === 'video' && isVideoTrack(clip.track);
  });
}

/**
 * Decode [from, to) seconds of a file's sound as stereo at a sample rate.
 * The browser's OfflineAudioContext places, resamples and up-mixes each
 * decoded buffer, so mono recordings come out in both ears.
 */
async function decodeSegment(mb, input, from, to, rate, signal) {
  const track = await input.getPrimaryAudioTrack();
  if (!track || !(await track.canDecode())) return null;
  const length = Math.max(0, Math.round((to - from) * rate));
  const channels = [new Float32Array(length), new Float32Array(length)];
  const sink = new mb.AudioBufferSink(track);

  for (let blockStart = from; blockStart < to; blockStart += DECODE_BLOCK) {
    signal?.throwIfAborted();
    const blockEnd = Math.min(to, blockStart + DECODE_BLOCK);
    const frames = Math.max(1, Math.round((blockEnd - blockStart) * rate));
    const context = new OfflineAudioContext(CHANNELS, frames, rate);
    for await (const { buffer, timestamp } of sink.buffers(blockStart, blockEnd)) {
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      const when = timestamp - blockStart;
      if (when < 0) node.start(0, -when);
      else node.start(when);
    }
    const rendered = await context.startRendering();
    const at = Math.round((blockStart - from) * rate);
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      const data = rendered.getChannelData(Math.min(channel, rendered.numberOfChannels - 1));
      channels[channel].set(data.subarray(0, Math.max(0, Math.min(data.length, length - at))), at);
    }
  }
  return channels;
}

/**
 * Mix and send the finished sound to the encoder.
 *
 * @param mb          Mediabunny
 * @param project     the edit
 * @param options     { mainTrack, openInput(file), rate, total, audioSource, signal, warnings }
 */
export async function mixAudio(mb, project, { mainTrack, openInput, rate, total, audioSource, signal, warnings }) {
  const totalSamples = Math.max(1, Math.round(total * rate));
  const block = rate; // one second
  const joins = joinTimes(project);

  // 1. Every audible clip's sound, decoded once.
  const extras = [];
  let decodedSamples = 0;
  for (const clip of audibleClips(project)) {
    const media = mediaOf(project, clip);
    if (!media) continue;
    decodedSamples += (clip.out - clip.in) * rate;
    if (decodedSamples > MAX_CLIP_SAMPLES) {
      throw new Error('There is more than two hours of music and voiceover on the tracks — too much for the browser to mix. Shorten some clips.');
    }
    const data = await decodeSegment(mb, await openInput(media.file), clip.in, clip.out, rate, signal);
    if (!data) {
      warnings.push(`The sound of "${media.name}" couldn't be read, so it is left out.`);
      continue;
    }
    extras.push({ clip, data, first: Math.round(clip.start * rate) });
  }

  // 2. The main video's sound arrives in pieces; it is written into one-second
  //    blocks, and each block is finished (gain, clips, limiter) once the main
  //    sound has moved past it.
  const blocks = new Map();
  let nextBlock = 0;
  const getBlock = (index) => {
    if (!blocks.has(index)) blocks.set(index, [new Float32Array(block), new Float32Array(block)]);
    return blocks.get(index);
  };

  const finish = async (index) => {
    const offset = index * block;
    const length = Math.min(block, totalSamples - offset);
    if (length <= 0) return;
    const [left, right] = blocks.get(index) || [new Float32Array(block), new Float32Array(block)];
    blocks.delete(index);

    for (let i = 0; i < length; i += GAIN_STEP) {
      const gain = mainGainAt(project, (offset + i) / rate, joins);
      const stop = Math.min(length, i + GAIN_STEP);
      for (let j = i; j < stop; j += 1) { left[j] *= gain; right[j] *= gain; }
    }

    for (const { clip, data, first } of extras) {
      const from = Math.max(offset, first);
      const to = Math.min(offset + length, first + data[0].length);
      for (let i = from; i < to; i += GAIN_STEP) {
        const gain = clipGainAt(clip, i / rate);
        const stop = Math.min(to, i + GAIN_STEP);
        for (let j = i; j < stop; j += 1) {
          left[j - offset] += data[0][j - first] * gain;
          right[j - offset] += data[1][j - first] * gain;
        }
      }
    }

    // Keep the sum inside full scale: a gentle knee above 0.9, never a hard clip.
    for (const channel of [left, right]) {
      for (let j = 0; j < length; j += 1) {
        const value = channel[j];
        const size = Math.abs(value);
        if (size > 0.9) channel[j] = Math.sign(value) * (0.9 + 0.1 * Math.tanh((size - 0.9) / 0.1));
      }
    }

    const buffer = new AudioBuffer({ length, numberOfChannels: CHANNELS, sampleRate: rate });
    buffer.copyToChannel(left.subarray(0, length), 0);
    buffer.copyToChannel(right.subarray(0, length), 1);
    await audioSource.add(buffer);
  };

  const finishBefore = async (index) => {
    while (nextBlock < index) {
      await finish(nextBlock);
      nextBlock += 1;
    }
  };

  if (mainTrack) {
    const sink = new mb.AudioBufferSink(mainTrack);
    let base = 0;
    for (const range of keptRanges(project)) {
      for await (const { buffer, timestamp } of sink.buffers(range.start, range.end)) {
        signal?.throwIfAborted();
        const source = buffer.sampleRate === rate ? buffer : await resample(buffer, rate);
        const from = Math.max(0, Math.round((range.start - timestamp) * rate));
        const to = Math.min(source.length, Math.round((range.end - timestamp) * rate));
        if (to <= from) continue;
        const at = Math.round((base + (timestamp + from / rate - range.start)) * rate);
        await finishBefore(Math.floor(at / block));

        const left = source.getChannelData(0);
        const right = source.getChannelData(Math.min(1, source.numberOfChannels - 1));
        for (let i = from; i < to; i += 1) {
          const position = at + (i - from);
          if (position >= totalSamples) break;
          const index = Math.floor(position / block);
          if (index < nextBlock) continue; // a rounding sliver of an already-finished block
          const target = getBlock(index);
          target[0][position - index * block] = left[i];
          target[1][position - index * block] = right[i];
        }
      }
      base += range.end - range.start;
    }
  }

  await finishBefore(Math.ceil(totalSamples / block));
  audioSource.close();
}

/** Resample a buffer that came out of the decoder at an unexpected rate. */
async function resample(buffer, rate) {
  const context = new OfflineAudioContext(buffer.numberOfChannels, Math.max(1, Math.round(buffer.duration * rate)), rate);
  const node = context.createBufferSource();
  node.buffer = buffer;
  node.connect(context.destination);
  node.start();
  return context.startRendering();
}
