/**
 * The brand kit: the user's own designs -- logo, intro and end cards, frame
 * overlays, pictures -- uploaded once and used in every automatic edit.
 *
 * Kept in this browser (IndexedDB), never uploaded. If the browser won't
 * store it (a private window), the kit still works for this visit.
 */

import { probeMedia } from './media.js';

export const ROLES = {
  logo: 'Logo',
  intro: 'Intro card',
  outro: 'End card',
  overlay: 'Frame / overlay',
  picture: 'Picture',
};

const DB_NAME = 'speakpower-studio';
const STORE = 'brandkit';

let memory = []; // used when IndexedDB isn't available

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, work) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const result = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(result.result ?? result);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** A first guess at a design's role from its file name; the user can change it. */
export function guessRole(name, existing = []) {
  const lower = name.toLowerCase();
  if (/logo|badge|mark/.test(lower)) return 'logo';
  if (/intro|opening|open/.test(lower)) return 'intro';
  if (/outro|end|cta|closing|subscribe|follow/.test(lower)) return 'outro';
  if (/frame|overlay|border/.test(lower)) return 'overlay';
  return existing.some((item) => item.role === 'logo') ? 'picture' : 'logo';
}

/** Every item: { id, name, role, file }. */
export async function loadKit() {
  try {
    const items = await withStore('readonly', (store) => store.getAll());
    return (items || []).map((item) => ({ ...item, file: new File([item.blob], item.name, { type: item.type }) }));
  } catch {
    return memory;
  }
}

export async function addToKit(file, existing = []) {
  const item = {
    id: `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: file.name,
    type: file.type,
    role: guessRole(file.name, existing),
  };
  try {
    await withStore('readwrite', (store) => store.put({ ...item, blob: file }));
  } catch {
    memory = [...memory, { ...item, file }];
  }
  return { ...item, file };
}

export async function setRole(item, role) {
  item.role = role;
  try {
    await withStore('readwrite', (store) => store.put({ id: item.id, name: item.name, type: item.type, role, blob: item.file }));
  } catch {
    memory = memory.map((entry) => (entry.id === item.id ? { ...entry, role } : entry));
  }
}

export async function removeFromKit(item) {
  try {
    await withStore('readwrite', (store) => store.delete(item.id));
  } catch {
    memory = memory.filter((entry) => entry.id !== item.id);
  }
}

/**
 * The kit as the automatic editor uses it:
 *   { logo, intro, outro, overlay, pictures: [...] }  (media from probeMedia)
 * One of each single role -- the most recently added wins.
 */
export async function kitMedia(items) {
  const kit = { logo: null, intro: null, outro: null, overlay: null, pictures: [], problems: [] };
  for (const item of items) {
    let media;
    try {
      media = await probeMedia(item.file);
    } catch (error) {
      kit.problems.push(error.message);
      continue;
    }
    if (item.role === 'picture') kit.pictures.push(media);
    else kit[item.role] = media;
  }
  return kit;
}
