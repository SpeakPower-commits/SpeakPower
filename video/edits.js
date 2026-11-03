/**
 * Saved automatic edits: each edit is kept in this browser as it goes, so
 * leaving the page, reloading or closing the tab never loses it.
 *
 *   record (store "edits"):
 *     id, name, size, lastModified        -- the video, to recognise it again
 *     source: 'handle' | 'copy' | 'none'  -- how the video can be reopened
 *     handle                              -- a pointer to the video on the PC (Chrome, Edge)
 *     instruction, settings, language, quality
 *     status: running | paused | done | failed | cancelled, stage, percent, error
 *     listenJob   -- the website's transcription job, and the pieces it has heard
 *     heard       -- { segments, wordLevel, transcript }      (after listening)
 *     cleaned     -- { cuts, removed }                        (after cleaning)
 *     plan        -- { clipPlans, chapters, post, smart, device } (after the AI)
 *     results     -- [{ id, label, fileName, note, duration, format, size, warnings }]
 *     postText    -- the post text, when asked for
 *     notes       -- things worth telling the user
 *
 *   files (store "files"): "<id>/result-<result id>" -> finished MP4,
 *                           "<id>/source"           -> a copy of the video (when kept)
 *
 * One tab works on an edit at a time: it holds the edit's Web Lock while it
 * runs, so another tab can tell "running over there" from "paused".
 */

import { STORES, get, getAll, persist, put, remove, removeFilesOf, space, withStore } from './store.js';

export const KEEP_DAYS = 30;
const LOCK_PREFIX = 'speakpower-edit-';

export const newEditId = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export async function listEdits() {
  try {
    const all = await getAll(STORES.edits);
    return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch {
    return [];
  }
}

export const loadEdit = (id) => get(STORES.edits, id).catch(() => null);

/** Save the record; failures to store are reported, never thrown (the edit itself goes on). */
export async function saveEdit(record) {
  record.updatedAt = Date.now();
  try {
    await put(STORES.edits, record);
    return true;
  } catch (error) {
    console.warn('Could not save the edit', error);
    return false;
  }
}

export async function deleteEdit(id) {
  await removeFilesOf(id).catch(() => {});
  await remove(STORES.edits, id).catch(() => {});
}

/** Remove edits older than KEEP_DAYS. */
export async function cleanupEdits() {
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  for (const record of await listEdits()) {
    if ((record.updatedAt || 0) < cutoff && !(await isRunningElsewhere(record.id))) await deleteEdit(record.id);
  }
}

// --- Finished videos -------------------------------------------------------------------

export function saveResultFile(editId, resultId, blob) {
  return put(STORES.files, { key: `${editId}/result-${resultId}`, editId, blob });
}

export async function loadResultFile(editId, resultId) {
  const entry = await get(STORES.files, `${editId}/result-${resultId}`).catch(() => null);
  return entry?.blob || null;
}

/** Bytes used by one edit's files. */
export async function editSize(editId) {
  try {
    const entries = await withStore(STORES.files, 'readonly',
      (store) => store.getAll(IDBKeyRange.bound(`${editId}/`, `${editId}/￿`)));
    return (entries || []).reduce((total, entry) => total + (entry.blob?.size || 0), 0);
  } catch {
    return 0;
  }
}

export { space, persist };

// --- The source video ------------------------------------------------------------------

const sameFile = (file, record) => file && file.name === record.name && file.size === record.size &&
  (!record.lastModified || !file.lastModified || file.lastModified === record.lastModified);

/**
 * Remember how to reopen the video without asking for it again:
 *   - a file handle (Chrome, Edge): a pointer, no copy, no space used;
 *   - otherwise a copy, when there is comfortably room for it;
 *   - otherwise nothing: resuming asks for the same file again.
 */
export async function keepSource(record, file, handle) {
  record.name = file.name;
  record.size = file.size;
  record.lastModified = file.lastModified || 0;
  record.type = file.type;
  if (handle && typeof handle.getFile === 'function') {
    record.source = 'handle';
    record.handle = handle;
    return record.source;
  }
  record.source = 'none';
  const { usage, quota } = await space();
  const room = quota && usage !== null ? quota - usage : 0;
  if (room > file.size * 3 && file.size < 4e9) {
    try {
      await put(STORES.files, { key: `${record.id}/source`, editId: record.id, blob: file });
      record.source = 'copy';
    } catch (error) {
      console.warn('Could not keep a copy of the video', error);
    }
  }
  return record.source;
}

/**
 * The video again, without asking when possible.
 *   { file }                           -- ready
 *   { needs: 'permission', ask() }     -- one click: ask() must run inside a click
 *   { needs: 'file' }                  -- the user must choose the same file again
 */
export async function reopenSource(record) {
  if (record.source === 'copy') {
    const entry = await get(STORES.files, `${record.id}/source`).catch(() => null);
    if (entry?.blob) return { file: new File([entry.blob], record.name, { type: record.type || entry.blob.type, lastModified: record.lastModified }) };
  }
  if (record.source === 'handle' && record.handle) {
    const handle = record.handle;
    const open = async () => {
      const file = await handle.getFile();
      if (!sameFile(file, record)) return { needs: 'file', changed: true };
      return { file };
    };
    try {
      const permission = await handle.queryPermission?.({ mode: 'read' });
      if (permission === 'granted' || permission === undefined) return await open();
      if (permission === 'prompt') {
        return {
          needs: 'permission',
          ask: async () => {
            const answer = await handle.requestPermission({ mode: 'read' });
            if (answer !== 'granted') return { needs: 'file' };
            return open();
          },
        };
      }
    } catch {
      // Moved, renamed or deleted: fall through to asking for it.
    }
  }
  return { needs: 'file' };
}

/** Is this the same video the edit was made from? */
export const matchesSource = (file, record) => sameFile(file, record);

// --- One tab at a time -----------------------------------------------------------------

const hasLocks = () => typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function';

/**
 * Hold the edit's lock while work() runs. Resolves with work()'s result, or
 * with { busy: true } when another tab is already running this edit.
 */
export function holdEdit(id, work) {
  if (!hasLocks()) return work();
  return navigator.locks.request(`${LOCK_PREFIX}${id}`, { ifAvailable: true }, (lock) => {
    if (!lock) return { busy: true };
    return work();
  });
}

export async function isRunningElsewhere(id) {
  if (!hasLocks() || !navigator.locks.query) return false;
  try {
    const { held = [] } = await navigator.locks.query();
    return held.some((lock) => lock.name === `${LOCK_PREFIX}${id}`);
  } catch {
    return false;
  }
}
