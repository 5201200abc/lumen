import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { Attachment, ChatMessage, Conversation, MemoryItem, Role } from "@shared/types";

const require = createRequire(import.meta.url);

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
let persistTimer: NodeJS.Timeout | null = null;
let afterPersist: (() => void) | null = null;

function wasmPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, "sql-wasm.wasm");
  return join(dirname(require.resolve("sql.js")), "sql-wasm.wasm");
}

function dbPath(): string {
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  return join(dir, "lumen.sqlite");
}

function persist(): void {
  if (!db) return;
  writeFileSync(dbPath(), Buffer.from(db.export()));
  afterPersist?.();
}

export function setAfterPersist(handler: (() => void) | null): void {
  afterPersist = handler;
}

export function databasePath(): string {
  return dbPath();
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 120);
}

function run(sql: string, params: unknown[] = []): void {
  db!.run(sql, params as never[]);
  schedulePersist();
}

function transaction(action: () => void): void {
  db!.run("BEGIN");
  try {
    action();
    db!.run("COMMIT");
    schedulePersist();
  } catch (error) {
    try {
      db!.run("ROLLBACK");
    } catch {
      // Preserve the original database error if rollback itself fails.
    }
    throw error;
  }
}

function all<T>(sql: string, params: unknown[] = []): T[] {
  const stmt = db!.prepare(sql);
  stmt.bind(params as never[]);
  const rows: T[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as T);
  stmt.free();
  return rows;
}

function parseAttachments(raw: string): Attachment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Attachment[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function initDb(): Promise<void> {
  SQL = await initSqlJs({ locateFile: () => wasmPath() });
  const file = dbPath();
  db = existsSync(file) ? new SQL.Database(readFileSync(file)) : new SQL.Database();
  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      thinking TEXT NOT NULL DEFAULT '',
      attachments TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
  `);
  persist();
}

export function listConversations(): Conversation[] {
  return all<{ id: string; title: string; created_at: number; updated_at: number }>(
    "SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC"
  ).map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function searchConversations(query: string): Conversation[] {
  const q = `%${escapeLike(query.trim())}%`;
  if (!query.trim()) return listConversations();
  return all<{ id: string; title: string; created_at: number; updated_at: number }>(
    `SELECT DISTINCT c.id, c.title, c.created_at, c.updated_at
     FROM conversations c
     LEFT JOIN messages m ON m.conversation_id = c.id
     WHERE c.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\'
     ORDER BY c.updated_at DESC`,
    [q, q]
  ).map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, "\\$1");
}

export function getConversation(id: string): Conversation | null {
  const row = all<{ id: string; title: string; created_at: number; updated_at: number }>(
    "SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?",
    [id]
  )[0];
  if (!row) return null;
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function createConversation(title = "新对话"): Conversation {
  const id = crypto.randomUUID();
  const now = Date.now();
  run("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
    id,
    title,
    now,
    now
  ]);
  return { id, title, createdAt: now, updatedAt: now };
}

export function renameConversation(id: string, title: string): void {
  run("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", [title, Date.now(), id]);
}

export function touchConversation(id: string): void {
  run("UPDATE conversations SET updated_at = ? WHERE id = ?", [Date.now(), id]);
}

export function deleteConversation(id: string): void {
  transaction(() => {
    db!.run("DELETE FROM messages WHERE conversation_id = ?", [id]);
    db!.run("DELETE FROM conversations WHERE id = ?", [id]);
  });
}

export function deleteAllConversations(): void {
  transaction(() => {
    db!.run("DELETE FROM messages");
    db!.run("DELETE FROM conversations");
  });
}

function rowToMessage(row: {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  thinking: string;
  attachments: string;
  created_at: number;
}): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as Role,
    content: row.content,
    thinking: row.thinking,
    attachments: parseAttachments(row.attachments),
    createdAt: row.created_at
  };
}

export function listMessages(conversationId: string): ChatMessage[] {
  return all<{
    id: string;
    conversation_id: string;
    role: string;
    content: string;
    thinking: string;
    attachments: string;
    created_at: number;
  }>(
    "SELECT id, conversation_id, role, content, thinking, attachments, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
    [conversationId]
  ).map(rowToMessage);
}

export function insertMessage(message: ChatMessage): void {
  run(
    "INSERT INTO messages (id, conversation_id, role, content, thinking, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      message.id,
      message.conversationId,
      message.role,
      message.content,
      message.thinking,
      JSON.stringify(message.attachments),
      message.createdAt
    ]
  );
  touchConversation(message.conversationId);
}

export function updateMessage(
  id: string,
  patch: { content?: string; thinking?: string }
): void {
  const current = all<{ content: string; thinking: string }>(
    "SELECT content, thinking FROM messages WHERE id = ?",
    [id]
  )[0];
  if (!current) return;
  run("UPDATE messages SET content = ?, thinking = ? WHERE id = ?", [
    patch.content ?? current.content,
    patch.thinking ?? current.thinking,
    id
  ]);
}

export function deleteMessage(id: string): void {
  run("DELETE FROM messages WHERE id = ?", [id]);
}

export function listMemories(): MemoryItem[] {
  return all<{ id: string; content: string; source_id: string; created_at: number }>(
    "SELECT id, content, source_id, created_at FROM memories ORDER BY created_at DESC LIMIT 200"
  ).map((row) => ({
    id: row.id,
    content: row.content,
    sourceId: row.source_id,
    createdAt: row.created_at
  }));
}

export function addMemory(content: string, sourceId: string): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  const exists = all<{ id: string }>("SELECT id FROM memories WHERE content = ?", [trimmed])[0];
  if (exists) return;
  run("INSERT INTO memories (id, content, source_id, created_at) VALUES (?, ?, ?, ?)", [
    crypto.randomUUID(),
    trimmed,
    sourceId,
    Date.now()
  ]);
}

export function searchMemories(query: string, limit = 8): MemoryItem[] {
  const q = `%${escapeLike(query.trim())}%`;
  return all<{ id: string; content: string; source_id: string; created_at: number }>(
    "SELECT id, content, source_id, created_at FROM memories WHERE content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?",
    [q, limit]
  ).map((row) => ({
    id: row.id,
    content: row.content,
    sourceId: row.source_id,
    createdAt: row.created_at
  }));
}

export function recentMemories(limit = 12): MemoryItem[] {
  return all<{ id: string; content: string; source_id: string; created_at: number }>(
    "SELECT id, content, source_id, created_at FROM memories ORDER BY created_at DESC LIMIT ?",
    [limit]
  ).map((row) => ({
    id: row.id,
    content: row.content,
    sourceId: row.source_id,
    createdAt: row.created_at
  }));
}

export function clearMemories(): void {
  run("DELETE FROM memories");
}

export function flushDb(): void {
  persist();
}

export function closeDb(): void {
  persist();
  db?.close();
  db = null;
}
