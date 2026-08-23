/**
 * IndexedDB-backed Blob store. Used to keep voice recordings around for the
 * Retry button so a page reload doesn't drop the user's audio.
 *
 * localStorage can't hold Blobs (they JSON-stringify to `{}`), so we use
 * IndexedDB which stores them natively.
 */

import { scoped } from "./branding/scope";

// Scoped per tenant for the same reason as localStorage — and resolved lazily,
// since the tenant id arrives only after the branding fetch resolves.
const dbName = () => scoped("audio");
const STORE = "audio-cache";
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(), VERSION);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
  });
  return dbPromise;
}

export async function storeAudio(key: string, blob: Blob): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    console.warn("[audioStore] put failed", e);
  }
}

export async function loadAudio(key: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn("[audioStore] get failed", e);
    return null;
  }
}

export async function deleteAudio(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn("[audioStore] delete failed", e);
  }
}

export async function listAudioKeys(): Promise<string[]> {
  try {
    const db = await openDb();
    return await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve((req.result as string[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}
