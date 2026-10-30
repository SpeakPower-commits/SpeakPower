/**
 * SpeakPower Studio -- the editor page.
 *
 * Everything happens in this browser tab. Files are opened from the user's
 * computer (or recorded right here), previewed live on a canvas, and exported
 * by exporter.js. No part of any video is sent anywhere.
 *
 * Playback runs on one clock: the playhead, in seconds of the finished video.
 * The main video, every video layer and every sound clip follow it, each
 * seeking to its own place. While the main video is playing, the clock follows
 * the main video, so the speaker's lips and voice stay together.
 */

import {
  addCut, createProject, formatTime, keptRanges, nextPlayableTime,
  outputDuration, outputToSource, removeCut, setTrim, sourceToOutput,
} from './project.js';
import { FORMATS, drawFrame, loadAssets } from './renderer.js';
import { Timeline } from './timeline.js';
import { TrackTimeline } from './multitrack.js';
import { exportVideo, loadMediabunny } from './exporter.js';
import { editSegmentText, replaceEverywhere, segmentsFromSrt } from './captions.js';
import { transcribeFile } from './speech.js';
import {
  LAYOUTS, TRANSITIONS, addClip, clipEnd, clipGainAt, clipLength, isActive, mainGainAt,
  mediaOf, moveClip, removeClip, splitClip, timelineDuration, trackLabel, tracksFor, trimClipEnd,
} from './tracks.js';
import { measuredDuration, probeMedia } from './media.js';
import { Capture } from './capture.js';

// Preview runs at a reduced resolution so it stays smooth on modest PCs. The
// renderer lays everything out proportionally, so this is a faithful scale
// model of the full-size export.
const PREVIEW_MAX_SIDE = 960;
// How far a playing layer may drift from the playhead before it is re-seeked.
const DRIFT = 0.25;
// While paused, how close a layer must sit to the playhead to count as there.
const STILL = 0.02;

const $ = (selector) => document.querySelector(selector);

const ui = {
  drop: $('#drop'),
  file: $('#file'),
  viewer: $('#viewer'),
  previewFrame: $('#preview-frame'),
  preview: $('#preview'),
  play: $('#play'),
  clockNow: $('#clock-now'),
  clockTotal: $('#clock-total'),
  clockNote: $('#clock-note'),
  remove: $('#remove'),
  cuts: $('#cuts'),
  formats: $('#formats'),
  headline: $('#headline'),
  logo: $('#logo'),
  exportButton: $('#export'),
  progress: $('#progress'),
  progressFill: $('#progress-fill'),
  progressText: $('#progress-text'),
  cancel: $('#cancel'),
  result: $('#result'),
  status: $('#status'),
  unsupported: $('#unsupported'),
  captionsOn: $('#captions-on'),
  captionModel: $('#caption-model'),
  captionLanguage: $('#caption-language'),
  autoCaptions: $('#auto-captions'),
  captionProgress: $('#caption-progress'),
  captionProgressFill: $('#caption-progress-fill'),
  captionProgressText: $('#caption-progress-text'),
  captionCancel: $('#caption-cancel'),
  srt: $('#srt'),
  transcript: $('#transcript'),
  lines: $('#lines'),
  captionCount: $('#caption-count'),
  replaceForm: $('#replace-form'),
  replaceFind: $('#replace-find'),
  replaceWith: $('#replace-with'),
  addMedia: $('#add-media'),
  addText: $('#add-text'),
  replaceMain: $('#replace-main'),
  zoom: $('#zoom'),
  inspector: $('#inspector'),
  joinTransition: $('#join-transition'),
  mainVolume: $('#main-volume'),
  mainVolumeValue: $('#main-volume-value'),
};

const state = {
  project: null,
  video: null,
  videoUrl: null,
  assets: { logos: {} },
  selection: null,
  exporting: null,       // AbortController while an export runs
  captioning: null,      // AbortController while captions are being made
  resultUrl: null,
  currentLine: -1,
  time: 0,               // the playhead: seconds into the finished video
  playing: false,
  lastNow: 0,
  peek: null,            // a source time picked on the main-video bar while paused
  players: new Map(),    // clip id -> <video>/<audio> following the playhead
  selectedClip: null,
  quiet: false,          // silence the preview while a voiceover is recorded
};

const previewCtx = ui.preview.getContext('2d', { alpha: false });

// --- Messages ----------------------------------------------------------------

function showStatus(message, kind = 'info') {
  ui.status.hidden = !message;
  ui.status.textContent = message || '';
  ui.status.className = `notice notice-${kind}`;
}

// --- Support check -----------------------------------------------------------

function browserSupported() {
  return typeof VideoEncoder !== 'undefined'
    && typeof VideoDecoder !== 'undefined'
    && typeof OffscreenCanvas !== 'undefined'
    && typeof AudioBuffer !== 'undefined';
}

// --- Format choices ----------------------------------------------------------

function buildFormatChoices() {
  ui.formats.replaceChildren(...Object.entries(FORMATS).map(([key, format], index) => {
    const label = document.createElement('label');
    label.className = 'choice';
    label.innerHTML = `
      <input type="radio" name="format" value="${key}" ${index === 0 ? 'checked' : ''} />
      <span><strong>${format.label}</strong><small>${format.use}</small></span>`;
    return label;
  }));
}

function sizePreviewCanvas() {
  const project = state.project;
  const { width, height } = FORMATS[project ? project.format : '9:16'];
  const scale = PREVIEW_MAX_SIDE / Math.max(width, height);
  ui.preview.width = Math.round(width * scale);
  ui.preview.height = Math.round(height * scale);
  ui.previewFrame.dataset.format = project ? project.format : '9:16';
}

// --- The clock and the players ---------------------------------------------------

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const isKept = (project, time) => nextPlayableTime(project, time) === time;

/** Seconds into the main video for the playhead, or null once it has ended. */
function mainSourceTime() {
  const { project, video } = state;
  if (!project) return null;
  if (state.peek !== null) return state.peek;
  return outputToSource(project, state.time) === null ? null : video?.currentTime ?? null;
}

/** A <video> or <audio> for each video and sound clip; removed clips lose theirs. */
function syncPlayerSet() {
  const { project } = state;
  const wanted = new Set();
  for (const clip of project?.clips || []) {
    if (clip.kind !== 'video' && clip.kind !== 'audio') continue;
    wanted.add(clip.id);
    if (state.players.has(clip.id)) continue;
    const media = mediaOf(project, clip);
    if (!media) continue;
    const element = document.createElement(clip.kind === 'audio' ? 'audio' : 'video');
    element.preload = 'auto';
    element.playsInline = true;
    element.muted = true;
    element.src = media.url;
    state.players.set(clip.id, element);
  }
  for (const [id, element] of state.players) {
    if (wanted.has(id)) continue;
    element.pause();
    element.removeAttribute('src');
    element.load();
    state.players.delete(id);
  }
}

function syncMain() {
  const { project, video } = state;
  if (!video) return;
  if (state.peek !== null) return; // showing a frame picked on the main-video bar
  const source = outputToSource(project, state.time);
  if (source === null) {
    if (!video.paused) video.pause();
    return;
  }
  const gain = state.quiet ? 0 : clamp01(mainGainAt(project, state.time));
  video.volume = gain;
  video.muted = gain <= 0.001;
  if (state.playing) {
    if (video.paused) {
      video.currentTime = source;
      video.play().catch(() => {});
    } else if (!video.seeking && (!isKept(project, video.currentTime) || Math.abs(video.currentTime - source) > DRIFT)) {
      // Playback ran into a removed part, or fell behind: jump to where it belongs.
      video.currentTime = source;
    }
  } else {
    if (!video.paused) video.pause();
    if (!video.seeking && Math.abs(video.currentTime - source) > STILL) video.currentTime = source;
  }
}

function syncPlayers() {
  const { project } = state;
  const time = state.time;
  for (const clip of project.clips) {
    const element = state.players.get(clip.id);
    if (!element) continue;
    const showing = isActive(clip, time) && !project.trackOff[clip.track];
    if (!showing) {
      if (!element.paused) element.pause();
      // Get the next clip's first frame ready just before it is needed.
      const until = clip.start - time;
      if (until > 0 && until < 2 && !element.seeking && Math.abs(element.currentTime - clip.in) > 0.05) {
        element.currentTime = clip.in;
      }
      continue;
    }
    const want = clip.in + (time - clip.start);
    const gain = state.quiet ? 0 : clamp01(clipGainAt(clip, time));
    element.volume = gain;
    element.muted = gain <= 0.001;
    if (state.playing) {
      if (element.paused) {
        element.currentTime = want;
        element.play().catch(() => {});
      } else if (!element.seeking && Math.abs(element.currentTime - want) > DRIFT) {
        element.currentTime = want;
      }
    } else {
      if (!element.paused) element.pause();
      if (!element.seeking && Math.abs(element.currentTime - want) > STILL) element.currentTime = want;
    }
  }
}

function advanceClock(now) {
  const { project, video } = state;
  const elapsed = Math.min(0.25, Math.max(0, (now - state.lastNow) / 1000));
  const source = outputToSource(project, state.time);
  if (source !== null && video) {
    const ready = !video.seeking && video.readyState >= 3;
    if (ready && !video.paused && isKept(project, video.currentTime)) {
      state.time = sourceToOutput(project, video.currentTime); // follow the speaker
    } else if (ready || video.paused) {
      state.time += elapsed;
    } // else hold while the main video catches up after a jump
  } else {
    state.time += elapsed;
  }
  const total = timelineDuration(project);
  if (state.time >= total) {
    state.time = total;
    pause();
  }
}

function seek(time) {
  const { project } = state;
  if (!project || !Number.isFinite(time)) return;
  state.peek = null;
  state.time = Math.min(Math.max(0, time), timelineDuration(project));
}

/** Jump to a moment of the main video, e.g. from the trim bar or a caption line. */
function seekSource(source) {
  const { project, video } = state;
  if (!project) return;
  if (state.playing || isKept(project, source)) {
    seek(sourceToOutput(project, source));
    return;
  }
  // Paused on a removed or trimmed-off part: show that frame so it can be checked.
  state.peek = source;
  state.time = sourceToOutput(project, source);
  if (video) video.currentTime = source;
}

function setPlayButton() {
  ui.play.textContent = state.playing ? '❚❚' : '▶';
  ui.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
}

function play() {
  const { project } = state;
  if (!project || state.playing) return;
  if (state.time >= timelineDuration(project) - 0.05) state.time = 0;
  state.peek = null;
  state.playing = true;
  state.lastNow = performance.now();
  setPlayButton();
}

function pause() {
  if (!state.playing) return;
  state.playing = false;
  state.video?.pause();
  for (const element of state.players.values()) element.pause();
  setPlayButton();
}

// --- Rendering the preview ---------------------------------------------------

function drawPreview() {
  const { project, video } = state;
  if (!project) return;
  const time = state.time;
  const source = mainSourceTime();
  const main = source !== null && video && video.readyState >= 2
    ? { image: video, width: video.videoWidth, height: video.videoHeight }
    : null;

  const layers = new Map();
  for (const clip of project.clips) {
    if (!isActive(clip, time)) continue;
    if (clip.kind === 'image') {
      const media = mediaOf(project, clip);
      if (media?.image) layers.set(clip.id, { image: media.image, width: media.width, height: media.height });
    } else if (clip.kind === 'video') {
      const element = state.players.get(clip.id);
      if (element && element.readyState >= 2) {
        layers.set(clip.id, { image: element, width: element.videoWidth, height: element.videoHeight });
      }
    }
  }
  drawFrame(previewCtx, { time, source: main ? source : null, main, layers }, project, state.assets);
}

function updateClock() {
  const { project } = state;
  if (!project) return;
  ui.clockNow.textContent = formatTime(state.time);
  ui.clockTotal.textContent = formatTime(timelineDuration(project));
  const removed = project.duration - outputDuration(project);
  ui.clockNote.textContent = removed > 0.05
    ? `${formatTime(removed)} cut from the main video`
    : '';
}

function tick(now) {
  const { project } = state;
  if (project) {
    if (state.playing) advanceClock(now);
    state.lastNow = now;
    syncMain();
    syncPlayers();
    const source = mainSourceTime();
    if (source !== null) {
      timeline.setPlayhead(source);
      updateCurrentLine(source);
    }
    tracks.setTime(state.time, state.playing);
    drawPreview();
    updateClock();
  }
  requestAnimationFrame(tick);
}

// --- The edit ----------------------------------------------------------------

function renderCuts() {
  const { project } = state;
  ui.cuts.replaceChildren(...(project?.cuts || []).map((cut, index) => {
    const item = document.createElement('li');
    item.innerHTML = `<span>Removed ${formatTime(cut.start)} – ${formatTime(cut.end)}
      <small>(${formatTime(cut.end - cut.start)})</small></span>`;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'button-link';
    undo.textContent = 'Put back';
    undo.addEventListener('click', () => {
      removeCut(project, index);
      editChanged();
    });
    item.append(undo);
    return item;
  }));
}

function editChanged() {
  timeline.render();
  tracks.render();
  renderCuts();
  markRemovedLines();
  updateClock();
  clearResult();
}

const timeline = new Timeline($('#timeline'), {
  onSeek: (time) => seekSource(time),
  onTrim: (start, end) => {
    if (!state.project) return;
    const changingStart = start !== state.project.trim.start;
    if (setTrim(state.project, start, end)) {
      // Show the edge being dragged, so the trim point can be judged by eye.
      pause();
      seekSource(changingStart ? start : Math.max(start, end - 0.05));
      editChanged();
    }
  },
  onSelect: (range) => {
    state.selection = range;
    ui.remove.disabled = !range;
  },
});

ui.remove.addEventListener('click', () => {
  if (!state.project || !state.selection) return;
  if (addCut(state.project, state.selection.start, state.selection.end)) {
    timeline.setSelection(null);
    editChanged();
  }
});

// --- Captions ----------------------------------------------------------------

/** Index of the caption line playing at a time, or -1. */
function lineAt(segments, time) {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (time < segments[middle].start) high = middle - 1;
    else if (time >= segments[middle].end) low = middle + 1;
    else return middle;
  }
  return -1;
}

function isRemoved(project, segment) {
  const middle = (segment.start + segment.end) / 2;
  return nextPlayableTime(project, middle) !== middle;
}

function markRemovedLines() {
  const { project } = state;
  if (!project) return;
  [...ui.lines.children].forEach((item, index) => {
    const segment = project.captions.segments[index];
    if (segment) item.classList.toggle('is-removed', isRemoved(project, segment));
  });
}

function renderTranscript() {
  const { project } = state;
  const segments = project?.captions.segments || [];
  ui.transcript.hidden = !segments.length;
  ui.captionCount.textContent = segments.length ? `· ${segments.length} lines` : '';
  state.currentLine = -1;

  ui.lines.replaceChildren(...segments.map((segment, index) => {
    const item = document.createElement('li');
    const time = document.createElement('button');
    time.type = 'button';
    time.className = 'line-time';
    time.textContent = formatTime(segment.start);
    time.title = 'Jump here';
    time.addEventListener('click', () => seekSource(segment.start + 0.01));

    const text = document.createElement('input');
    text.className = 'line-text';
    text.value = segment.text;
    text.setAttribute('aria-label', `Caption at ${formatTime(segment.start)}`);
    // Update the data, not the list: rebuilding the list on every keystroke
    // would steal the cursor out of the box being typed in.
    text.addEventListener('input', () => {
      const next = project.captions.segments.slice();
      next[index] = editSegmentText(next[index], text.value);
      project.captions.segments = next;
      clearResult();
    });

    item.append(time, text);
    return item;
  }));
  markRemovedLines();
}

function updateCurrentLine(time) {
  const segments = state.project?.captions.segments;
  if (!segments?.length) return;
  const index = lineAt(segments, time);
  if (index === state.currentLine) return;
  ui.lines.children[state.currentLine]?.classList.remove('is-current');
  const item = ui.lines.children[index];
  if (item) {
    item.classList.add('is-current');
    // Follow playback without yanking the page around.
    if (state.playing) item.scrollIntoView({ block: 'nearest' });
  }
  state.currentLine = index;
}

function setSegments(segments) {
  state.project.captions.segments = segments;
  renderTranscript();
  clearResult();
}

function setCaptioning(active) {
  ui.autoCaptions.disabled = active || !state.project;
  ui.autoCaptions.textContent = active ? 'Making captions…' : 'Auto captions';
  ui.captionProgress.hidden = !active;
}

ui.autoCaptions.addEventListener('click', async () => {
  const { project } = state;
  if (!project || state.captioning) return;
  if (project.captions.segments.length
      && !window.confirm('Replace the current captions, including any corrections you made?')) return;

  pause();
  const controller = new AbortController();
  state.captioning = controller;
  setCaptioning(true);
  showStatus('');
  ui.captionProgressFill.style.width = '0%';

  const started = performance.now();
  try {
    const { segments, wordLevel } = await transcribeFile(project.file, {
      model: ui.captionModel.value,
      language: ui.captionLanguage.value,
      signal: controller.signal,
      onProgress: (stage, fraction) => {
        ui.captionProgressFill.style.width = `${Math.round(fraction * 100)}%`;
        ui.captionProgressText.textContent = `${stage} — ${Math.round(fraction * 100)}%`;
      },
    });
    if (state.project !== project) return; // the user opened another video meanwhile
    if (!segments.length) {
      showStatus('No speech was found in this video.', 'warn');
      return;
    }
    setSegments(segments);
    const seconds = Math.round((performance.now() - started) / 1000);
    showStatus(
      `${segments.length} caption lines made in ${seconds}s. Check them below — fix any word by typing, ` +
      'or use Replace all for a name it keeps getting wrong.' +
      (wordLevel ? '' : ' This model gave line timings only, so the gold highlight moves evenly through each line.'),
      'info',
    );
  } catch (error) {
    if (controller.signal.aborted) showStatus('Captions cancelled.', 'info');
    else showStatus(`Captions failed: ${error.message}`, 'error');
  } finally {
    state.captioning = null;
    setCaptioning(false);
  }
});

ui.captionCancel.addEventListener('click', () => state.captioning?.abort());

ui.srt.addEventListener('change', async () => {
  const file = ui.srt.files[0];
  ui.srt.value = '';
  if (!file || !state.project) return;
  const segments = segmentsFromSrt(await file.text());
  if (!segments.length) {
    showStatus(`No captions could be read from "${file.name}". Is it an .srt or .vtt file?`, 'error');
    return;
  }
  setSegments(segments);
  showStatus(`${segments.length} caption lines imported from ${file.name}.`, 'info');
});

ui.captionsOn.addEventListener('change', () => {
  if (state.project) state.project.captions.enabled = ui.captionsOn.checked;
  clearResult();
});

ui.replaceForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const { project } = state;
  if (!project) return;
  const find = ui.replaceFind.value.trim();
  if (!find) return;
  const { segments, count } = replaceEverywhere(project.captions.segments, find, ui.replaceWith.value);
  if (!count) {
    showStatus(`"${find}" doesn't appear in the captions.`, 'info');
    return;
  }
  setSegments(segments);
  showStatus(`Replaced "${find}" in ${count} place${count === 1 ? '' : 's'}.`, 'info');
});

// --- Opening the main video ------------------------------------------------------

function resetVideo() {
  if (state.video) {
    state.video.pause();
    state.video.removeAttribute('src');
    state.video.load();
  }
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.video = null;
  state.videoUrl = null;
}

/**
 * Open a video as the main video (track V1). Opening another one later keeps
 * the look and every layer on the other tracks; only the trim, cuts and
 * captions belong to the old video and start fresh.
 */
function openFile(file, preset = null) {
  if (!file) return;
  if (file.type && !file.type.startsWith('video/')) {
    showStatus(`"${file.name}" doesn't look like a video file.`, 'error');
    return;
  }
  state.captioning?.abort();
  pause();
  resetVideo();
  clearResult();
  showStatus('Opening…');

  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  state.videoUrl = URL.createObjectURL(file);
  video.src = state.videoUrl;

  video.addEventListener('loadedmetadata', async () => {
    let { duration } = video;
    // A raw browser recording reports no length; read it from the file instead.
    if (!Number.isFinite(duration)) duration = await measuredDuration(file).catch(() => NaN);
    if (!Number.isFinite(duration) || !video.videoWidth) {
      showStatus(`This browser can't play "${file.name}". Try an MP4 file.`, 'error');
      return;
    }
    const previous = state.project;
    const project = preset || createProject(file, duration, video.videoWidth, video.videoHeight);
    // Keep the look the user has already set up when they switch videos.
    if (preset) {
      syncControls(project);
    } else if (previous) {
      Object.assign(project, {
        format: previous.format, framing: previous.framing,
        headline: previous.headline, logo: previous.logo,
        joinTransition: previous.joinTransition, mainVolume: previous.mainVolume,
        media: previous.media, clips: previous.clips, trackOff: previous.trackOff,
      });
    } else {
      project.format = document.querySelector('input[name="format"]:checked').value;
      project.framing = document.querySelector('input[name="framing"]:checked').value;
      project.headline = ui.headline.value;
      project.logo = ui.logo.value;
      project.joinTransition = ui.joinTransition.value;
      project.mainVolume = Number(ui.mainVolume.value);
    }
    if (!preset) project.captions.enabled = ui.captionsOn.checked;
    state.project = project;
    state.video = video;
    state.time = 0;
    state.peek = null;
    syncPlayerSet();

    ui.drop.hidden = true;
    ui.viewer.hidden = false;
    ui.exportButton.disabled = false;
    sizePreviewCanvas();
    timeline.setProject(project);
    tracks.setProject(project);
    selectClip(null);
    renderCuts();
    renderTranscript();
    ui.autoCaptions.disabled = false;
    showStatus('');
  }, { once: true });

  video.addEventListener('error', () => {
    showStatus(`This browser can't open "${file.name}". Try an MP4 file.`, 'error');
  }, { once: true });
}

/** Set the side panel's controls to match a project made elsewhere (the automatic editor). */
function syncControls(project) {
  const format = document.querySelector(`input[name="format"][value="${project.format}"]`);
  if (format) format.checked = true;
  const framing = document.querySelector(`input[name="framing"][value="${project.framing}"]`);
  if (framing) framing.checked = true;
  ui.headline.value = project.headline || '';
  ui.logo.value = project.logo;
  ui.joinTransition.value = project.joinTransition;
  ui.mainVolume.value = project.mainVolume;
  ui.mainVolumeValue.textContent = `${Math.round(project.mainVolume * 100)}%`;
  ui.captionsOn.checked = project.captions.enabled;
}

/** Open a finished automatic edit in the editor, to change anything by hand. */
export function loadProject(project) {
  openFile(project.file, project);
}

ui.file.addEventListener('change', () => openFile(ui.file.files[0]));
ui.replaceMain.addEventListener('change', () => {
  const file = ui.replaceMain.files[0];
  ui.replaceMain.value = '';
  openFile(file);
});

['dragenter', 'dragover'].forEach((type) => document.addEventListener(type, (event) => {
  event.preventDefault();
  ui.drop.classList.add('is-over');
}));
['dragleave', 'drop'].forEach((type) => document.addEventListener(type, (event) => {
  event.preventDefault();
  ui.drop.classList.remove('is-over');
}));
document.addEventListener('drop', (event) => {
  if (document.body.dataset.view !== 'finetune') return; // the automatic editor takes drops there
  const files = [...(event.dataTransfer?.files || [])];
  // Before a video is open, a dropped video becomes the main one; after, files go on the tracks.
  if (state.project) addFiles(files);
  else openFile(files[0]);
});

// --- Tracks ------------------------------------------------------------------------

const tracks = new TrackTimeline($('#multitrack'), {
  onSeek: (time) => seek(time),
  onSelect: (id) => selectClip(id),
  onChange: (kind) => tracksChanged(kind === 'commit'),
  onToggleTrack: (track) => {
    const { project } = state;
    if (!project) return;
    project.trackOff[track] = !project.trackOff[track];
    tracksChanged(true);
  },
});

function selectedClip() {
  return state.project?.clips.find((clip) => clip.id === state.selectedClip) || null;
}

function selectClip(id) {
  state.selectedClip = id;
  tracks.select(id);
  renderInspector();
}

/** Something on the tracks changed: redraw them, and the inspector when the change is finished. */
function tracksChanged(finished = true) {
  syncPlayerSet();
  tracks.render();
  if (finished) renderInspector();
  updateClock();
  clearResult();
}

const DEFAULT_LAYOUT = { camera: 'pip-br', screen: 'full' };

/** Put files on the tracks at the playhead (or a given time), each on the first free track. */
async function addFiles(files, at = state.time, { layout = 'full', quiet = false } = {}) {
  const { project } = state;
  if (!project || !files.length) return;
  let added = null;
  for (const file of files) {
    let media;
    try {
      media = await probeMedia(file);
    } catch (error) {
      showStatus(error.message, 'error');
      continue;
    }
    if (state.project !== project) return; // another main video was opened meanwhile
    project.media.push(media);
    const clip = addClip(project, { kind: media.kind, media, start: at, layout });
    if (!clip) {
      showStatus(`Every ${media.kind === 'audio' ? 'audio' : 'video'} track is busy at ${formatTime(at)}. ` +
        'Move the playhead to a free spot or shorten a clip, then add it again.', 'warn');
      continue;
    }
    added = clip;
    if (!quiet) showStatus(`Added "${media.name}" on ${trackLabel(clip.track)} at ${formatTime(clip.start)}.`, 'info');
  }
  syncPlayerSet();
  tracks.render();
  if (added) selectClip(added.id);
  updateClock();
  clearResult();
  return added;
}

ui.addMedia.addEventListener('change', () => {
  const files = [...ui.addMedia.files];
  ui.addMedia.value = '';
  addFiles(files);
});

ui.addText.addEventListener('click', () => {
  const { project } = state;
  if (!project) return;
  const clip = addClip(project, { kind: 'text', start: state.time, title: 'Name Surname', subtitle: 'Role, Organisation' });
  if (!clip) {
    showStatus(`Every video track is busy at ${formatTime(state.time)}.`, 'warn');
    return;
  }
  tracks.render();
  selectClip(clip.id);
  clearResult();
  ui.inspector.querySelector('[data-field="title"]')?.select();
});

ui.zoom.addEventListener('input', () => tracks.setZoom(Number(ui.zoom.value)));

// --- The clip inspector --------------------------------------------------------------

const KIND_LABELS = { video: 'Video', image: 'Picture', audio: 'Sound', text: 'Title', card: 'Card', callout: 'Pop-up text', progress: 'Progress bar' };
const TRANSITION_LENGTHS = [0.25, 0.5, 0.75, 1, 1.5, 2];

const options = (entries, current) => entries
  .map(([value, label]) => `<option value="${value}"${String(value) === String(current) ? ' selected' : ''}>${label}</option>`)
  .join('');

function renderInspector() {
  const clip = selectedClip();
  ui.inspector.hidden = !clip;
  if (!clip) { ui.inspector.replaceChildren(); return; }
  const project = state.project;
  const media = mediaOf(project, clip);
  const visual = clip.kind === 'video' || clip.kind === 'image';
  const corner = clip.layout?.startsWith('pip');
  const hasSound = clip.kind === 'video' || clip.kind === 'audio';
  const transitions = clip.kind === 'audio'
    ? [['none', 'None'], ['fade', 'Fade']]
    : Object.entries(TRANSITIONS);

  ui.inspector.innerHTML = `
    <div class="inspector-head">
      <strong data-slot="name"></strong>
      <span class="hint" data-slot="where"></span>
    </div>
    <div class="inspector-grid">
      ${clip.kind === 'text' || clip.kind === 'card' ? `
        <label class="wide">${clip.kind === 'text' ? 'Name' : 'Text'}<input class="field" data-field="title" maxlength="120" /></label>
        <label class="wide">${clip.kind === 'text' ? 'Role or subtitle' : 'Small text'}<input class="field" data-field="subtitle" maxlength="80" /></label>` : ''}
      ${clip.kind === 'callout' ? `
        <label class="wide">Pop-up text<input class="field" data-field="title" maxlength="40" /></label>` : ''}
      <label>Track<select class="field" data-field="track">${options(tracksFor(clip.kind).map((track) => [track, trackLabel(track)]), clip.track)}</select></label>
      <label>Starts at (s)<input class="field" type="number" min="0" step="0.1" data-field="start" /></label>
      <label>Length (s)<input class="field" type="number" min="0.2" step="0.1" data-field="length" /></label>
      ${visual ? `<label>Position<select class="field" data-field="layout">${options(Object.entries(LAYOUTS), clip.layout)}</select></label>` : ''}
      ${visual && corner ? `<label>Size<input type="range" min="0.15" max="0.8" step="0.01" data-field="size" /></label>` : ''}
      ${hasSound ? `<label>Sound <output data-slot="volume"></output><input type="range" min="0" max="1" step="0.05" data-field="volume" /></label>` : ''}
      <label>Comes in<select class="field" data-field="transitionIn">${options(transitions, clip.transitionIn)}</select></label>
      <label>Goes out<select class="field" data-field="transitionOut">${options(transitions, clip.transitionOut)}</select></label>
      <label>Transition length<select class="field" data-field="transitionDuration">${options(TRANSITION_LENGTHS.map((value) => [value, `${value} s`]), clip.transitionDuration)}</select></label>
    </div>
    <div class="inspector-actions">
      <button class="button button-small" type="button" data-action="split">Split at playhead</button>
      <button class="button button-small button-danger" type="button" data-action="delete">Delete</button>
    </div>`;

  // User-supplied text goes in as text, never as markup.
  const field = (name) => ui.inspector.querySelector(`[data-field="${name}"]`);
  ui.inspector.querySelector('[data-slot="name"]').textContent =
    `${KIND_LABELS[clip.kind]}${media ? ` · ${media.name}` : ''}`;
  ui.inspector.querySelector('[data-slot="where"]').textContent =
    `${trackLabel(clip.track)} · ${formatTime(clip.start)} – ${formatTime(clipEnd(clip))}`;
  if (field('title')) field('title').value = clip.title;
  if (field('subtitle')) field('subtitle').value = clip.subtitle;
  field('start').value = clip.start.toFixed(1);
  field('length').value = clipLength(clip).toFixed(1);
  if (field('size')) field('size').value = clip.size;
  if (field('volume')) {
    field('volume').value = clip.volume;
    ui.inspector.querySelector('[data-slot="volume"]').textContent = `${Math.round(clip.volume * 100)}%`;
  }
}

ui.inspector.addEventListener('input', (event) => {
  const clip = selectedClip();
  const name = event.target.dataset.field;
  if (!clip || !name) return;
  const value = event.target.value;
  if (name === 'title' || name === 'subtitle') {
    clip[name] = value;
    tracks.render();
  } else if (name === 'size') {
    clip.size = Number(value);
  } else if (name === 'volume') {
    clip.volume = Number(value);
    ui.inspector.querySelector('[data-slot="volume"]').textContent = `${Math.round(clip.volume * 100)}%`;
  } else {
    return; // the rest apply on change, once the value is complete
  }
  clearResult();
});

ui.inspector.addEventListener('change', (event) => {
  const { project } = state;
  const clip = selectedClip();
  const name = event.target.dataset.field;
  if (!clip || !name) return;
  const value = event.target.value;
  let ok = true;
  if (name === 'track') {
    ok = moveClip(project, clip, clip.start, value);
  } else if (name === 'start') {
    ok = Number.isFinite(Number(value)) && moveClip(project, clip, Number(value));
  } else if (name === 'length') {
    ok = Number(value) > 0
      && trimClipEnd(project, clip, clip.start + Number(value), mediaOf(project, clip)?.duration ?? Infinity);
  } else if (name === 'layout' || name === 'transitionIn' || name === 'transitionOut') {
    clip[name] = value;
  } else if (name === 'transitionDuration') {
    clip.transitionDuration = Number(value);
  } else {
    return;
  }
  if (!ok) showStatus(`That doesn't fit: another clip is in the way on ${trackLabel(name === 'track' ? value : clip.track)}.`, 'warn');
  tracksChanged(true);
});

ui.inspector.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  const clip = selectedClip();
  if (!action || !clip) return;
  if (action === 'delete') deleteSelected();
  if (action === 'split') splitSelected();
});

function deleteSelected() {
  const clip = selectedClip();
  if (!clip) return;
  removeClip(state.project, clip.id);
  selectClip(null);
  tracksChanged(true);
}

function splitSelected() {
  const clip = selectedClip();
  if (!clip) return;
  const right = splitClip(state.project, clip, state.time);
  if (!right) {
    showStatus('Move the playhead inside the selected clip to split it there.', 'info');
    return;
  }
  selectClip(right.id);
  tracksChanged(true);
}

// --- Recording ---------------------------------------------------------------------

const capture = new Capture($('#capture'), {
  onStart: (mode, { follow, hear }) => {
    const startTime = state.time;
    if (mode === 'voice' && follow && state.project) {
      state.quiet = !hear;
      play();
    }
    return startTime;
  },
  onStop: (mode) => {
    if (mode === 'voice') {
      pause();
      state.quiet = false;
    }
  },
  onRecorded: async (file, { mode, startTime }) => {
    if (!state.project) {
      if (mode === 'voice') showStatus('Open a video first, then record a voice over it.', 'warn');
      else openFile(file);
      return;
    }
    const clip = await addFiles([file], startTime, { layout: DEFAULT_LAYOUT[mode] || 'full', quiet: true });
    if (clip) {
      showStatus(`Recording added on ${trackLabel(clip.track)} at ${formatTime(clip.start)}. ` +
        (mode === 'camera' ? 'It sits in a corner — change Position to make it full screen or a split screen.' : ''), 'info');
    }
  },
  onStatus: (message, kind) => showStatus(message, kind),
});

if (!Capture.supported()) {
  document.querySelectorAll('[data-needs-recorder]').forEach((element) => { element.hidden = true; });
}
document.querySelectorAll('[data-record]').forEach((button) => {
  button.addEventListener('click', () => {
    pause();
    capture.open(button.dataset.record);
  });
});

// --- Playback ----------------------------------------------------------------

function togglePlay() {
  if (!state.project) return;
  if (state.playing) pause();
  else play();
}

ui.play.addEventListener('click', togglePlay);
document.addEventListener('keydown', (event) => {
  if (!state.project || document.querySelector('dialog[open]') || document.body.dataset.view !== 'finetune') return;
  const typing = event.target.closest('input, select, textarea, button, [contenteditable]');
  if (event.code === 'Space' && !typing) {
    event.preventDefault();
    togglePlay();
  } else if ((event.key === 'Delete' || event.key === 'Backspace') && !typing && state.selectedClip) {
    event.preventDefault();
    deleteSelected();
  } else if (event.key.toLowerCase() === 's' && !typing && !event.ctrlKey && !event.metaKey && state.selectedClip) {
    splitSelected();
  } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !typing) {
    event.preventDefault();
    const step = (event.shiftKey ? 1 : 0.1) * (event.key === 'ArrowLeft' ? -1 : 1);
    pause();
    seek(state.time + step);
  }
});

// --- Style controls ----------------------------------------------------------

document.addEventListener('change', (event) => {
  const { project } = state;
  if (event.target.name === 'format') {
    if (project) project.format = event.target.value;
    sizePreviewCanvas();
    clearResult();
  } else if (event.target.name === 'framing') {
    if (project) project.framing = event.target.value;
    clearResult();
  } else if (event.target === ui.logo) {
    if (project) project.logo = ui.logo.value;
    clearResult();
  } else if (event.target === ui.joinTransition) {
    if (project) project.joinTransition = ui.joinTransition.value;
    tracks.render();
    clearResult();
  }
});

ui.mainVolume.addEventListener('input', () => {
  const volume = Number(ui.mainVolume.value);
  ui.mainVolumeValue.textContent = `${Math.round(volume * 100)}%`;
  if (state.project) state.project.mainVolume = volume;
  clearResult();
});

ui.headline.addEventListener('input', () => {
  if (state.project) state.project.headline = ui.headline.value;
  clearResult();
});

// --- Export ------------------------------------------------------------------

function clearResult() {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
  ui.result.hidden = true;
  ui.result.replaceChildren();
}

function setExporting(active) {
  ui.exportButton.disabled = active || !state.project;
  ui.exportButton.textContent = active ? 'Exporting…' : 'Export MP4';
  ui.progress.hidden = !active;
}

function downloadName(project) {
  const base = project.file.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').slice(0, 60) || 'video';
  return `${base}-${project.format.replace(':', 'x')}.mp4`;
}

ui.exportButton.addEventListener('click', async () => {
  const { project } = state;
  if (!project || state.exporting) return;
  if (!keptRanges(project).length && !project.clips.length) {
    showStatus('Nothing is left to export — put a removed part back or widen the trim.', 'error');
    return;
  }

  pause();
  clearResult();
  showStatus('');
  const controller = new AbortController();
  state.exporting = controller;
  setExporting(true);
  ui.progressFill.style.width = '0%';

  const started = performance.now();
  try {
    const result = await exportVideo(project, state.assets, {
      signal: controller.signal,
      onProgress: (fraction, message) => {
        ui.progressFill.style.width = `${Math.round(fraction * 100)}%`;
        ui.progressText.textContent = `${message} — ${Math.round(fraction * 100)}%`;
      },
    });

    state.resultUrl = URL.createObjectURL(result.blob);
    const seconds = ((performance.now() - started) / 1000).toFixed(0);
    const megabytes = (result.blob.size / 1e6).toFixed(1);
    const link = document.createElement('a');
    link.href = state.resultUrl;
    link.download = downloadName(project);
    link.className = 'button button-primary button-wide';
    link.textContent = `Download ${link.download}`;

    const summary = document.createElement('p');
    summary.className = 'hint';
    summary.textContent = `${formatTime(result.duration)} long · ${megabytes} MB · ` +
      `${result.videoCodec.toUpperCase()}${result.audioCodec ? ` + ${result.audioCodec.toUpperCase()}` : ', no sound'} · ` +
      `made in ${seconds}s`;

    ui.result.replaceChildren(link, summary);
    for (const warning of result.warnings) {
      const note = document.createElement('p');
      note.className = 'notice notice-warn';
      note.textContent = warning;
      ui.result.append(note);
    }
    ui.result.hidden = false;
    link.click();
  } catch (error) {
    if (controller.signal.aborted) showStatus('Export cancelled.', 'info');
    else showStatus(`Export failed: ${error.message}`, 'error');
  } finally {
    state.exporting = null;
    setExporting(false);
  }
});

ui.cancel.addEventListener('click', () => state.exporting?.abort());

// --- Start -------------------------------------------------------------------

buildFormatChoices();
sizePreviewCanvas();

if (!browserSupported()) {
  ui.unsupported.hidden = false;
  ui.file.disabled = true;
} else {
  loadAssets().then((assets) => { state.assets = assets; }).catch(() => {
    showStatus("The brand fonts didn't load, so headlines will use a fallback font.", 'warn');
  });
  // Warm the video engine in the background so the first export starts
  // promptly; a failure here is reported when the user actually exports.
  loadMediabunny().catch(() => {});
}

requestAnimationFrame(tick);

// Exposed for automated tests, which drive the editor without a mouse.
window.__studio = { state, openFile, addFiles, seek, play, pause, timeline, tracks };
