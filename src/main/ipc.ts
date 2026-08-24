import { BrowserWindow, ipcMain } from "electron";
import type { Attachment, ChatSendPayload, Effort, LlamaStatus, Settings } from "@shared/types";
import {
  createConversation,
  deleteAllConversations,
  deleteConversation,
  deleteMessage,
  insertMessage,
  listConversations,
  listMemories,
  listMessages,
  renameConversation,
  searchConversations,
  updateMessage,
  clearMemories
} from "./db";
import { streamChat } from "./llama";
import { ensureLocalLlama, probeLlama } from "./models";
import { getSettings, setSettings } from "./store";
import { maybeRemember } from "./memory";
import { captureInteractive, markClipboard } from "./screenshot";
import { applyTheme } from "./window";
import { generateConversationTitle } from "./title";
import { cancelGoogleLogin, googleLogin, googleLogout, googleStatus, googleSync } from "./google-auth";

const aborts = new Map<string, AbortController>();

function senderWin(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

async function beginStream(opts: {
  win: BrowserWindow | null;
  conversationId: string;
  content: string;
  attachments: Attachment[];
  effort: Effort;
  webSearch: boolean;
  insertUser: boolean;
  replaceAssistantId?: string;
}): Promise<{ userId: string; assistantId: string }> {
  const settings = getSettings();
  const status = await probeLlama(settings);
  if (!status.online) {
    throw new Error("模型服务未就绪，请先启动 llama-server。");
  }

  const history = listMessages(opts.conversationId);
  const isFirstTurn = history.length === 0 || history.filter((m) => m.role === "user").length === 0;

  const abort = new AbortController();
  aborts.set(opts.conversationId, abort);

  let userId: string = crypto.randomUUID();
  if (opts.insertUser) {
    insertMessage({
      id: userId,
      conversationId: opts.conversationId,
      role: "user",
      content: opts.content,
      thinking: "",
      attachments: opts.attachments,
      createdAt: Date.now()
    });
    if (isFirstTurn && opts.content.trim()) {
      renameConversation(opts.conversationId, opts.content.trim().slice(0, 16));
    }
  } else {
    userId = [...history].reverse().find((m) => m.role === "user")?.id || "";
  }

  const assistantId = crypto.randomUUID();
  const startedAt = Date.now();
  insertMessage({
    id: assistantId,
    conversationId: opts.conversationId,
    role: "assistant",
    content: "",
    thinking: "",
    attachments: [],
    createdAt: startedAt + 1
  });

  const userMsg = {
    id: userId,
    conversationId: opts.conversationId,
    role: "user" as const,
    content: opts.content,
    thinking: "",
    attachments: opts.attachments,
    createdAt: Date.now()
  };

  const hist = opts.insertUser
    ? history
    : history.filter((m) => m.id !== userId && m.id !== opts.replaceAssistantId);
  void streamChat({
    settings,
    history: hist,
    userText: opts.content,
    attachments: opts.attachments,
    effort: opts.effort,
    webSearch: opts.webSearch,
    vision: status.vision,
    abort,
    handlers: {
      onStatus: (statusUpdate) => {
        if (aborts.get(opts.conversationId) !== abort) return;
        opts.win?.webContents.send("chat:delta", {
          conversationId: opts.conversationId,
          messageId: assistantId,
          phase: statusUpdate.phase,
          statusText: statusUpdate.text
        });
      },
      onDelta: (chunk) => {
        if (aborts.get(opts.conversationId) !== abort) return;
        opts.win?.webContents.send("chat:delta", {
          conversationId: opts.conversationId,
          messageId: assistantId,
          ...chunk
        });
      },
      onDone: (result) => {
        if (aborts.get(opts.conversationId) !== abort) {
          deleteMessage(assistantId);
          return;
        }
        const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        updateMessage(assistantId, {
          content: result.content,
          thinking: result.thinking,
          durationSeconds
        });
        if (settings.memoryEnabled && !result.stopped && result.content.trim()) {
          maybeRemember(userMsg, {
            ...userMsg,
            id: assistantId,
            role: "assistant",
            content: result.content,
            thinking: result.thinking,
            attachments: []
          });
        }
        aborts.delete(opts.conversationId);
        opts.win?.webContents.send("chat:done", {
          conversationId: opts.conversationId,
          messageId: assistantId,
          thinking: result.thinking,
          content: result.content,
          stopped: result.stopped,
          durationSeconds
        });

        // Automatically summarize a concise topic title using the local model
        if (isFirstTurn && result.content.trim() && !result.stopped) {
          void generateConversationTitle(opts.content, result.content).then((newTitle) => {
            if (newTitle && newTitle.trim()) {
              renameConversation(opts.conversationId, newTitle.trim());
              opts.win?.webContents.send("chats:renamed", {
                conversationId: opts.conversationId,
                title: newTitle.trim()
              });
            }
          });
        }
      },
      onError: (error) => {
        if (aborts.get(opts.conversationId) !== abort) {
          deleteMessage(assistantId);
          return;
        }
        updateMessage(assistantId, { content: `生成失败：${error}` });
        aborts.delete(opts.conversationId);
        opts.win?.webContents.send("chat:error", {
          conversationId: opts.conversationId,
          messageId: assistantId,
          error
        });
      }
    }
  });

  return { userId, assistantId };
}

export function registerIpc(): void {
  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:set", (_e, patch: Partial<Settings>) => {
    const next = setSettings(patch);
    applyTheme(next.theme);
    return next;
  });
  ipcMain.handle("google:status", () => googleStatus());
  ipcMain.handle("google:login", () => googleLogin());
  ipcMain.handle("google:cancelLogin", () => cancelGoogleLogin());
  ipcMain.handle("google:logout", () => googleLogout());
  ipcMain.handle("google:sync", () => googleSync());

  ipcMain.handle("models:status", async () => probeLlama(getSettings()));
  ipcMain.handle("models:ensure", async () => ensureLocalLlama(getSettings(), false));
  ipcMain.handle("models:reconnect", async () => ensureLocalLlama(getSettings(), true));

  ipcMain.handle("chats:list", () => listConversations());
  ipcMain.handle("chats:search", (_e, q: string) => searchConversations(q));
  ipcMain.handle("chats:create", () => createConversation());
  ipcMain.handle("chats:rename", (_e, id: string, title: string) => {
    renameConversation(id, title);
    return true;
  });
  ipcMain.handle("chats:delete", (_e, id: string) => {
    aborts.get(id)?.abort();
    aborts.delete(id);
    deleteConversation(id);
    return true;
  });
  ipcMain.handle("chats:clear", () => {
    for (const abort of aborts.values()) abort.abort();
    aborts.clear();
    deleteAllConversations();
    return true;
  });
  ipcMain.handle("chats:messages", (_e, id: string) => listMessages(id));

  ipcMain.handle("chats:autoSummarize", async (event) => {
    const win = senderWin(event);
    const convs = listConversations();
    for (const c of convs) {
      const msgs = listMessages(c.id);
      const userMsg = msgs.find((m) => m.role === "user");
      const asstMsg = msgs.find((m) => m.role === "assistant" && m.content.trim());
      if (userMsg && asstMsg && (c.title === "新对话" || c.title.length > 8 || c.title.includes("为什么你的回答那么像") || c.title.includes("优化 happyhorse") || c.title.includes("你介绍一下自己"))) {
        const newTitle = await generateConversationTitle(userMsg.content, asstMsg.content);
        if (newTitle && newTitle.trim() && newTitle !== c.title) {
          renameConversation(c.id, newTitle.trim());
          win?.webContents.send("chats:renamed", {
            conversationId: c.id,
            title: newTitle.trim()
          });
        }
      }
    }
    return listConversations();
  });

  ipcMain.handle("memory:list", () => listMemories());
  ipcMain.handle("memory:clear", () => {
    clearMemories();
    return true;
  });

  ipcMain.handle("screenshot:capture", (e) => {
    captureInteractive(senderWin(e));
    return true;
  });
  ipcMain.handle("clipboard:ack", (_e, dataUrl: string) => {
    markClipboard(dataUrl);
    return true;
  });

  ipcMain.handle("chat:stop", (_e, conversationId: string) => {
    aborts.get(conversationId)?.abort();
    return true;
  });

  ipcMain.handle("chat:send", async (event, payload: ChatSendPayload) => {
    return beginStream({
      win: senderWin(event),
      conversationId: payload.conversationId,
      content: payload.content,
      attachments: payload.attachments,
      effort: payload.effort,
      webSearch: payload.webSearch,
      insertUser: true
    });
  });

  ipcMain.handle("chat:regenerate", async (event, conversationId: string, effort: Effort, webSearch: boolean) => {
    const messages = listMessages(conversationId);
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return { ok: false as const };
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const ids = await beginStream({
      win: senderWin(event),
      conversationId,
      content: lastUser.content,
      attachments: lastUser.attachments,
      effort,
      webSearch,
      insertUser: false,
      replaceAssistantId: lastAssistant?.id
    });
    return { ok: true as const, ...ids };
  });
}
