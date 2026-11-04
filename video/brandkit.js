/**
 * The brand kit: the user's own designs -- logo, intro and end cards, frame
 * overlays, pictures -- uploaded once and used in every automatic edit.
 *
 * Kept in this browser (IndexedDB), never uploaded. If the browser won't
 * store it (a private window), the kit still works for this visit.
 */

import { probeMedia } from './media.js';
import { STORES, withStore as withDb } from './store.js';

export const ROLES = {
  logo: 'Logo',
  intro: 'Intro card',
  outro: 'End card',
  overlay: 'Frame / overlay',
  picture: 'Picture',
  sticker: 'Sticker / illustration',
};

let memory = []; // used when IndexedDB isn't available

const withStore = (mode, work) => withDb(STORES.brandkit, mode, work);

/** A first guess at a design's role from its file name; the user can change it. */
export function guessRole(name, existing = []) {
  const lower = name.toLowerCase();
  if (/logo|badge|mark/.test(lower)) return 'logo';
  if (/intro|opening|open/.test(lower)) return 'intro';
  if (/outro|end|cta|closing|subscribe|follow/.test(lower)) return 'outro';
  if (/frame|overlay|border/.test(lower)) return 'overlay';
  if (/sticker|icon|illustrat|emoji|graphic|canva/.test(lower)) return 'sticker';
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

async function save(item) {
  const record = { id: item.id, name: item.name, type: item.type, role: item.role, keywords: item.keywords || '', blob: item.file };
  try {
    await withStore('readwrite', (store) => store.put(record));
  } catch {
    memory = memory.map((entry) => (entry.id === item.id ? { ...entry, role: item.role, keywords: item.keywords } : entry));
  }
}

export async function setRole(item, role) {
  item.role = role;
  await save(item);
}

/** A sticker's words: it appears when one of them is said ("growth, money"). */
export async function setKeywords(item, text) {
  item.keywords = String(text || '').slice(0, 200);
  await save(item);
}

/** The words a sticker answers to: the ones the user typed, else its file name's. */
export function stickerWords(item) {
  const typed = String(item.keywords || '').split(/[,;\n]+/).map((word) => word.trim().toLowerCase()).filter(Boolean);
  const source = typed.length ? typed : item.name.replace(/\.[^.]+$/, '').toLowerCase().split(/[^\p{L}\p{N}]+/u);
  const ignore = new Set(['sticker', 'icon', 'illustration', 'emoji', 'graphic', 'canva', 'design', 'png', 'copy', 'final', 'the', 'and']);
  return [...new Set(source.flatMap((word) => word.split(/\s+/)).filter((word) => word.length > 2 && !ignore.has(word) && !/^\d+$/.test(word)))];
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
 *   { logo, intro, outro, overlay, pictures: [...], stickers: [{ media, keywords }] }  (media from probeMedia)
 * One of each single role -- the most recently added wins.
 */
export async function kitMedia(items) {
  const kit = { logo: null, intro: null, outro: null, overlay: null, pictures: [], stickers: [], problems: [] };
  for (const item of items) {
    let media;
    try {
      media = await probeMedia(item.file);
    } catch (error) {
      kit.problems.push(error.message);
      continue;
    }
    if (item.role === 'picture') kit.pictures.push(media);
    else if (item.role === 'sticker') { const words = stickerWords(item); if (words.length) kit.stickers.push({ media, keywords: words }); }
    else kit[item.role] = media;
  }
  return kit;
}
