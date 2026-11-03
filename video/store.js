/**
 * The editor's storage in this browser (IndexedDB), shared by the brand kit
 * and the saved edits:
 *
 *   brandkit  -- the user's designs (logo, cards, pictures)      key: id
 *   edits     -- one record per automatic edit: its settings,
 *                checkpoints and results list                     key: id
 *   files     -- the large things: finished videos and, where
 *                the browser can't keep a pointer to the
 *                original, a copy of it                           key: key ("<edit id>/<name>")
 *
 * Nothing here is ever uploaded. Version 1 had only the brand kit; opening at
 * version 2 adds the other two stores and keeps the kit as it is.
 */

const DB_NAME = 'speakpower-studio';
const DB_VERSION = 2;
export const STORES = { brandkit: 'brandkit', edits: 'edits', files: 'files' };

let opening = null;

function openDb() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('This browser has no storage for saved work.')); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.brandkit)) db.createObjectStore(STORES.brandkit, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.edits)) db.createObjectStore(STORES.edits, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.files)) db.createObjectStore(STORES.files, { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab opening a newer version: let it, and reopen next time.
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
    request.onerror = () => { opening = null; reject(request.error); };
    request.onblocked = () => { opening = null; reject(new Error('Close the other SpeakPower Studio tabs, then reload this one.')); };
  });
  return opening;
}

/**
 * Run work(store) in one transaction and resolve once it has committed.
 * Resolves with the request's result when work returns an IDBRequest.
 */
export async function withStore(name, mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(name, mode);
    } catch (error) {
      opening = null; // the connection was closed under us: reopen next time
      reject(error);
      return;
    }
    const result = work(transaction.objectStore(name));
    transaction.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Saving was stopped.'));
  });
}

export const getAll = (name) => withStore(name, 'readonly', (store) => store.getAll());
export const get = (name, key) => withStore(name, 'readonly', (store) => store.get(key));
export const put = (name, value) => withStore(name, 'readwrite', (store) => store.put(value));
export const remove = (name, key) => withStore(name, 'readwrite', (store) => store.delete(key));

/** Every file kept for one edit ("<id>/..."). */
export function removeFilesOf(editId) {
  return withStore(STORES.files, 'readwrite', (store) => store.delete(IDBKeyRange.bound(`${editId}/`, `${editId}/￿`)));
}

/**
 * Ask the browser to keep this storage even when the disk runs low. Chrome and
 * Edge grant it to sites used often; it is harmless when refused.
 */
export async function persist() {
  try {
    if (navigator.storage?.persisted && await navigator.storage.persisted()) return true;
    return Boolean(await navigator.storage?.persist?.());
  } catch {
    return false;
  }
}

/** { usage, quota } in bytes, or nulls when the browser won't say. */
export async function space() {
  try {
    const { usage = null, quota = null } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return { usage: null, quota: null };
  }
}
