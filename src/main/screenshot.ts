import { BrowserWindow, clipboard, nativeImage } from "electron";
import { spawn } from "node:child_process";

function send(win: BrowserWindow | null, payload: { name: string; dataUrl: string }): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("screenshot:added", payload);
}

export function startScreenshotWatch(_getWin: () => BrowserWindow | null): void {
  // Ordinary OS screenshots must never become chat attachments implicitly.
  // Only the explicit Lumen capture command or a user paste may add an image.
}

export function stopScreenshotWatch(): void {
  // Kept as a lifecycle-compatible no-op.
}

export function captureInteractive(win: BrowserWindow | null): void {
  if (process.platform === "darwin") {
    const child = spawn("screencapture", ["-i", "-c"], { stdio: "ignore" });
    child.on("close", (code) => {
      if (code !== 0) return;
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
