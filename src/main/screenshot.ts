import { BrowserWindow, clipboard, nativeImage } from "electron";
import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

const NAME = /^(Screen Shot|Screenshot|截屏|屏幕快照).*\.(png|jpe?g|gif|webp)$/i;

let watchers: FSWatcher[] = [];
let lastFiles = new Set<string>();

function dirs(): string[] {
  const home = homedir();
  return [join(home, "Desktop"), join(home, "Pictures", "Screenshots"), join(home, "Pictures")].filter(
    (d) => existsSync(d)
  );
}

function send(win: BrowserWindow | null, payload: { name: string; dataUrl: string }): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("screenshot:added", payload);
}

function ingestFile(win: BrowserWindow | null, file: string): void {
  if (lastFiles.has(file)) return;
  try {
    const st = statSync(file);
    if (Date.now() - st.mtimeMs > 8_000) return;
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return;
    if (lastFiles.size >= 400) lastFiles.clear();
    lastFiles.add(file);
    send(win, { name: basename(file) || "screenshot.png", dataUrl: img.toDataURL() });
  } catch {
    /* ignore incomplete writes */
  }
}

export function startScreenshotWatch(getWin: () => BrowserWindow | null): void {
  stopScreenshotWatch();
  for (const dir of dirs()) {
    try {
      const w = watch(dir, { persistent: true }, (_event, filename) => {
        if (!filename || !NAME.test(String(filename))) return;
        setTimeout(() => ingestFile(getWin(), join(dir, String(filename))), 400);
      });
      watchers.push(w);
    } catch {
      /* folder may be permission-gated */
    }
  }
}

export function stopScreenshotWatch(): void {
  for (const w of watchers) w.close();
  watchers = [];
  lastFiles.clear();
}

export function captureInteractive(win: BrowserWindow | null): void {
  if (process.platform === "darwin") {
    const child = spawn("screencapture", ["-i", "-c"], { stdio: "ignore" });
    child.on("close", () => {
      const img = clipboard.readImage();
      if (img.isEmpty()) return;
      send(win, { name: "capture.png", dataUrl: img.toDataURL() });
    });
  } else {
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      send(win, { name: "capture.png", dataUrl: img.toDataURL() });
    }
  }
}

export function markClipboard(_dataUrl: string): void {
  /* paste is renderer-only; clipboard poll removed */
}
