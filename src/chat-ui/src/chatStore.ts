const DB_NAME = "deepdesk-local";
const STORE = "app";
const KEY = "conversation";

export type ChatMessage = { id: string; role: "user" | "assistant"; text: string };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地会话数据库"));
  });
}

export async function loadMessages(): Promise<ChatMessage[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error ?? new Error("读取本地会话失败"));
    request.transaction?.addEventListener("complete", () => db.close());
  });
}

export async function saveMessages(messages: ChatMessage[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(messages, KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("保存本地会话失败")); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("保存本地会话已取消")); };
  });
}
