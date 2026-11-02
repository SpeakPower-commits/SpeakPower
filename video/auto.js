/**
 * The automatic editor: upload, instruction, "Edit my video", results.
 *
 * Runs the whole edit in this tab:
 *
 *   listen (Whisper) -> clean (pauses, "um"s) -> load the free AI
 *   -> choose the best moments -> write titles and post text
 *   -> build each edit with its graphics -> render each to MP4
 *
 * Each result can be downloaded, or opened in the editor ("Fine-tune") to
 * change anything by hand.
 */

import { loadProject } from './app.js';
import { extractSpeechAudio, transcribeSamples } from './speech.js';
import { memberSession, refundJob, startJob, transcribeRemote } from './remote.js';
import { exportVideo } from './exporter.js';
import { loadAssets } from './renderer.js';
import { formatTime, sourceToOutput } from './project.js';
import { probeMedia } from './media.js';
import { Brain } from './brain.js';
import { ROLES, addToKit, kitMedia, loadKit, removeFromKit, setRole } from './brandkit.js';
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
  meta: null,
  kit: [],
  running: null,     // AbortController while an edit runs
  urls: [],          // result object URLs, released before the next edit
  results: [],
};

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

async function chooseFile(file) {
  if (!file || state.running) return;
  showStatus('');
  try {
    const media = await probeMedia(file);
    if (media.kind !== 'video') throw new Error(`"${file.name}" has no picture. Choose a video file.`);
    state.file = file;
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
document.addEventListener('drop', (event) => {
  if (document.body.dataset.view !== 'auto') return;
  const file = [...(event.dataTransfer?.files || [])].find((item) => item.type.startsWith('video/')) || event.dataTransfer?.files?.[0];
  chooseFile(file);
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
    role.addEventListener('change', () => setRole(item, role.value));
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
  { id: 'listen', label: 'Listening — turning speech into text', weight: 0.34 },
  { id: 'clean', label: 'Cleaning out long pauses and "um"s', weight: 0.02 },
  { id: 'brain', label: 'Getting the free AI ready', weight: 0.1 },
  { id: 'choose', label: 'Choosing the best moments', weight: 0.1 },
  { id: 'write', label: 'Writing titles, graphics and post text', weight: 0.06 },
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
  document.title = `${percent}% · Editing — SpeakPower Studio`;
}

function notifyDone(message) {
  document.title = PAGE_TITLE;
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('SpeakPower AI Video Editor', { body: message, icon: new URL('./brand/speakpower-badge.png', import.meta.url).href }); } catch { /* not allowed here */ }
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

const safeName = (name) => name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').slice(0, 50) || 'video';

function addOutputCard(result) {
  const url = URL.createObjectURL(result.blob);
  state.urls.push(url);
  const card = document.createElement('article');
  card.className = 'output';
  const video = document.createElement('video');
  video.src = url;
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.className = `output-video format-${result.project.format.replace(':', 'x')}`;
  const title = document.createElement('h3');
  title.textContent = result.label;
  const info = document.createElement('p');
  info.className = 'hint';
  info.textContent = `${formatTime(result.duration, false)} · ${result.project.format} · ${(result.blob.size / 1e6).toFixed(1)} MB` +
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
  tune.addEventListener('click', () => {
    showView('finetune');
    loadProject(result.project);
  });
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
  download.download = `${safeName(state.file.name)}-post.txt`;
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

function readSettings() {
  const base = {
    ...edit.DEFAULT_SETTINGS,
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
 */
async function listen(samples, signal, notes) {
  const progress = (stage) => (fraction) => setProgress(0.1 + 0.9 * fraction, stage);
  let job = null;
  try {
    job = await startJob(state.meta.duration);
  } catch (error) {
    if (error.status === 401) { showGate(); return null; }
    if (A().handleProfileRequired(error, PAGE)) return null;
    if (error.status === 402) { showPlanWall(error.data); return null; }
    if (error.status === 400) throw error; // e.g. longer than two hours
    notes.push("The website's speech service couldn't be reached, so this browser listened instead (less accurate on names).");
  }
  if (job) {
    A().refresh().then(renderAccount, () => {});
    let heard = 0;
    try {
      const result = await transcribeRemote(samples, {
        job: job.job,
        chunkSeconds: job.chunkSeconds,
        language: ui.language.value,
        signal,
        onProgress: progress('Listening'),
      });
      heard = result.heard;
      if (result.segments.length) return result;
    } catch (error) {
      if (signal.aborted) throw error;
      notes.push("The website's speech service stopped part-way, so this browser finished listening.");
    } finally {
      if (!heard) refundJob(job.job).then(() => A().refresh().then(renderAccount, () => {}));
    }
  }
  return transcribeSamples(samples, {
    model: 'accurate',
    language: ui.language.value,
    signal,
    onProgress: (stage, fraction) => setProgress(0.1 + 0.9 * fraction, stage),
  });
}

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

  const controller = new AbortController();
  const { signal } = controller;
  state.running = controller;
  clearResults();
  showStatus('');
  renderStages();
  ui.progress.hidden = false;
  ui.go.disabled = true;
  ui.go.textContent = 'Editing…';
  const brain = new Brain();
  const notes = [];

  try {
    // 1. Listen: the website's Whisper for members; the browser's if it can't be reached.
    setStage('listen', 'Reading the sound');
    let samples = await extractSpeechAudio(file, { signal, onProgress: (fraction) => setProgress(0.1 * fraction, 'Reading the sound') });
    const heard = await listen(samples, signal, notes);
    if (!heard) return; // the plan wall, sign-in or profile step is showing
    const { segments, wordLevel } = heard;
    if (!segments.length) throw new Error('No speech was found in this video, so there is nothing to edit by.');
    const words = segments.flatMap((segment) => segment.words);
    // For GRIOT: the words as the clean edit says them, one line per sentence.
    state.transcript = segments.map((segment) => edit.cleanText(segment.text)).filter(Boolean).join('\n');

    // 2. Clean.
    setStage('clean');
    const levels = edit.frameLevels(samples);
    samples = null; // let the sound go: it can be hundreds of MB
    const cuts = edit.cleanupCuts({ levels, words, wordLevel }, settings);
    const removed = cuts.reduce((total, cut) => total + (cut.end - cut.start), 0);

    // 3. The free AI.
    setStage('brain', 'Downloading the AI (first time only)');
    const smart = await brain.load((fraction) => setProgress(fraction, 'Downloading the AI (first time only)'), signal);
    signal.throwIfAborted();
    if (!smart) notes.push(`The free AI couldn't load (${brain.error}), so the simpler built-in method chose the moments and wrote the titles.`);

    const units = segments;
    const blocks = edit.blocksFrom(units, 45);
    const topicWords = edit.keywords(settings.topic);

    // 4. Choose clips.
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

    // 5. Write.
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
    if ((settings.episode || settings.postText) && meta.duration > 360) {
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

    // 6. Build and render.
    setStage('render');
    const [assets, kit] = await Promise.all([loadAssets(), kitMedia(state.kit)]);
    notes.push(...kit.problems);
    const shared = { file, meta, segments, words, cuts, settings, kit };
    const jobs = [];
    let episodeProject = null;
    if (settings.episode) {
      const built = edit.buildEpisode({ ...shared, title: post.title, chapters });
      episodeProject = built.project;
      jobs.push({
        project: built.project,
        label: 'Full episode — cleaned',
        fileName: `${safeName(file.name)}-episode.mp4`,
        note: removed > 1 ? `${formatTime(removed, false)} of pauses and "um"s removed` : '',
      });
    }
    clipPlans.forEach((plan, index) => {
      const built = edit.buildClip({ ...shared, window: plan.window, hook: plan.hook, phrases: plan.phrases });
      jobs.push({ project: built.project, label: `Clip ${index + 1}: ${plan.hook}`, fileName: `${safeName(file.name)}-clip-${index + 1}.mp4` });
    });

    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const result = await exportVideo(job.project, assets, {
        signal,
        onProgress: (fraction) => setProgress((index + fraction) / jobs.length, `Rendering ${index + 1} of ${jobs.length}`),
      });
      const done = { ...job, ...result };
      state.results.push(done);
      addOutputCard(done);
    }

    if (settings.postText) {
      const chapterLines = chapters.length && episodeProject
        ? chapters.map((chapter) => `${edit.formatChapterTime(sourceToOutput(episodeProject, chapter.start))} ${chapter.title}`).join('\n')
        : '';
      showPost({ ...post, chapters: chapterLines });
    }

    [...ui.stages.children].forEach((item) => { item.className = 'is-done'; });
    ui.fill.style.width = '100%';
    ui.progressText.textContent = 'Done';
    // Export notes (e.g. this browser's sound format) are the same for every video: say them once.
    notes.push(...new Set(state.results.flatMap((result) => result.warnings || [])));
    const summary = `${jobs.length} video${jobs.length === 1 ? '' : 's'} ready` +
      (smart ? ` — chosen and titled by the free AI (${brain.device}).` : '.');
    showStatus([summary, ...notes].join(' '), notes.length ? 'warn' : 'info');
    notifyDone(summary);
  } catch (error) {
    document.title = PAGE_TITLE;
    if (signal.aborted) showStatus('Editing cancelled.', 'info');
    else showStatus(`The edit stopped: ${error.message}`, 'error');
  } finally {
    brain.dispose();
    state.running = null;
    ui.progress.hidden = true;
    ui.go.disabled = !state.file;
    ui.go.textContent = 'Edit my video';
  }
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
    const name = `${safeName(state.file.name)}-transcript.txt`;
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

ui.go.addEventListener('click', run);
ui.cancel.addEventListener('click', () => state.running?.abort());

// Exposed for automated tests.
window.__auto = { state, chooseFile, run, showView, saveToGriot };
