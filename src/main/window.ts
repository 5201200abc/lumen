import { BrowserWindow, nativeTheme, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Theme } from "@shared/types";

export function applyTheme(theme: Theme): void {
  nativeTheme.themeSource = theme;
}

export function createWindow(): BrowserWindow {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";

  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    show: false,
    backgroundColor: "#00000000",
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 16, y: 18 },
          vibrancy: "under-window",
          visualEffectState: "active"
        }
      : isWin
      ? {
          titleBarStyle: "hidden",
          titleBarOverlay: {
            color: "#161616",
            symbolColor: "#8d8d88",
            height: 40
          }
        }
      : {}),
    transparent: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: existsSync(join(__dirname, "../preload/index.mjs"))
        ? join(__dirname, "../preload/index.mjs")
        : join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.on("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }
  return win;
}
