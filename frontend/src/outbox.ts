import type { MaintenanceRequest } from "./types";
import { requestsApi } from "./api";

export interface PendingRequest {
  id: string;
  values: Record<string, string>;
  queuedAt: string;
  photo?: Blob;
  photoName?: string;
}

const DB_NAME = "campuscare-outbox";
const STORE = "requests";

function openOutbox(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open the offline request queue."));
  });
}

export async function savePending(values: Record<string, string>, id: string, photo?: File): Promise<PendingRequest> {
  const pending = { id, values, queuedAt: new Date().toISOString(), photo, photoName: photo?.name };
  const db = await openOutbox();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(pending);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Unable to save the request locally."));
  });
  db.close();
  return pending;
}

export async function listPending(): Promise<PendingRequest[]> {
  const db = await openOutbox();
  const rows = await new Promise<PendingRequest[]>((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as PendingRequest[]);
    request.onerror = () => reject(request.error ?? new Error("Unable to read the local request queue."));
  });
  db.close();
  return rows;
}

export async function removePending(id: string): Promise<void> {
  const db = await openOutbox();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Unable to clear the synchronized request."));
  });
  db.close();
}

export async function synchronizePending(): Promise<MaintenanceRequest[]> {
  const saved: MaintenanceRequest[] = [];
  for (const item of await listPending()) {
    const request = await requestsApi.create(item.values, item.id);
    if (item.photo && item.photoName) {
      await requestsApi.uploadPhoto(request.id, new File([item.photo], item.photoName, { type: item.photo.type }));
    }
    await removePending(item.id);
    saved.push(request);
  }
  return saved;
}
