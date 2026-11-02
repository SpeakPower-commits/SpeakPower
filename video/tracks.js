/**
 * Tracks and clips: everything layered over the main video.
 *
 * The main video is track V1, edited with trim and cut (project.js). Above it
 * sit seven more video tracks, V2 to V8, for b-roll, picture-in-picture,
 * split screens, pictures and titles; higher tracks draw on top. Below it sit
 * four audio tracks for music, voiceover and sound effects.
 *
 * A clip is plain data, placed in time on the FINISHED video:
 *
 *   { id, kind: 'video'|'image'|'audio'|'text', mediaId, track,
 *     start,            // where it begins in the finished video, seconds
 *     in, out,          // which part of its media plays (images and text: 0..length)
 *     layout, size,     // where a picture goes (video tracks)
 *     volume,           // 0..1 (video and audio)
 *     transitionIn, transitionOut, transitionDuration,
 *     title, subtitle } // text clips
 *
 * Nothing here touches the DOM, so the preview and the exporter share the same
 * arithmetic and agree frame for frame.
 */

import { joinTimes, outputDuration } from './project.js';

export const MAIN_TRACK = 'v1';
export const VIDEO_TRACKS = ['v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'];
export const AUDIO_TRACKS = ['a1', 'a2', 'a3', 'a4'];

export const trackLabel = (track) => track.toUpperCase();
export const isVideoTrack = (track) => track === MAIN_TRACK || VIDEO_TRACKS.includes(track);
export const isAudioTrack = (track) => AUDIO_TRACKS.includes(track);

/** Which tracks a kind of clip may sit on. */
export function tracksFor(kind) {
  return kind === 'audio' ? AUDIO_TRACKS : VIDEO_TRACKS;
}

export const LAYOUTS = {
  full: 'Full screen',
  fit: 'Whole picture',
  top: 'Top half',
  bottom: 'Bottom half',
  left: 'Left half',
  right: 'Right half',
  'pip-tr': 'Corner · top right',
  'pip-tl': 'Corner · top left',
  'pip-br': 'Corner · bottom right',
  'pip-bl': 'Corner · bottom left',
  'logo-tr': 'Logo · top right',
  'logo-tl': 'Logo · top left',
  'logo-br': 'Logo · bottom right',
  'logo-bl': 'Logo · bottom left',
};

// Graphics drawn by Studio itself rather than imported: lower-third titles,
// cards, pop-up key phrases and the progress bar.
export const DRAWN_KINDS = ['text', 'card', 'callout', 'progress'];
export const CARD_STYLES = { hook: 'Opening hook', chapter: 'Chapter', end: 'End card' };

export const TRANSITIONS = {
  none: 'None',
  fade: 'Fade',
  slide: 'Slide',
  zoom: 'Zoom',
  wipe: 'Wipe',
};

// Where a removed part of the main video closes up.
export const JOIN_TRANSITIONS = {
  cut: 'Straight cut',
  fade: 'Fade through black',
  flash: 'Flash (white)',
};

const JOIN_HALF = { fade: 0.3, flash: 0.12 };  // seconds either side of the join
const DECLICK = 0.008;                         // tiny audio ramp so joins never click
export const MIN_CLIP = 0.2;
const EPSILON = 1e-3;

export const DEFAULT_LENGTH = { image: 5, text: 4, card: 3, callout: 1.4, progress: 5 };

let counter = 0;
export const newId = (prefix) => `${prefix}${Date.now().toString(36)}${(counter += 1).toString(36)}`;

// --- Lengths and lookups --------------------------------------------------------

export const clipLength = (clip) => clip.out - clip.in;
export const clipEnd = (clip) => clip.start + clipLength(clip);
export const isActive = (clip, time) => time >= clip.start && time < clipEnd(clip);
export const mediaOf = (project, clip) => project.media.find((item) => item.id === clip.mediaId) || null;

/** Images and text can be any length; video and sound end where their media does. */
const hasFixedLength = (clip) => clip.kind === 'video' || clip.kind === 'audio';

/** How long the finished video is: the main video, or longer if layers run past it. */
export function timelineDuration(project) {
  return Math.max(outputDuration(project), ...project.clips.map(clipEnd), 0);
}

export function clipsOn(project, track) {
  return project.clips.filter((clip) => clip.track === track).sort((a, b) => a.start - b.start);
}

/** Is [start, end) free on a track? Clips on one track never overlap. */
export function fits(project, track, start, end, ignoreId = null) {
  if (start < -EPSILON) return false;
  return project.clips.every((clip) => clip.id === ignoreId
    || clip.track !== track
    || end <= clip.start + EPSILON
    || start >= clipEnd(clip) - EPSILON);
}

/** The lowest track of the right kind with room, or null when all are busy. */
export function freeTrack(project, kind, start, end, preferred = null) {
  const choices = tracksFor(kind);
  if (preferred && choices.includes(preferred) && fits(project, preferred, start, end)) return preferred;
  return choices.find((track) => fits(project, track, start, end)) || null;
}

// --- Editing ----------------------------------------------------------------------

/**
 * Place new media on the timeline. Returns the clip, or null if every track of
 * that kind is busy at that time.
 */
export function addClip(project, { kind, media = null, start = 0, track = null, ...extra }) {
  const length = hasFixedLength({ kind }) ? media.duration : (extra.length || DEFAULT_LENGTH[kind] || 5);
  const at = Math.max(0, start);
  const target = freeTrack(project, kind, at, at + length, track);
  if (!target) return null;
  const clip = {
    id: newId('c'),
    kind,
    mediaId: media?.id ?? null,
    track: target,
    start: at,
    in: 0,
    out: length,
    layout: extra.layout || 'full',
    size: 0.36,
    // Sound from a b-roll layer would fight the speaker, so it starts muted.
    volume: extra.volume ?? (kind === 'audio' ? 1 : 0),
    transitionIn: extra.transitionIn || (kind === 'audio' ? 'none' : 'fade'),
    transitionOut: extra.transitionOut || (kind === 'audio' ? 'none' : 'fade'),
    transitionDuration: 0.5,
    title: extra.title || '',
    subtitle: extra.subtitle || '',
    style: extra.style || '',
  };
  if (extra.size) clip.size = extra.size;
  if (extra.transitionDuration) clip.transitionDuration = extra.transitionDuration;
  project.clips.push(clip);
  return clip;
}

export function removeClip(project, id) {
  project.clips = project.clips.filter((clip) => clip.id !== id);
}

/** Move a clip in time and/or to another track of its kind. False if it would overlap. */
export function moveClip(project, clip, start, track = clip.track) {
  if (!tracksFor(clip.kind).includes(track)) return false;
  const at = Math.max(0, start);
  if (!fits(project, track, at, at + clipLength(clip), clip.id)) return false;
  clip.start = at;
  clip.track = track;
  return true;
}

/** Drag the left edge: the clip starts later (or earlier) and keeps its end. */
export function trimClipStart(project, clip, time) {
  const end = clipEnd(clip);
  let start = Math.min(time, end - MIN_CLIP);
  if (hasFixedLength(clip)) start = Math.max(start, clip.start - clip.in); // cannot go before the media starts
  start = Math.max(0, start);
  if (!fits(project, clip.track, start, end, clip.id)) return false;
  if (hasFixedLength(clip)) clip.in += start - clip.start;
  else clip.out = end - start;
  clip.start = start;
  return true;
}

/** Drag the right edge. */
export function trimClipEnd(project, clip, time, mediaDuration = Infinity) {
  let end = Math.max(time, clip.start + MIN_CLIP);
  if (hasFixedLength(clip)) end = Math.min(end, clip.start + (mediaDuration - clip.in));
  if (!fits(project, clip.track, clip.start, end, clip.id)) return false;
  clip.out = clip.in + (end - clip.start);
  return true;
}

/** Cut a clip in two at a time. Returns the new right-hand clip, or null. */
export function splitClip(project, clip, time) {
  if (time <= clip.start + MIN_CLIP / 2 || time >= clipEnd(clip) - MIN_CLIP / 2) return null;
  const offset = time - clip.start;
  const right = { ...clip, id: newId('c'), start: time, transitionIn: 'none' };
  if (hasFixedLength(clip)) {
    right.in = clip.in + offset;
    clip.out = clip.in + offset;
  } else {
    right.in = 0;
    right.out = clip.out - offset;
    clip.out = offset;
  }
  clip.transitionOut = 'none';
  project.clips.push(right);
  return right;
}

// --- Transitions --------------------------------------------------------------------

const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

/**
 * How far a clip is into its transition at a time.
 *
 * Returns { type, phase: 'in'|'out'|null, p } where p runs 0 -> 1 as the clip
 * arrives (and 1 -> 0 as it leaves), already eased.
 */
export function transitionAt(clip, time) {
  const length = clipLength(clip);
  const duration = Math.min(clip.transitionDuration || 0, length / 2);
  const into = time - clip.start;
  const left = clipEnd(clip) - time;
  if (duration > 0 && clip.transitionIn !== 'none' && into < duration) {
    return { type: clip.transitionIn, phase: 'in', p: ease(Math.max(0, into / duration)) };
  }
  if (duration > 0 && clip.transitionOut !== 'none' && left < duration) {
    return { type: clip.transitionOut, phase: 'out', p: ease(Math.max(0, left / duration)) };
  }
  return { type: 'none', phase: null, p: 1 };
}

/** A clip's loudness at a time: its volume, faded with its transitions, never clicking. */
export function clipGainAt(clip, time) {
  if (!isActive(clip, time)) return 0;
  const { p } = transitionAt(clip, time);
  const edge = Math.min(time - clip.start, clipEnd(clip) - time) / DECLICK;
  return (clip.volume ?? 1) * p * Math.min(1, Math.max(0, edge));
}

/** Distance from a time to the nearest join in the main video. */
function nearestJoin(joins, time) {
  let best = Infinity;
  for (const join of joins) {
    const distance = Math.abs(time - join);
    if (distance < best) best = distance;
    if (join > time) break;
  }
  return best;
}

/**
 * The look of a join at a time: { color, amount } where amount is 0..1 of
 * black (fade) or white (flash) laid over the main video.
 */
export function joinEffectAt(project, time, joins = joinTimes(project)) {
  const half = JOIN_HALF[project.joinTransition];
  if (!half || !joins.length) return null;
  const amount = 1 - nearestJoin(joins, time) / half;
  if (amount <= 0) return null;
  return { color: project.joinTransition === 'flash' ? '#FFFFFF' : '#000000', amount: ease(Math.min(1, amount)) };
}

/** The main video's loudness at a time: its volume, dipped through fades, de-clicked at every join. */
export function mainGainAt(project, time, joins = joinTimes(project)) {
  const distance = nearestJoin(joins, time);
  let gain = Math.min(1, distance / DECLICK);
  if (project.joinTransition === 'fade') gain = Math.min(gain, ease(Math.min(1, distance / JOIN_HALF.fade)));
  return (project.mainVolume ?? 1) * gain;
}
