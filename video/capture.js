/**
 * Recording straight into the editor: the camera, the screen, or a voice.
 *
 *   camera  -- webcam and microphone, e.g. an intro, a reaction, a remote guest
 *   screen  -- a window or the whole screen, with the microphone over it
 *   voice   -- the microphone alone; by default the edit plays while you speak,
 *              so a voiceover lands exactly where it belongs
 *
 * The browser records WebM, which carries no length or seek index, so every
 * recording is rewritten as a proper MP4 (no re-encoding) before it reaches a
 * track. If that ever fails the raw recording is still handed back -- a take
 * is never lost.
 */

import { loadMediabunny } from './exporter.js';
import { formatTime } from './project.js';

const VIDEO_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

const TITLES = {
  camera: 'Record from the camera',
  screen: 'Record the screen',
  voice: 'Record a voiceover',
};
const LABELS = { camera: 'Camera', screen: 'Screen', voice: 'Voice' };

const firstSupported = (types) => types.find((type) => MediaRecorder.isTypeSupported(type)) || '';

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
}

/** Rewrite a browser recording as a seekable MP4 (or M4A for sound), copying the streams as they are. */
async function toMp4(blob, audioOnly) {
  const mb = await loadMediabunny();
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(blob) });
  try {
    const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
    const conversion = await mb.Conversion.init({ input, output });
    if (!conversion.isValid) throw new Error('This recording could not be converted.');
    await conversion.execute();
    return new Blob([output.target.buffer], { type: audioOnly ? 'audio/mp4' : 'video/mp4' });
  } finally {
    input.dispose();
  }
}

/** Explain why the browser said no, in words an office user can act on. */
function explain(error, mode) {
  const name = error?.name || '';
  const device = mode === 'screen' ? 'screen recording' : mode === 'voice' ? 'the microphone' : 'the camera and microphone';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return `The browser wasn't allowed to use ${device}. Click the camera icon in the address bar to allow it` +
      (mode === 'screen' ? ', or ask IT if screen recording is blocked on this PC.' : '.');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return mode === 'voice' ? 'No microphone was found on this computer.' : 'No camera was found on this computer.';
  }
  if (name === 'NotReadableError') {
    return `${device[0].toUpperCase()}${device.slice(1)} is in use by another program (Teams, Zoom…). Close it and try again.`;
  }
  return `Recording couldn't start: ${error?.message || error}`;
}

export class Capture {
  /**
   * @param dialog    the <dialog> element holding the recorder
   * @param hooks     { onRecorded(file, { mode, startTime }), onStart(mode) -> startTime, onStop(mode), onStatus(message, kind) }
   */
  constructor(dialog, hooks) {
    this.dialog = dialog;
    this.hooks = hooks;
    const $ = (selector) => dialog.querySelector(selector);
    this.ui = {
      title: $('#capture-title'),
      live: $('#capture-live'),
      voice: $('#capture-voice'),
      level: $('#capture-level'),
      camera: $('#capture-camera'),
      mic: $('#capture-mic'),
      followRow: $('#capture-follow-row'),
      follow: $('#capture-follow'),
      hearRow: $('#capture-hear-row'),
      hear: $('#capture-hear'),
      timer: $('#capture-timer'),
      start: $('#capture-start'),
      close: $('#capture-close'),
      note: $('#capture-note'),
    };
    this.mode = null;
    this.stream = null;
    this.extraStreams = [];
    this.recorder = null;
    this.audioContext = null;
    this.meterFrame = 0;

    this.ui.start.addEventListener('click', () => (this.recorder ? this.stop() : this.start()));
    this.ui.close.addEventListener('click', () => this.close());
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); this.close(); });
    this.ui.camera.addEventListener('change', () => this.preview());
    this.ui.mic.addEventListener('change', () => this.preview());
  }

  static supported() {
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  async open(mode) {
    this.mode = mode;
    const { ui } = this;
    ui.title.textContent = TITLES[mode];
    ui.live.hidden = mode === 'voice';
    ui.live.classList.toggle('is-mirrored', mode === 'camera');
    ui.voice.hidden = mode !== 'voice';
    ui.camera.hidden = mode !== 'camera';
    // Changing a device restarts the live view, which for the screen would ask to share it again.
    ui.mic.hidden = mode === 'screen';
    ui.followRow.hidden = mode !== 'voice';
    ui.hearRow.hidden = mode !== 'voice';
    ui.timer.textContent = '0:00';
    ui.note.textContent = mode === 'voice'
      ? 'The voice goes on an audio track, starting at the playhead.'
      : 'The recording goes on a video track at the playhead — or becomes the main video if none is open.';
    this.setRecording(false);
    if (!this.dialog.open) this.dialog.showModal();
    await this.preview();
  }

  /** (Re)start the live view with the chosen devices. */
  async preview() {
    const { ui, mode } = this;
    this.releaseStreams();
    ui.start.disabled = true;
    try {
      const audio = {
        deviceId: ui.mic.value ? { exact: ui.mic.value } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (mode === 'screen') {
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
        // The narration comes from the microphone, mixed with any sound the
        // shared tab or window makes.
        const mic = await navigator.mediaDevices.getUserMedia({ audio }).catch(() => null);
        this.extraStreams = [screen, mic].filter(Boolean);
        const audioTracks = [...screen.getAudioTracks(), ...(mic?.getAudioTracks() || [])];
        const tracks = [...screen.getVideoTracks()];
        if (audioTracks.length === 1) tracks.push(audioTracks[0]);
        else if (audioTracks.length > 1) tracks.push(this.mixTracks(audioTracks));
        this.stream = new MediaStream(tracks);
        // Stopping the share from the browser's own bar ends the take.
        screen.getVideoTracks()[0]?.addEventListener('ended', () => { if (this.recorder) this.stop(); });
      } else {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio,
          video: mode === 'camera'
            ? { deviceId: ui.camera.value ? { exact: ui.camera.value } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 } }
            : false,
        });
      }
      ui.live.srcObject = mode === 'voice' ? null : this.stream;
      await this.listDevices();
      this.startMeter();
      ui.start.disabled = false;
    } catch (error) {
      this.releaseStreams();
      if (mode === 'screen' && error?.name === 'NotAllowedError') {
        // Cancelling the browser's "choose what to share" box is not an error.
        this.close();
        return;
      }
      this.hooks.onStatus?.(explain(error, mode), 'error');
      this.close();
    }
  }

  mixTracks(tracks) {
    this.audioContext = this.audioContext || new AudioContext();
    const destination = this.audioContext.createMediaStreamDestination();
    for (const track of tracks) this.audioContext.createMediaStreamSource(new MediaStream([track])).connect(destination);
    return destination.stream.getAudioTracks()[0];
  }

  /** Fill the camera and microphone choices; labels only appear once permission is given. */
  async listDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const fill = (select, kind, fallback) => {
      const current = this.stream.getTracks().find((track) => track.kind === kind.replace('input', ''))?.getSettings().deviceId;
      const list = devices.filter((device) => device.kind === kind);
      select.replaceChildren(...list.map((device, index) => {
        const option = new Option(device.label || `${fallback} ${index + 1}`, device.deviceId);
        option.selected = device.deviceId === current;
        return option;
      }));
    };
    fill(this.ui.camera, 'videoinput', 'Camera');
    fill(this.ui.mic, 'audioinput', 'Microphone');
  }

  /** A live level bar, so a muted or wrong microphone is obvious before recording. */
  startMeter() {
    cancelAnimationFrame(this.meterFrame);
    const track = this.stream.getAudioTracks()[0];
    if (!track) { this.ui.level.style.width = '0%'; return; }
    this.audioContext = this.audioContext || new AudioContext();
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 1024;
    this.audioContext.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const draw = () => {
      analyser.getFloatTimeDomainData(data);
      let peak = 0;
      for (const value of data) peak = Math.max(peak, Math.abs(value));
      this.ui.level.style.width = `${Math.min(100, Math.round(Math.sqrt(peak) * 100))}%`;
      this.meterFrame = requestAnimationFrame(draw);
    };
    draw();
  }

  setRecording(active) {
    const { ui } = this;
    ui.start.textContent = active ? 'Stop and use it' : 'Start recording';
    ui.start.classList.toggle('is-recording', active);
    ui.camera.disabled = active;
    ui.mic.disabled = active;
    ui.follow.disabled = active;
    ui.hear.disabled = active;
    ui.close.textContent = active ? 'Discard' : 'Close';
  }

  start() {
    if (!this.stream) return;
    const audioOnly = this.mode === 'voice';
    const mimeType = firstSupported(audioOnly ? AUDIO_TYPES : VIDEO_TYPES);
    const recorder = new MediaRecorder(this.stream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: audioOnly ? undefined : 8_000_000,
      audioBitsPerSecond: 160_000,
    });
    const chunks = [];
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
    this.chunks = chunks;
    this.recorder = recorder;
    this.startTime = this.hooks.onStart?.(this.mode, {
      follow: this.ui.follow.checked,
      hear: this.ui.hear.checked,
    }) ?? 0;
    recorder.start(1000);
    const began = performance.now();
    this.timer = setInterval(() => {
      this.ui.timer.textContent = formatTime((performance.now() - began) / 1000, false);
    }, 250);
    this.setRecording(true);
  }

  async stop() {
    const recorder = this.recorder;
    if (!recorder) return;
    this.recorder = null;
    clearInterval(this.timer);
    this.hooks.onStop?.(this.mode);
    await new Promise((resolve) => {
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.stop();
    });
    const mode = this.mode;
    const startTime = this.startTime;
    const audioOnly = mode === 'voice';
    const raw = new Blob(this.chunks, { type: recorder.mimeType });
    this.ui.start.disabled = true;
    this.ui.start.textContent = 'Saving…';
    this.close(true);

    const base = `${LABELS[mode]} ${stamp()}`;
    let file;
    try {
      const mp4 = await toMp4(raw, audioOnly);
      file = new File([mp4], `${base}.${audioOnly ? 'm4a' : 'mp4'}`, { type: mp4.type });
    } catch {
      // Keep the take whatever happens: hand back the browser's own file.
      file = new File([raw], `${base}.webm`, { type: raw.type || (audioOnly ? 'audio/webm' : 'video/webm') });
    }
    this.hooks.onRecorded?.(file, { mode, startTime });
  }

  /** Close the recorder. A take in progress is discarded only after asking. */
  close(force = false) {
    if (this.recorder && !force) {
      if (!window.confirm('Discard this recording?')) return;
      const recorder = this.recorder;
      this.recorder = null;
      clearInterval(this.timer);
      this.hooks.onStop?.(this.mode);
      recorder.stop();
    }
    this.releaseStreams();
    cancelAnimationFrame(this.meterFrame);
    this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    if (this.dialog.open) this.dialog.close();
  }

  releaseStreams() {
    for (const stream of [this.stream, ...this.extraStreams]) stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.extraStreams = [];
    this.ui.live.srcObject = null;
  }
}
