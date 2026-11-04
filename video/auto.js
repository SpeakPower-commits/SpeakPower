/**
 * The automatic editor: upload, instruction, "Edit my video", results.
 *
 * Runs the whole edit in this tab:
 *
 *   listen (Whisper) -> clean (pauses, "um"s) -> load the free AI
 *   -> choose the best moments -> write titles and post text
 *   -> build each edit with its graphics -> render each to MP4
 *
 * Every step is saved in this browser as it finishes (edits.js), and every
 * finished video the moment it is done. Leaving the page, reloading or
 * closing the tab pauses the edit; it never loses it. "Your edits" lists them:
 * Resume skips the finished steps -- no second transcription, no second use
 * of the plan -- and Open shows the videos again.
 *
 * Each result can be downloaded, or opened in the editor ("Fine-tune") to
 * change anything by hand.
 */

import { loadProject } from './app.js';
import { extractSpeechAudio, transcribeSamples } from './speech.js';
import { finishJob, memberSession, refundJob, startJob, transcribeRemote } from './remote.js';
import { exportVideo } from './exporter.js';
import {
  cleanupEdits, deleteEdit, editSize, holdEdit, isRunningElsewhere, keepSource, listEdits, loadEdit,
  loadResultFile, matchesSource, newEditId, persist, reopenSource, saveEdit, saveResultFile, space,
} from './edits.js';
import { loadAssets } from './renderer.js';
import { formatTime, sourceToOutput } from './project.js';
import { probeMedia } from './media.js';
import { Brain } from './brain.js';
import { ROLES, addToKit, kitMedia, loadKit, removeFromKit, setKeywords, setRole, stickerWords } from './brandkit.js';
import * as edit from './autoedit.js';

const $ = (selector) => document.querySelector(selector);

const ui = {
  drop: $('#auto-drop'),
  file: $('#auto-file'),
  fileName: $('#auto-file-name'),
  fileInfo: $('#auto-file-info'),
  prompt: $('#auto-prompt'),
  outEpisode: $('#out-episode'),
  outClips: $('#out-clips'),
  outClipCount: $('#out-clip-count'),
  outText: $('#out-text'),
  captions: $('#opt-captions'),
  callouts: $('#opt-callouts'),
  logo: $('#opt-logo'),
  language: $('#opt-language'),
  look: $('#opt-look'),
  emojis: $('#opt-emojis'),
  graphics: $('#opt-graphics'),
  stickers: $('#opt-stickers'),
  quality: $('#opt-quality'),
  saved: $('#auto-saved'),
  savedList: $('#auto-saved-list'),
  savedSpace: $('#auto-saved-space'),
  go: $('#auto-go'),
  progress: $('#auto-progress'),
  stages: $('#auto-stages'),
  fill: $('#auto-fill'),
  progressText: $('#auto-progress-text'),
  cancel: $('#auto-cancel'),
  status: $('#auto-status'),
  results: $('#auto-results'),
  outputs: $('#auto-outputs'),
  post: $('#auto-post'),
  kitAdd: $('#kit-add'),
  kitList: $('#kit-list'),
  toManual: $('#to-manual'),
  toAuto: $('#to-auto'),
  gateOffline: $('#sv-offline'),
  gateStart: $('#sv-start'),
  gateStartButton: $('#sv-start-btn'),
  workspace: $('#sv-workspace'),
  account: $('#sv-account'),
  accountStatus: $('#sv-status'),
  usage: $('#sv-usage'),
  topup: $('#sv-topup'),
};

const A = () => window.SPAccount;
const PAGE = 'video.html';

const state = {
  file: null,
  handle: null,      // a pointer to the video on the PC, where the browser gives one
  meta: null,
  kit: [],
  running: null,     // AbortController while an edit runs
  record: null,      // the saved edit being run or shown (edits.js)
  urls: [],          // result object URLs, released before the next edit
  results: [],
};

const Work = () => window.SPWork; // activity.js: the header chip and leave-safety
const workId = (record) => `video:${record.id}`;

const PAGE_TITLE = document.title;

// --- Views ---------------------------------------------------------------------------

function showView(view) {
  document.body.dataset.view = view;
  window.scrollTo({ top: 0 });
}

ui.toManual.addEventListener('click', () => showView('finetune'));
ui.toAuto.addEventListener('click', () => showView('auto'));

function showStatus(message, kind = 'info') {
  ui.status.hidden = !message;
  ui.status.textContent = message || '';
  ui.status.className = `notice notice-${kind}`;
}

// --- Choosing the video --------------------------------------------------------------

async function chooseFile(file, handle = null) {
  if (!file || state.running) return;
  showStatus('');
  try {
    const media = await probeMedia(file);
    if (media.kind !== 'video') throw new Error(`"${file.name}" has no picture. Choose a video file.`);
    state.file = file;
    state.handle = handle;
    state.meta = { duration: media.duration, width: media.width, height: media.height };
    URL.revokeObjectURL(media.url);
    ui.fileName.textContent = file.name;
    ui.fileInfo.textContent = `${formatTime(media.duration, false)} long · ${media.width}×${media.height} · ${(file.size / 1e6).toFixed(0)} MB · stays on this computer`;
    ui.drop.classList.add('has-file');
    ui.go.disabled = false;
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

ui.file.addEventListener('change', () => chooseFile(ui.file.files[0]));

// Chrome and Edge: choose through the file picker, which also gives a pointer
// to the file, so a paused edit can reopen it without asking for it again.
ui.drop.addEventListener('click', async (event) => {
  if (typeof window.showOpenFilePicker !== 'function' || state.running) return;
  event.preventDefault();
  try {
    const [handle] = await window.showOpenFilePicker({
      id: 'speakpower-video',
      types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.mov', '.m4v', '.webm', '.mkv'] } }],
    });
    chooseFile(await handle.getFile(), handle);
  } catch (error) {
    if (error.name !== 'AbortError') ui.file.click(); // the picker isn't allowed here: use the plain one
  }
});

document.addEventListener('drop', (event) => {
  if (document.body.dataset.view !== 'auto') return;
  const items = [...(event.dataTransfer?.items || [])].filter((item) => item.kind === 'file');
  const files = [...(event.dataTransfer?.files || [])];
  const index = Math.max(0, files.findIndex((item) => item.type.startsWith('video/')));
  // The handle must be asked for now, while the drop is still being handled.
  const handlePromise = items[index]?.getAsFileSystemHandle?.() || Promise.resolve(null);
  handlePromise.catch(() => null).then((handle) => chooseFile(files[index], handle?.kind === 'file' ? handle : null));
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    ui.prompt.value = chip.dataset.prompt;
    ui.prompt.focus();
  });
});

// --- Brand kit -------------------------------------------------------------------------

function renderKit() {
  ui.kitList.replaceChildren(...state.kit.map((item) => {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'kit-name';
    name.textContent = item.name;
    name.title = item.name;
    const role = document.createElement('select');
    role.className = 'field field-inline';
    role.setAttribute('aria-label', `Use ${item.name} as`);
    for (const [value, label] of Object.entries(ROLES)) role.append(new Option(label, value, false, value === item.role));
    role.addEventListener('change', () => { setRole(item, role.value).then(renderKit); });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button-link';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      await removeFromKit(item);
      state.kit = state.kit.filter((entry) => entry !== item);
      renderKit();
    });
    row.append(name, role, remove);
    if (item.role === 'sticker') {
      // A sticker appears when one of its words is said.
      const words = document.createElement('input');
      words.className = 'field kit-words';
      words.maxLength = 200;
      words.placeholder = `Show when I say… e.g. ${stickerWords(item).slice(0, 2).join(', ') || 'growth, team'}`;
      words.value = item.keywords || '';
      words.setAttribute('aria-label', `Words that show ${item.name}`);
      words.addEventListener('change', () => setKeywords(item, words.value));
      row.append(words);
    }
    return row;
  }));
}

ui.kitAdd.addEventListener('change', async () => {
  const files = [...ui.kitAdd.files];
  ui.kitAdd.value = '';
  for (const file of files) state.kit.push(await addToKit(file, state.kit));
  renderKit();
});

loadKit().then((items) => { state.kit = items; renderKit(); });

// --- Progress --------------------------------------------------------------------------

// Share of the whole job each stage takes, for one honest progress bar.
const STAGES = [
  { id: 'listen', label: 'Ngoma is listening — turning speech into text', weight: 0.34 },
  { id: 'clean', label: 'Cleaning out long pauses and "um"s', weight: 0.02 },
  { id: 'brain', label: 'Ngoma is getting ready (first time: a free AI download)', weight: 0.1 },
  { id: 'choose', label: 'Choosing the best moments', weight: 0.1 },
  { id: 'write', label: 'Writing titles, designing graphics and the post', weight: 0.06 },
  { id: 'render', label: 'Rendering your videos', weight: 0.38 },
];

let currentStage = null;

function renderStages() {
  ui.stages.replaceChildren(...STAGES.map((stage) => {
    const item = document.createElement('li');
    item.dataset.stage = stage.id;
    item.textContent = stage.label;
    return item;
  }));
}

function setStage(id, detail = '') {
  const index = STAGES.findIndex((stage) => stage.id === id);
  [...ui.stages.children].forEach((item, position) => {
    item.className = position < index ? 'is-done' : position === index ? 'is-active' : '';
  });
  currentStage = index;
  setProgress(0, detail);
}

function setProgress(fraction, detail = '') {
  const before = STAGES.slice(0, currentStage).reduce((total, stage) => total + stage.weight, 0);
  const overall = Math.min(1, before + STAGES[currentStage].weight * Math.min(1, Math.max(0, fraction)));
  const percent = Math.round(overall * 100);
  ui.fill.style.width = `${percent}%`;
  ui.progressText.textContent = detail ? `${detail} — ${percent}% overall` : `${percent}% overall`;
  document.title = `${percent}% · Ngoma is editing — SpeakPower`;
  if (state.record) {
    state.record.percent = percent;
    state.record.stage = STAGES[currentStage].id;
    Work()?.set(workId(state.record), {
      label: 'Ngoma', href: `${PAGE}#edit=${state.record.id}`, status: 'running', percent,
      detail: STAGES[currentStage].label.split(' — ')[0],
    });
  }
}

function notifyDone(message) {
  document.title = PAGE_TITLE;
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('Ngoma · SpeakPower', { body: message, icon: new URL('./brand/speakpower-badge.png', import.meta.url).href }); } catch { /* not allowed here */ }
  }
}

// --- Results ---------------------------------------------------------------------------

function clearResults() {
  for (const url of state.urls) URL.revokeObjectURL(url);
  state.urls = [];
  state.results = [];
  ui.outputs.replaceChildren();
  ui.post.replaceChildren();
  ui.post.hidden = true;
  ui.results.hidden = true;
}

const sourceName = () => state.record?.name || state.file?.name || 'video';
const safeName = (name) => name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').slice(0, 50) || 'video';

function addOutputCard(result) {
  const url = URL.createObjectURL(result.blob);
  state.urls.push(url);
  state.results.push(result);
  const format = result.format || result.project.format;
  const card = document.createElement('article');
  card.className = 'output';
  const video = document.createElement('video');
  video.src = url;
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.className = `output-video format-${format.replace(':', 'x')}`;
  const title = document.createElement('h3');
  title.textContent = result.label;
  const info = document.createElement('p');
  info.className = 'hint';
  info.textContent = `${formatTime(result.duration, false)} · ${format} · ${(result.blob.size / 1e6).toFixed(1)} MB` +
    (result.note ? ` · ${result.note}` : '');
  const actions = document.createElement('div');
  actions.className = 'output-actions';
  const download = document.createElement('a');
  download.className = 'button button-primary button-small';
  download.href = url;
  download.download = result.fileName;
  download.textContent = 'Download';
  const tune = document.createElement('button');
  tune.type = 'button';
  tune.className = 'button button-small';
  tune.textContent = 'Fine-tune';
  tune.addEventListener('click', () => fineTune(result, tune));
  actions.append(download, tune);
  card.append(video, title, info, actions);
  ui.outputs.append(card);
  ui.results.hidden = false;
}

function showPost(post) {
  const sections = [
    ['Title', post.title],
    ['Description', post.description],
    ['Hashtags', post.hashtags.join(' ')],
    ['Chapters (for YouTube)', post.chapters],
  ].filter(([, value]) => value);
  const heading = document.createElement('h3');
  heading.textContent = 'Text for posting';
  ui.post.replaceChildren(heading);
  for (const [label, value] of sections) {
    const block = document.createElement('div');
    block.className = 'post-field';
    const name = document.createElement('strong');
    name.textContent = label;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'button-link';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => navigator.clipboard?.writeText(value).then(() => { copy.textContent = 'Copied'; }));
    const text = document.createElement('p');
    text.textContent = value;
    block.append(name, copy, text);
    ui.post.append(block);
  }
  const all = sections.map(([label, value]) => `${label.toUpperCase()}\n${value}`).join('\n\n');
  const url = URL.createObjectURL(new Blob([all], { type: 'text/plain' }));
  state.urls.push(url);
  const download = document.createElement('a');
  download.className = 'button button-small';
  download.href = url;
  download.download = `${safeName(sourceName())}-post.txt`;
  download.textContent = 'Download as .txt';
  const griot = document.createElement('button');
  griot.type = 'button';
  griot.className = 'button button-small';
  griot.textContent = 'Save transcript to GRIOT';
  griot.title = 'Adds the transcript to your GRIOT documents, so GRIOT can plan, challenge or diagnose with this episode.';
  griot.addEventListener('click', () => saveToGriot(griot));
  const actions = document.createElement('div');
  actions.className = 'output-actions';
  actions.append(download, griot);
  ui.post.append(actions);
  ui.post.hidden = false;
  ui.results.hidden = false;
}

// --- The edit --------------------------------------------------------------------------

// Choosing a look sets its parts; the tick boxes can then change them one by one.
function showLook(look) {
  const parts = edit.LOOKS[look] || edit.LOOKS.classic;
  if (ui.callouts) ui.callouts.checked = parts.callouts;
  if (ui.emojis) ui.emojis.checked = parts.emojis;
  if (ui.graphics) ui.graphics.checked = parts.keyPoints;
}
ui.look?.addEventListener('change', () => showLook(ui.look.value));

function readSettings() {
  const look = ui.look?.value || 'classic';
  const parts = edit.LOOKS[look] || edit.LOOKS.classic;
  const graphics = ui.graphics ? ui.graphics.checked : parts.keyPoints;
  const base = {
    ...edit.DEFAULT_SETTINGS,
    ...parts,
    look,
    emojis: ui.emojis ? ui.emojis.checked : parts.emojis,
    icons: graphics,
    keyPoints: graphics,
    stats: graphics,
    lists: graphics,
    zooms: graphics && parts.zooms !== false && look !== 'clean',
    stickers: ui.stickers ? ui.stickers.checked : true,
    episode: ui.outEpisode.checked,
    clips: ui.outClips.checked,
    postText: ui.outText.checked,
    clipCount: Number(ui.outClipCount.value),
    captions: ui.captions.checked,
    callouts: ui.callouts.checked,
    logo: ui.logo.checked,
    endCard: ui.logo.checked,
  };
  return edit.parseInstruction(ui.prompt.value, base);
}

/**
 * Turn the sound into words. A member's edit reserves one use and is heard by
 * the website's Whisper; if the website can't be reached it is heard here, in
 * the browser, instead. Returns null when the member must act first (sign in,
 * finish the profile, or choose a plan): nothing has been spent then.
 *
 * The website's job and every piece it has heard are saved on the record, so
 * a resumed edit sends only the pieces still missing, on the same use.
 */
async function listen(samples, signal, notes, record, retried = false) {
  const progress = (stage) => (fraction) => setProgress(0.1 + 0.9 * fraction, stage);
  let job = record.listenJob;
  // The website keeps a job for six hours; an older one must start again.
  if (job && Date.now() - (job.startedAt || 0) > 5.5 * 3600e3) job = null;
  if (!job) {
    try {
      const started = await startJob(record.meta.duration, { name: record.name, instruction: record.instruction, look: record.settings?.look });
      job = { job: started.job, chunkSeconds: started.chunkSeconds, startedAt: Date.now(), pieces: {} };
      record.listenJob = job;
      record.serverJob = started.job; // kept after listening, to tell the history what the edit made
      await saveEdit(record);
    } catch (error) {
      if (error.status === 401) { showGate(); return null; }
      if (A().handleProfileRequired(error, PAGE)) return null;
      if (error.status === 402) { showPlanWall(error.data); return null; }
      if (error.status === 400) throw error; // e.g. longer than two hours
      notes.push("The website's speech service couldn't be reached, so this browser listened instead (less accurate on names).");
    }
  }
  if (job) {
    A().refresh().then(renderAccount, () => {});
    let heard = Object.values(job.pieces || {}).filter((piece) => !piece.silent).length;
    let closed = false;
    try {
      const result = await transcribeRemote(samples, {
        job: job.job,
        chunkSeconds: job.chunkSeconds,
        language: record.language,
        signal,
        done: job.pieces,
        onPiece: (index, piece) => { job.pieces[index] = piece; saveEdit(record); },
        onProgress: progress('Listening'),
      });
      heard = result.heard;
      if (result.segments.length) return result;
    } catch (error) {
      if (signal.aborted) throw error;
      if (typeof error.heard === 'number') heard = error.heard;
      // A resumed job the website has closed: start a fresh one, once.
      closed = [404, 410].includes(error.status) || error.data?.error === 'job_used_up';
      if (closed && !retried && Object.keys(job.pieces || {}).length) {
        record.listenJob = null;
        return listen(samples, signal, notes, record, true);
      }
      notes.push("The website's speech service stopped part-way, so this browser finished listening.");
    } finally {
      if (!heard && !closed) refundJob(job.job).then(() => A().refresh().then(renderAccount, () => {}));
    }
  }
  return transcribeSamples(samples, {
    model: 'accurate',
    language: record.language,
    signal,
    onProgress: (stage, fraction) => setProgress(0.1 + 0.9 * fraction, stage),
  });
}

/** The videos to render, clips first (they are quickest), then the full episode. */
function buildJobs(record, file, kit) {
  const { segments } = record.heard;
  const words = segments.flatMap((segment) => segment.words);
  const { settings, plan } = record;
  const shared = { file, meta: record.meta, segments, words, cuts: record.cleaned.cuts, settings, kit };
  const base = safeName(record.name);
  const jobs = plan.clipPlans.map((clip, index) => ({
    id: `clip-${index + 1}`,
    project: edit.buildClip({ ...shared, window: clip.window, hook: clip.hook, phrases: clip.phrases }).project,
    label: `Clip ${index + 1}: ${clip.hook}`,
    fileName: `${base}-clip-${index + 1}.mp4`,
  }));
  let episodeProject = null;
  if (settings.episode) {
    episodeProject = edit.buildEpisode({ ...shared, title: plan.post.title, chapters: plan.chapters }).project;
    const removed = record.cleaned.removed;
    jobs.push({
      id: 'episode',
      project: episodeProject,
      label: 'Full episode — cleaned',
      fileName: `${base}-episode.mp4`,
      note: removed > 1 ? `${formatTime(removed, false)} of pauses and "um"s removed` : '',
    });
  }
  return { jobs, episodeProject };
}

/** Start a new edit of the chosen video. */
async function run() {
  const { file, meta } = state;
  if (!file || state.running) return;
  if (!memberSession()) { showGate(); return; }
  const instruction = ui.prompt.value.trim() || 'Make an engaging, professional edit.';
  const settings = readSettings();
  if (!settings.episode && !settings.clips && !settings.postText) {
    showStatus('Tick at least one thing to make: the full episode, clips or post text.', 'warn');
    return;
  }
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  // Busy from this moment: a second click must not start a second edit while this one is being saved.
  state.running = new AbortController();
  ui.go.disabled = true;

  const record = {
    id: newEditId(),
    createdAt: Date.now(),
    status: 'running',
    stage: 'listen',
    percent: 0,
    instruction,
    settings,
    language: ui.language.value,
    fast: ui.quality?.value === 'fast',
    meta,
    results: [],
    notes: [],
  };
  // Remembering the video (a pointer, or a copy) runs alongside the edit.
  const keeping = keepSource(record, file, state.handle);
  await saveEdit(record);
  persist();
  await execute(record, file, keeping);
}

/** Run (or carry on with) an edit in this tab, unless another tab already is. */
async function execute(record, file, keeping = null) {
  const outcome = await holdEdit(record.id, () => work(record, file, keeping));
  if (outcome?.busy) {
    state.running = null;
    ui.go.disabled = !state.file;
    showStatus('This edit is already running in another tab. Its progress shows in "Your edits" and in the header.', 'info');
  }
  renderSaved();
}

async function work(record, file, keeping) {
  const controller = new AbortController();
  const { signal } = controller;
  const release = Work()?.guard('Ngoma is editing your video…') || (() => {});
  state.running = controller;
  state.record = record;
  state.file = file;
  state.meta = record.meta;
  record.status = 'running';
  record.error = '';
  record.notes = record.notes || [];
  clearResults();
  showStatus('');
  renderStages();
  ui.progress.hidden = false;
  ui.go.disabled = true;
  ui.go.textContent = 'Editing…';
  const brain = new Brain();
  const notes = record.notes;
  const settings = record.settings;
  const instruction = record.instruction;
  renderSaved();

  // Videos already finished (a resumed edit) are shown straight away.
  for (const result of record.results) {
    const blob = await loadResultFile(record.id, result.id);
    if (blob) addOutputCard({ ...result, blob });
  }

  try {
    // 1. Listen, then 2. clean: saved together, as the sound itself is not kept.
    if (!record.heard) {
      setStage('listen', 'Reading the sound');
      let samples = await extractSpeechAudio(file, { signal, onProgress: (fraction) => setProgress(0.1 * fraction, 'Reading the sound') });
      const heard = await listen(samples, signal, notes, record);
      if (!heard) {
        // The plan wall, sign-in or profile step is showing. Nothing was spent on a new edit.
        if (record.listenJob) { record.status = 'paused'; await saveEdit(record); }
        else { await deleteEdit(record.id); Work()?.remove(workId(record)); }
        return;
      }
      const { segments, wordLevel } = heard;
      if (!segments.length) throw new Error('No speech was found in this video, so there is nothing to edit by.');
      setStage('clean');
      const words = segments.flatMap((segment) => segment.words);
      const levels = edit.frameLevels(samples);
      samples = null; // let the sound go: it can be hundreds of MB
      const cuts = edit.cleanupCuts({ levels, words, wordLevel }, settings);
      record.heard = { segments, wordLevel };
      record.cleaned = { cuts, removed: cuts.reduce((total, cut) => total + (cut.end - cut.start), 0) };
      // For GRIOT: the words as the clean edit says them, one line per sentence.
      record.transcript = segments.map((segment) => edit.cleanText(segment.text)).filter(Boolean).join('\n');
      record.listenJob = null;
      await saveEdit(record);
    }
    state.transcript = record.transcript;
    const units = record.heard.segments;
    const words = units.flatMap((segment) => segment.words);

    // 3-5. The free AI chooses the moments and writes the words.
    if (!record.plan) {
      setStage('brain', 'Downloading the AI (first time only)');
      const smart = await brain.load((fraction) => setProgress(fraction, 'Downloading the AI (first time only)'), signal);
      signal.throwIfAborted();
      if (!smart) notes.push(`The free AI couldn't load (${brain.error}), so the simpler built-in method chose the moments and wrote the titles.`);

      const blocks = edit.blocksFrom(units, 45);
      const topicWords = edit.keywords(settings.topic);

      setStage('choose');
      let picks = [];
      if (settings.clips) {
        const windows = edit.candidateWindows(units, { min: settings.clipMin, max: settings.clipMax });
        const blockScores = [];
        if (smart) {
          for (let index = 0; index < blocks.length; index += 1) {
            signal.throwIfAborted();
            setProgress(index / blocks.length, `Watching part ${index + 1} of ${blocks.length}`);
            blockScores.push(await brain.score(blocks[index].text, instruction));
          }
        }
        picks = edit.pickClips(edit.scoreWindows(units, windows, { blocks, blockScores, topicWords }), settings.clipCount);
      }

      setStage('write');
      const clipPlans = [];
      for (let index = 0; index < picks.length; index += 1) {
        signal.throwIfAborted();
        setProgress(index / (picks.length + 2), `Titles for clip ${index + 1}`);
        const window = picks[index];
        const text = units.slice(window.first, window.last + 1).map((unit) => unit.text).join(' ');
        const idea = smart ? await brain.hook(text, instruction) : null;
        let phrases = (idea?.phrases || [])
          .map((phrase) => ({ text: phrase, time: edit.locatePhrase(words, phrase, window.start, window.end) }))
          .filter((phrase) => phrase.time !== null);
        if (phrases.length < 2) phrases = [...phrases, ...edit.fallbackPhrases(words, window.start, window.end, topicWords, 4 - phrases.length)];
        clipPlans.push({ window, hook: idea?.title || edit.fallbackTitle(text), phrases });
      }

      let chapters = [];
      if ((settings.episode || settings.postText) && record.meta.duration > 360) {
        chapters = edit.chaptersFrom(blocks, 180);
        for (const chapter of chapters) {
          signal.throwIfAborted();
          chapter.title = (smart ? await brain.chapter(chapter.text) : null) || edit.fallbackChapterTitle(chapter.text);
        }
      }
      setProgress(0.8, 'Post text');
      const gist = blocks.map((block) => block.text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ')).join(' ');
      const fallbackPost = edit.fallbackPost(units, chapters, topicWords);
      const aiPost = smart && (settings.postText || settings.episode) ? await brain.post(gist, instruction) : null;
      const post = {
        title: aiPost?.title || fallbackPost.title,
        description: aiPost?.description || fallbackPost.description,
        hashtags: aiPost?.hashtags?.length ? aiPost.hashtags : fallbackPost.hashtags,
      };
      brain.dispose(); // free the AI's memory before rendering
      record.plan = { clipPlans, chapters, post, smart: Boolean(smart), device: smart ? brain.device : '' };
      await saveEdit(record);
    }

    // 6. Build and render; each video is saved the moment it is finished.
    setStage('render');
    const [assets, kit] = await Promise.all([loadAssets(), kitMedia(state.kit)]);
    for (const problem of kit.problems) if (!notes.includes(problem)) notes.push(problem);
    const { jobs, episodeProject } = buildJobs(record, file, kit);
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      if (record.results.some((result) => result.id === job.id)) continue;
      const result = await exportVideo(job.project, assets, {
        signal,
        fast: record.fast,
        onProgress: (fraction) => setProgress((index + fraction) / jobs.length, `Rendering ${index + 1} of ${jobs.length}`),
      });
      const saved = {
        id: job.id,
        label: job.label,
        fileName: job.fileName,
        note: job.note || '',
        duration: result.duration,
        format: job.project.format,
        size: result.blob.size,
        warnings: result.warnings || [],
      };
      await saveResultFile(record.id, job.id, result.blob).catch((error) => {
        notes.push(`This browser couldn't keep "${job.label}" for later (${error.message}): download it now.`);
      });
      record.results.push(saved);
      await saveEdit(record);
      addOutputCard({ ...saved, blob: result.blob, project: job.project });
    }

    if (settings.postText) {
      const chapterLines = record.plan.chapters.length && episodeProject
        ? record.plan.chapters.map((chapter) => `${edit.formatChapterTime(sourceToOutput(episodeProject, chapter.start))} ${chapter.title}`).join('\n')
        : '';
      record.postText = { ...record.plan.post, chapters: chapterLines };
      showPost(record.postText);
    }

    [...ui.stages.children].forEach((item) => { item.className = 'is-done'; });
    ui.fill.style.width = '100%';
    ui.progressText.textContent = 'Done';
    // Export notes (e.g. this browser's sound format) are the same for every video: say them once.
    const summary = summaryOf(record);
    record.status = 'done';
    record.percent = 100;
    if (keeping) await keeping.catch(() => {});
    if (record.serverJob && !record.serverFinished) {
      const reply = await finishJob(record.serverJob, record.results);
      record.serverFinished = reply.saved !== false || reply.status === 'done';
    }
    await saveEdit(record);
    showStatus([summary, ...allNotes(record)].join(' '), allNotes(record).length ? 'warn' : 'info');
    Work()?.set(workId(record), { label: 'Ngoma', href: `${PAGE}#edit=${record.id}`, status: 'done', detail: summary.replace(/ —.*$/, '') });
    notifyDone(summary);
  } catch (error) {
    document.title = PAGE_TITLE;
    if (signal.aborted) {
      record.status = 'paused';
      showStatus('Editing paused. Everything finished so far is kept: resume it from "Your edits" any time.', 'info');
    } else {
      record.status = 'failed';
      record.error = error.message;
      showStatus(`The edit stopped: ${error.message} Resume it from "Your edits" to try again from where it stopped.`, 'error');
    }
    if (keeping) await keeping.catch(() => {});
    await saveEdit(record);
    Work()?.set(workId(record), {
      label: 'Ngoma', href: `${PAGE}#edit=${record.id}`, status: record.status,
      detail: record.status === 'paused' ? `Paused at ${record.percent || 0}%` : 'Stopped: open it to try again',
    });
  } finally {
    brain.dispose();
    release();
    state.running = null;
    ui.progress.hidden = true;
    ui.go.disabled = !state.file;
    ui.go.textContent = 'Edit my video';
    renderSaved();
  }
}

const allNotes = (record) => [...new Set([...(record.notes || []), ...record.results.flatMap((result) => result.warnings || [])])];

function summaryOf(record) {
  const count = record.results.length;
  return `Ngoma made ${count} video${count === 1 ? '' : 's'}` +
    (record.plan?.smart ? ` — moments chosen and titled by its free AI (${record.plan.device}).` : '.');
}

// --- Saved edits -----------------------------------------------------------------------

/** The video an edit was made from: without asking where possible, else one click or one choice. */
async function sourceFor(record) {
  if (state.file && matchesSource(state.file, record)) return state.file;
  let found = await reopenSource(record);
  if (found.needs === 'permission') found = await found.ask().catch(() => ({ needs: 'file' }));
  if (found.file) return found.file;
  showStatus(`Choose "${record.name}" again to carry on${found.changed ? ' (it has changed since)' : ''}. It stays on this computer.`, 'info');
  const file = await pickFile();
  if (!file) return null;
  if (!matchesSource(file, record)) {
    showStatus(`That isn't "${record.name}" (${(record.size / 1e6).toFixed(0)} MB). Choose the same video the edit was made from.`, 'warn');
    return null;
  }
  showStatus('');
  return file;
}

function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.addEventListener('change', () => resolve(input.files[0] || null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

async function resume(record) {
  if (state.running) { showStatus('Another edit is running in this tab. Wait for it, or pause it first.', 'info'); return; }
  if (!memberSession() && !record.heard) { showGate(); return; }
  const file = await sourceFor(record);
  if (!file || state.running) return;
  state.running = new AbortController();
  window.scrollTo({ top: ui.progress.offsetTop - 80 });
  await execute(record, file);
}

/** Show a saved edit's videos and post text. */
async function openEdit(record) {
  if (state.running) return;
  clearResults();
  state.record = record;
  state.transcript = record.transcript || '';
  for (const result of record.results) {
    const blob = await loadResultFile(record.id, result.id);
    if (blob) addOutputCard({ ...result, blob });
  }
  if (record.postText) showPost(record.postText);
  if (record.status === 'done') showStatus([summaryOf(record), ...allNotes(record)].join(' '), 'info');
  ui.results.hidden = !record.results.length && !record.postText;
  ui.results.scrollIntoView({ block: 'start' });
}

/** Fine-tune: a result just made has its project; a saved one is rebuilt from the edit's plan. */
async function fineTune(result, button) {
  let project = result.project;
  if (!project) {
    const record = state.record;
    if (!record?.plan) return;
    button.disabled = true;
    try {
      const file = await sourceFor(record);
      if (!file) return;
      const kit = await kitMedia(state.kit);
      project = buildJobs(record, file, kit).jobs.find((job) => job.id === result.id)?.project;
    } finally {
      button.disabled = false;
    }
  }
  if (!project) return;
  showView('finetune');
  loadProject(project);
}

const STATUS_TEXT = {
  done: (record) => `${record.results.length} video${record.results.length === 1 ? '' : 's'} ready`,
  paused: (record) => `Paused at ${record.percent || 0}%${record.results.length ? ` · ${record.results.length} ready` : ''}`,
  failed: (record) => `Stopped${record.error ? `: ${record.error}` : ''}`,
};

async function renderSaved() {
  if (!ui.saved) return;
  const records = await listEdits();
  const work = Object.fromEntries((Work()?.list() || []).map((item) => [item.id, item]));
  ui.saved.hidden = !records.length;
  const rows = [];
  for (const record of records) {
    const here = state.record?.id === record.id && state.running;
    const elsewhere = !here && record.status === 'running' && await isRunningElsewhere(record.id);
    // "running" with no tab holding it: the tab was closed or reloaded mid-edit.
    const status = here || elsewhere ? 'running' : record.status === 'running' ? 'paused' : record.status;
    const row = document.createElement('li');
    row.className = `saved-edit is-${status}`;
    row.dataset.edit = record.id;
    const info = document.createElement('div');
    info.className = 'saved-info';
    const name = document.createElement('strong');
    name.textContent = record.name || 'Video';
    name.title = record.instruction || '';
    const detail = document.createElement('span');
    detail.className = 'hint';
    const live = work[workId(record)];
    const when = new Date(record.createdAt || record.updatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    detail.textContent = `${when} · ${status === 'running'
      ? `${here ? 'Editing now' : 'Editing in another tab'} · ${live?.percent ?? record.percent ?? 0}%`
      : (STATUS_TEXT[status] || STATUS_TEXT.paused)(record)}`;
    info.append(name, detail);
    const actions = document.createElement('div');
    actions.className = 'output-actions';
    const button = (label, primary, handler) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = `button button-small${primary ? ' button-primary' : ''}`;
      element.textContent = label;
      element.addEventListener('click', handler);
      actions.append(element);
      return element;
    };
    if (status !== 'running') {
      if (record.results.length || record.postText) button('Open', status === 'done', () => openEdit(record));
      if (status !== 'done') button('Resume', true, () => resume(record));
      const remove = button('Delete', false, async () => {
        if (!window.confirm(`Delete the edit of "${record.name}" and its videos from this browser?`)) return;
        await deleteEdit(record.id);
        Work()?.remove(workId(record));
        if (state.record?.id === record.id) { clearResults(); state.record = null; }
        renderSaved();
      });
      remove.classList.add('button-quiet');
    }
    row.append(info, actions);
    rows.push(row);
  }
  ui.savedList.replaceChildren(...rows);
  if (ui.savedSpace && records.length) {
    const sizes = await Promise.all(records.map((record) => editSize(record.id)));
    const used = sizes.reduce((total, size) => total + size, 0);
    const { usage, quota } = await space();
    ui.savedSpace.textContent = `Kept in this browser for 30 days · ${(used / 1e6).toFixed(0)} MB used` +
      (quota && usage !== null ? ` · ${((quota - usage) / 1e9).toFixed(1)} GB free` : '');
  }
}

// Another tab's edit moving on, or finishing: keep the list live.
let savedTimer = null;
Work()?.onChange(() => {
  clearTimeout(savedTimer);
  savedTimer = setTimeout(renderSaved, 250);
});

/**
 * On opening the page: tidy old edits, list the rest, and carry on with an
 * edit that was interrupted (a reload, a closed tab) when its video can be
 * reopened without asking. "#edit=<id>" (the header chip's link) opens that edit.
 */
async function startSaved() {
  await cleanupEdits().catch(() => {});
  await renderSaved();
  const wanted = (location.hash.match(/edit=([\w-]+)/) || [])[1];
  const records = await listEdits();
  const record = wanted ? records.find((item) => item.id === wanted) : null;
  const interrupted = records.find((item) => item.status === 'running' && Date.now() - (item.updatedAt || 0) < 2 * 3600e3);
  const target = record || interrupted;
  if (!target || state.running) return;
  if (await isRunningElsewhere(target.id)) return; // the other tab has it; the list shows its progress
  // Asked for by link, and not interrupted: show what it has, and the list.
  if (target.status !== 'running') {
    if (target.results.length || target.postText) openEdit(target);
    else ui.saved.scrollIntoView({ block: 'start' });
    return;
  }
  // Interrupted mid-edit: carry on by itself only if the video reopens without asking.
  const found = await reopenSource(target);
  if (!found.file || (!memberSession() && !target.heard)) {
    showStatus(`Your edit of "${target.name}" was paused when the page closed. Press Resume in "Your edits" to carry on from ${target.percent || 0}%.`, 'info');
    ui.saved.scrollIntoView({ block: 'start' });
    return;
  }
  if (state.running) return;
  state.running = new AbortController();
  showStatus(`Carrying on with your edit of "${target.name}" from where it stopped.`, 'info');
  await execute(target, found.file);
}

// --- Members ---------------------------------------------------------------------

function renderAccount(account) {
  if (!account) return;
  ui.account.hidden = false;
  ui.accountStatus.textContent = A().statusText(account);
  A().renderUsage(ui.usage, account, 'video');
}

function showGate() {
  ui.gateStart.hidden = false;
  ui.gateStart.scrollIntoView({ block: 'center' });
}

function showPlanWall(info = {}) {
  if (info.account) { A().setAccount(info.account); renderAccount(info.account); }
  A().renderPlanWall(ui.topup, {
    message: info.message,
    plans: info.plans,
    account: info.account || A().account(),
    returnTo: PAGE,
    onSignedOut: showGate,
  });
  ui.topup.hidden = false;
  ui.topup.scrollIntoView({ block: 'center' });
}

/** Save the transcript into the member's GRIOT documents, so GRIOT can work with the episode. */
async function saveToGriot(button) {
  const text = state.transcript;
  if (!text) return;
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const name = `${safeName(sourceName())}-transcript.txt`;
    await A().upload(`/griot/documents?name=${encodeURIComponent(name)}`, new File([text], name, { type: 'text/plain' }));
    button.textContent = 'Saved to GRIOT ✓';
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Save transcript to GRIOT';
    showStatus(error.status === 402 || error.status === 409
      ? `GRIOT couldn't take it: ${error.message}`
      : `Couldn't save to GRIOT: ${error.message}`, 'warn');
  }
}

function startPage() {
  ui.gateStartButton?.addEventListener('click', () => A().requireAccount(PAGE));
  const SP = window.SP;
  if (!SP || !A() || !SP.connected || !A().signInAvailable()) { ui.gateOffline.hidden = false; return; }
  if (!A().session()) return; // the page explains itself; "Edit my video" asks to sign in
  if (A().requireAccount(PAGE)) return;
  renderAccount(A().account());
  A().settleReturn().then((result) => {
    if (result && !result.ok) showStatus(result.text, 'warn');
    return A().refresh();
  }).then((account) => {
    if (A().requireAccount(PAGE)) return;
    renderAccount(account);
    ui.topup.hidden = true;
  }, (error) => { if (error.status === 401) showGate(); });
}

startPage();
startSaved();

ui.go.addEventListener('click', run);
ui.cancel.addEventListener('click', () => state.running?.abort());

// Exposed for automated tests.
window.__auto = { state, chooseFile, run, showView, saveToGriot, resume, openEdit, renderSaved };
