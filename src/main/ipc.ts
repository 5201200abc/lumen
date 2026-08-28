import { BrowserWindow, ipcMain } from "electron";
import type { Attachment, ChatSendPayload, Effort, LlamaStatus, Settings } from "@shared/types";
import {
  createConversation,
  deleteAllConversations,
  deleteConversation,
  deleteMessage,
  getConversation,
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
import { benchmarkLocalModel, ensureLocalLlama, probeLlama, stopLocalLlama } from "./models";
import { getSettings, setSettings } from "./store";
import { maybeRemember } from "./memory";
import { captureInteractive, markClipboard } from "./screenshot";
import { applyTheme } from "./window";
import { generateConversationTitle, immediateConversationTitle } from "./title";
import { cancelGoogleLogin, googleLogin, googleLogout, googleStatus, googleSync } from "./google-auth";
import { recordTokenUsage, tokenUsage } from "./usage";
import { reconcileModelCatalog } from "@shared/model-catalog";

const aborts = new Map<string, AbortController>();

function senderWin(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function broadcastConversationTitle(conversationId: string, title: string): void {
  renameConversation(conversationId, title);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("chats:renamed", { conversationId, title });
  }
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
  let settings = getSettings();
  const status = await ensureLocalLlama(settings);
  if (!status.online) {
    throw new Error("模型服务未就绪，请先启动 llama-server。");
  }
  if (status.managed && status.url !== settings.llamaUrl) {
    settings = { ...settings, llamaUrl: status.url, llamaPort: status.port || settings.llamaPort };
  }
  if (status.runningModelPath && status.runningModel && status.runningModel !== settings.model) {
    throw new Error(status.error || `当前服务加载的是 ${status.runningModel}，不是所选 ${settings.model}。`);
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
  } else {
    userId = [...history].reverse().find((m) => m.role === "user")?.id || "";
  }

  if (isFirstTurn && opts.insertUser && opts.content.trim()) {
    const title = immediateConversationTitle(opts.content);
    if (title.trim()) {
      const initialTitle = title.trim();
      broadcastConversationTitle(opts.conversationId, initialTitle);
      void generateConversationTitle(opts.content, undefined, settings)
        .then((generatedTitle) => {
          if (
            generatedTitle !== initialTitle &&
            getConversation(opts.conversationId)?.title === initialTitle
          ) {
            broadcastConversationTitle(opts.conversationId, generatedTitle);
          }
        })
        .catch(() => undefined);
    }
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
    conversationId: opts.conversationId,
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
      onResearch: (research) => {
        if (aborts.get(opts.conversationId) !== abort) return;
        opts.win?.webContents.send("chat:delta", {
          conversationId: opts.conversationId,
          messageId: assistantId,
          phase: "searching",
          research
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
          research: result.research,
          durationSeconds
        });
        if (result.usage) {
          recordTokenUsage(
            result.usage.inputTokens,
            result.usage.outputTokens,
            result.usage.cacheTokens || 0,
            settings.model
          );
        }
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
          research: result.research,
          durationSeconds
        });
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
  ipcMain.handle("usage:get", () => tokenUsage());

  ipcMain.handle("models:status", async () => probeLlama(getSettings()));
  ipcMain.handle("models:ensure", async () => ensureLocalLlama(getSettings(), false));
  ipcMain.handle("models:reconnect", async () => ensureLocalLlama(getSettings(), true));
  ipcMain.handle("models:stop", async () => stopLocalLlama(getSettings()));
  ipcMain.handle("models:benchmark", async (_e, model: string) => benchmarkLocalModel(getSettings(), model));
  ipcMain.handle("models:refreshCatalog", async (_event, restartRouter = false) => {
    let settings = getSettings();
    const status = restartRouter
      ? await ensureLocalLlama(settings, true)
      : await probeLlama(settings);
    const detectedModels = reconcileModelCatalog(settings, status);
    const selectedExists = detectedModels.some((model) => model.name === settings.model);
    const nextModel = selectedExists ? settings.model : detectedModels[0]?.name || "";
    if (
      JSON.stringify(detectedModels) !== JSON.stringify(settings.llamaModels) ||
      nextModel !== settings.model
    ) {
      settings = setSettings({
        llamaModels: detectedModels,
        modelCatalog: detectedModels.map((model) => model.name),
        model: nextModel
      });
    }
    return { settings, status };
  });

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

  // Compatibility API: titles are now generated once, before the first response starts.
  ipcMain.handle("chats:autoSummarize", () => listConversations());

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
