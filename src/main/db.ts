import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { Attachment, ChatMessage, CoworkMessage, CoworkTask, Conversation, MemoryItem, ModelUsage, ResearchProgress, Role, TokenUsage } from "@shared/types";

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
  persistTimer = setTimeout(persist, 500);
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

function parseResearch(raw: string): ResearchProgress | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as ResearchProgress;
    return typeof parsed?.strategy === "string" && Array.isArray(parsed.steps) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseJson<T>(raw: string, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
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
      research TEXT NOT NULL DEFAULT '',
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_tokens INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO token_usage (id, input_tokens, output_tokens) VALUES (1, 0, 0);
    CREATE TABLE IF NOT EXISTS model_usage (
      model TEXT PRIMARY KEY,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cowork_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'native',
      goal TEXT NOT NULL DEFAULT '',
      native_session_id TEXT NOT NULL DEFAULT '',
      compact_context TEXT NOT NULL DEFAULT '',
      context_used INTEGER NOT NULL DEFAULT 0,
      context_total INTEGER NOT NULL DEFAULT 16384,
      compacted_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cowork_messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      thinking TEXT NOT NULL DEFAULT '',
      runtime_output TEXT NOT NULL DEFAULT '',
      checkpoint_id TEXT NOT NULL DEFAULT '',
      rewind_available INTEGER NOT NULL DEFAULT 0,
      attachments TEXT NOT NULL DEFAULT '[]',
      tool_calls TEXT NOT NULL DEFAULT '[]',
      trace TEXT NOT NULL DEFAULT '[]',
      approvals TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT '',
      context_used INTEGER NOT NULL DEFAULT 0,
      context_total INTEGER NOT NULL DEFAULT 16384,
      activity TEXT NOT NULL DEFAULT '',
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cowork_tasks_updated ON cowork_tasks(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cowork_messages_task ON cowork_messages(task_id, created_at);
  `);
  try {
    db.run("ALTER TABLE messages ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Existing databases with the column need no migration.
  }
  try {
    db.run("ALTER TABLE messages ADD COLUMN research TEXT NOT NULL DEFAULT ''");
  } catch {
    // Existing databases with the column need no migration.
  }
  try {
    db.run("ALTER TABLE token_usage ADD COLUMN cache_tokens INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Existing databases with the column need no migration.
  }
  try {
    db.run("ALTER TABLE cowork_messages ADD COLUMN checkpoint_id TEXT NOT NULL DEFAULT ''");
  } catch {
    // Existing databases with the column need no migration.
  }
  try {
    db.run("ALTER TABLE cowork_messages ADD COLUMN rewind_available INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Existing databases with the column need no migration.
  }
  try {
    db.run("ALTER TABLE cowork_messages ADD COLUMN thinking TEXT NOT NULL DEFAULT ''");
  } catch {
    // Existing databases with the column need no migration.
  }
  try {
    db.run("ALTER TABLE cowork_messages ADD COLUMN trace TEXT NOT NULL DEFAULT '[]'");
  } catch {
    // Existing databases with the column need no migration.
  }
  try {
    db.run("ALTER TABLE cowork_tasks ADD COLUMN native_session_id TEXT NOT NULL DEFAULT ''");
    db.run("UPDATE cowork_tasks SET native_session_id = claude_session_id WHERE native_session_id = ''");
  } catch {
    // New databases already have the native session column; old session ids were migrated once.
  }
  const modelRows = all<{ n: number }>("SELECT COUNT(*) AS n FROM model_usage")[0];
  if (!modelRows?.n) {
    const legacy = all<{ input_tokens: number; output_tokens: number; cache_tokens?: number }>(
      "SELECT input_tokens, output_tokens, cache_tokens FROM token_usage WHERE id = 1"
    )[0];
    if (legacy && (legacy.input_tokens || legacy.output_tokens || legacy.cache_tokens)) {
      run(
        "INSERT INTO model_usage (model, input_tokens, output_tokens, cache_tokens) VALUES (?, ?, ?, ?)",
        ["(earlier)", legacy.input_tokens, legacy.output_tokens, legacy.cache_tokens || 0]
      );
    }
  }
  persist();
}

export type CoworkTaskRecord = {
  task: CoworkTask;
  agentSessionId?: string;
  compactContext?: string;
};

export function listCoworkTasks(): CoworkTaskRecord[] {
  return all<{
    id: string;
    title: string;
    cwd: string;
    engine: CoworkTask["engine"];
    goal: string;
    native_session_id: string;
    compact_context: string;
    context_used: number;
    context_total: number;
    compacted_at: number;
    created_at: number;
    updated_at: number;
  }>("SELECT * FROM cowork_tasks ORDER BY updated_at DESC").map((row) => ({
    task: {
      id: row.id,
      title: row.title,
      cwd: row.cwd,
      engine: "native",
      goal: row.goal || undefined,
      contextUsed: row.context_used,
      contextTotal: row.context_total,
      compactedAt: row.compacted_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    },
    agentSessionId: row.native_session_id || undefined,
    compactContext: row.compact_context || undefined
  }));
}

export function saveCoworkTask(task: CoworkTask, agentSessionId?: string, compactContext?: string): void {
  run(
    `INSERT INTO cowork_tasks (
      id, title, cwd, engine, goal, native_session_id, compact_context,
      context_used, context_total, compacted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      cwd = excluded.cwd,
      engine = excluded.engine,
      goal = excluded.goal,
      native_session_id = excluded.native_session_id,
      compact_context = excluded.compact_context,
      context_used = excluded.context_used,
      context_total = excluded.context_total,
      compacted_at = excluded.compacted_at,
      updated_at = excluded.updated_at`,
    [
      task.id,
      task.title,
      task.cwd,
      "native",
      task.goal || "",
      agentSessionId || "",
      compactContext || "",
      task.contextUsed || 0,
      task.contextTotal || 16384,
      task.compactedAt || 0,
      task.createdAt,
      task.updatedAt
    ]
  );
}

export function listCoworkMessages(taskId: string): CoworkMessage[] {
  return all<{
    id: string;
    task_id: string;
    role: CoworkMessage["role"];
    content: string;
    thinking: string;
    runtime_output: string;
    checkpoint_id: string;
    rewind_available: number;
    attachments: string;
    tool_calls: string;
    trace: string;
    approvals: string;
    status: CoworkMessage["status"] | "";
    context_used: number;
    context_total: number;
    activity: string;
    duration_seconds: number;
    created_at: number;
  }>(
    "SELECT * FROM cowork_messages WHERE task_id = ? ORDER BY created_at ASC",
    [taskId]
  ).map((row) => ({
    id: row.id,
    taskId: row.task_id,
    role: row.role,
    content: row.content,
    thinking: row.thinking || undefined,
    runtimeOutput: row.runtime_output || undefined,
    checkpointId: row.checkpoint_id || undefined,
    rewindAvailable: row.rewind_available === 1,
    attachments: parseAttachments(row.attachments),
    toolCalls: parseJson(row.tool_calls, []),
    trace: parseJson(row.trace, []),
    approvals: parseJson(row.approvals, []),
    status: row.status || undefined,
    contextUsed: row.context_used || undefined,
    contextTotal: row.context_total || undefined,
    activity: row.activity || undefined,
    durationSeconds: row.duration_seconds || undefined,
    createdAt: row.created_at
  }));
}

export function saveCoworkMessage(message: CoworkMessage): void {
  run(
    `INSERT INTO cowork_messages (
      id, task_id, role, content, thinking, runtime_output, checkpoint_id, rewind_available,
      attachments, tool_calls, trace, approvals, status, context_used, context_total,
      activity, duration_seconds, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      thinking = excluded.thinking,
      runtime_output = excluded.runtime_output,
      checkpoint_id = excluded.checkpoint_id,
      rewind_available = excluded.rewind_available,
      attachments = excluded.attachments,
      tool_calls = excluded.tool_calls,
      trace = excluded.trace,
      approvals = excluded.approvals,
      status = excluded.status,
      context_used = excluded.context_used,
      context_total = excluded.context_total,
      activity = excluded.activity,
      duration_seconds = excluded.duration_seconds`,
    [
      message.id,
      message.taskId,
      message.role,
      message.content,
      message.thinking || "",
      message.runtimeOutput || "",
      message.checkpointId || "",
      message.rewindAvailable ? 1 : 0,
      JSON.stringify(message.attachments || []),
      JSON.stringify(message.toolCalls || []),
      JSON.stringify(message.trace || []),
      JSON.stringify(message.approvals || []),
      message.status || "",
      message.contextUsed || 0,
      message.contextTotal || 16384,
      message.activity || "",
      message.durationSeconds || 0,
      message.createdAt
    ]
  );
}

export function deleteCoworkMessage(messageId: string): void {
  run("DELETE FROM cowork_messages WHERE id = ?", [messageId]);
}

export function deleteCoworkTask(taskId: string): void {
  transaction(() => {
    db!.run("DELETE FROM cowork_messages WHERE task_id = ?", [taskId]);
    db!.run("DELETE FROM cowork_tasks WHERE id = ?", [taskId]);
  });
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
  research: string;
  duration_seconds: number;
  created_at: number;
}): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as Role,
    content: row.content,
    thinking: row.thinking,
    attachments: parseAttachments(row.attachments),
    research: parseResearch(row.research),
    durationSeconds: row.duration_seconds || undefined,
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
    research: string;
    duration_seconds: number;
    created_at: number;
  }>(
    "SELECT id, conversation_id, role, content, thinking, attachments, research, duration_seconds, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
    [conversationId]
  ).map(rowToMessage);
}

export function insertMessage(message: ChatMessage): void {
  run(
    "INSERT INTO messages (id, conversation_id, role, content, thinking, attachments, research, duration_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      message.id,
      message.conversationId,
      message.role,
      message.content,
      message.thinking,
      JSON.stringify(message.attachments),
      message.research ? JSON.stringify(message.research) : "",
      message.durationSeconds || 0,
      message.createdAt
    ]
  );
  touchConversation(message.conversationId);
}

export function updateMessage(
  id: string,
  patch: { content?: string; thinking?: string; research?: ResearchProgress; durationSeconds?: number }
): void {
  const current = all<{ content: string; thinking: string; research: string; duration_seconds: number }>(
    "SELECT content, thinking, research, duration_seconds FROM messages WHERE id = ?",
    [id]
  )[0];
  if (!current) return;
  run("UPDATE messages SET content = ?, thinking = ?, research = ?, duration_seconds = ? WHERE id = ?", [
    patch.content ?? current.content,
    patch.thinking ?? current.thinking,
    patch.research ? JSON.stringify(patch.research) : current.research,
    patch.durationSeconds ?? current.duration_seconds,
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
  const exists = all<{ id: string }>(
    "SELECT id FROM memories WHERE content = ? AND source_id = ?",
    [trimmed, sourceId]
  )[0];
  if (exists) return;
  run("INSERT INTO memories (id, content, source_id, created_at) VALUES (?, ?, ?, ?)", [
    crypto.randomUUID(),
    trimmed,
    sourceId,
    Date.now()
  ]);
}

export function searchMemories(query: string, sourceId: string, limit = 8): MemoryItem[] {
  const q = `%${escapeLike(query.trim())}%`;
  return all<{ id: string; content: string; source_id: string; created_at: number }>(
    "SELECT id, content, source_id, created_at FROM memories WHERE source_id = ? AND content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?",
    [sourceId, q, limit]
  ).map((row) => ({
    id: row.id,
    content: row.content,
    sourceId: row.source_id,
    createdAt: row.created_at
  }));
}

export function recentMemories(sourceId: string, limit = 12): MemoryItem[] {
  return all<{ id: string; content: string; source_id: string; created_at: number }>(
    "SELECT id, content, source_id, created_at FROM memories WHERE source_id = ? ORDER BY created_at DESC LIMIT ?",
    [sourceId, limit]
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

function toUsage(row: { input_tokens: number; output_tokens: number; cache_tokens: number }, model: string): ModelUsage {
  const inputTokens = row.input_tokens;
  const outputTokens = row.output_tokens;
  const cacheTokens = row.cache_tokens;
  return {
    model,
    inputTokens,
    outputTokens,
    cacheTokens,
    totalTokens: inputTokens + outputTokens + cacheTokens
  };
}

export function getTokenUsage(): TokenUsage {
  const models = all<{ model: string; input_tokens: number; output_tokens: number; cache_tokens: number }>(
    "SELECT model, input_tokens, output_tokens, cache_tokens FROM model_usage ORDER BY (input_tokens + output_tokens + cache_tokens) DESC, model ASC"
  ).map((row) => toUsage(row, row.model));
  if (models.length) {
    const inputTokens = models.reduce((sum, item) => sum + item.inputTokens, 0);
    const outputTokens = models.reduce((sum, item) => sum + item.outputTokens, 0);
    const cacheTokens = models.reduce((sum, item) => sum + item.cacheTokens, 0);
    return { inputTokens, outputTokens, cacheTokens, totalTokens: inputTokens + outputTokens + cacheTokens, models };
  }
  const row = all<{ input_tokens: number; output_tokens: number; cache_tokens?: number }>(
    "SELECT input_tokens, output_tokens, cache_tokens FROM token_usage WHERE id = 1"
  )[0] || { input_tokens: 0, output_tokens: 0, cache_tokens: 0 };
  const cacheTokens = row.cache_tokens || 0;
  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheTokens,
    totalTokens: row.input_tokens + row.output_tokens + cacheTokens,
    models: []
  };
}

export function addTokenUsage(
  inputTokens: number,
  outputTokens: number,
  cacheTokens = 0,
  model = ""
): TokenUsage {
  const input = Math.max(0, Math.round(Number(inputTokens) || 0));
  const output = Math.max(0, Math.round(Number(outputTokens) || 0));
  const cache = Math.max(0, Math.round(Number(cacheTokens) || 0));
  if (input || output || cache) {
    run(
      "UPDATE token_usage SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cache_tokens = COALESCE(cache_tokens, 0) + ? WHERE id = 1",
      [input, output, cache]
    );
    const name = model.trim() || "(unknown)";
    const existing = all<{ model: string }>("SELECT model FROM model_usage WHERE model = ?", [name])[0];
    if (existing) {
      run(
        "UPDATE model_usage SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cache_tokens = cache_tokens + ? WHERE model = ?",
        [input, output, cache, name]
      );
    } else {
      run(
        "INSERT INTO model_usage (model, input_tokens, output_tokens, cache_tokens) VALUES (?, ?, ?, ?)",
        [name, input, output, cache]
      );
    }
  }
  return getTokenUsage();
}

export function flushDb(): void {
  persist();
}

export function closeDb(): void {
  persist();
  db?.close();
  db = null;
}
