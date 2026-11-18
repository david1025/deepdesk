const DB_NAME = "deepdesk-local";
const STORE = "app";
const KEY = "conversations";
export type ChatMessage = { id: string; role: "user" | "assistant"; text: string };
export type Conversation = { id: string; title: string; updatedAt: number; messages: ChatMessage[] };
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地会话数据库"));
  });
}
export async function loadConversations(): Promise<Conversation[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error ?? new Error("读取本地会话失败"));
    tx.oncomplete = () => db.close();
  });
}
export async function saveConversations(conversations: Conversation[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(conversations, KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("保存本地会话失败")); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("保存本地会话已取消")); };
  });
}
