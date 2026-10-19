import type { Activity, LocalOperation, LocalSnapshot } from "./types";

const DB_NAME = "daymark-local";
const DB_VERSION = 1;
const SNAPSHOT_STORE = "snapshots";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) db.createObjectStore(SNAPSHOT_STORE, { keyPath: "userId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readSnapshot(userId: string): Promise<LocalSnapshot> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(SNAPSHOT_STORE, "readonly").objectStore(SNAPSHOT_STORE).get(userId);
    request.onsuccess = () => resolve(request.result?.snapshot ?? { activities: [], operations: [] });
    request.onerror = () => reject(request.error);
  }).finally(() => db.close()) as Promise<LocalSnapshot>;
}

export async function writeSnapshot(userId: string, snapshot: LocalSnapshot): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(SNAPSHOT_STORE, "readwrite");
    transaction.objectStore(SNAPSHOT_STORE).put({ userId, snapshot, updatedAt: new Date().toISOString() });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }).finally(() => db.close());
}

export async function clearSnapshot(userId: string): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(SNAPSHOT_STORE, "readwrite");
    transaction.objectStore(SNAPSHOT_STORE).delete(userId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }).finally(() => db.close());
}

export function makeOperation(userId: string, activity: Activity, kind: LocalOperation["kind"] = "upsert"): LocalOperation {
  return {
    id: crypto.randomUUID(),
    userId,
    table: "activities",
    kind,
    recordId: activity.id,
    payload: kind === "upsert" ? activity : undefined,
    createdAt: new Date().toISOString(),
  };
}
