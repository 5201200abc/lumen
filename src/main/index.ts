import { app, BrowserWindow, Menu, globalShortcut, nativeTheme } from "electron";
import { registerIpc } from "./ipc";
import { registerTerminalIpc } from "./terminal";
import { registerCodexIpc, shutdownCodexRuntime } from "./codex-agent";
import { initDb, flushDb, closeDb, setAfterPersist } from "./db";
import { getSettings } from "./store";
import { ensureLocalLlama } from "./models";
import { startScreenshotWatch, stopScreenshotWatch, captureInteractive } from "./screenshot";
import { applyTheme, createWindow } from "./window";
import { cancelGoogleSync, scheduleGoogleSync } from "./google-auth";
import { registerAttachmentIpc } from "./attachments";

app.setName("Lumen");

// Single instance lock - prevent duplicate windows/icons
const gotTheLock = app.requestSingleInstanceLock();

let win: BrowserWindow | null = null;

function getWin(): BrowserWindow | null {
  return win;
}

function buildMenu(): void {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? [
            {
              label: app.name,
              submenu: [
                { role: "about" as const },
                { type: "separator" as const },
                {
                  label: "设置…",
                  accelerator: "CmdOrCtrl+,",
                  click: () => win?.webContents.send("ui:settings")
                },
                { type: "separator" as const },
                { role: "hide" as const },
                { role: "hideOthers" as const },
                { role: "unhide" as const },
                { type: "separator" as const },
                { role: "quit" as const }
              ]
            }
          ]
        : []),
      {
        label: "文件",
        submenu: [
          {
            label: "新对话",
            accelerator: "CmdOrCtrl+N",
            click: () => win?.webContents.send("ui:new-chat")
          },
          {
            label: "截图到当前对话",
            accelerator: "CmdOrCtrl+Shift+S",
            click: () => captureInteractive(win)
          },
          { type: "separator" },
          isMac ? { role: "close" } : { role: "quit" }
        ]
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
          { type: "separator" },
          {
            label: "搜索对话",
            accelerator: "CmdOrCtrl+K",
            click: () => win?.webContents.send("ui:search")
          },
          {
            label: "停止生成",
            accelerator: "Escape",
            click: () => win?.webContents.send("ui:stop")
          }
        ]
      },
      {
        label: "视图",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" }
        ]
      },
      {
        label: "窗口",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }]
      }
    ])
  );
}

async function ready(): Promise<void> {
  await initDb();
  setAfterPersist(scheduleGoogleSync);
  const settings = getSettings();
  applyTheme(settings.theme);
  registerIpc();
  registerTerminalIpc();
  registerCodexIpc();
  registerAttachmentIpc();
  win = createWindow();
  startScreenshotWatch(getWin);
  buildMenu();
  nativeTheme.on("updated", () => {
    win?.webContents.send("ui:theme", nativeTheme.shouldUseDarkColors);
  });
  if (settings.llamaAutoStart) void ensureLocalLlama(settings);
  globalShortcut.register("CmdOrCtrl+Shift+S", () => captureInteractive(win));
}

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else if (app.isReady()) {
      win = createWindow();
    }
  });

  app.whenReady().then(ready);

  app.on("window-all-closed", () => {
    stopScreenshotWatch();
    flushDb();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    stopScreenshotWatch();
    shutdownCodexRuntime();
    setAfterPersist(null);
    cancelGoogleSync();
    closeDb();
    globalShortcut.unregisterAll();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
  });
}
