import { BrowserWindow, dialog, ipcMain } from "electron";
import * as pty from "node-pty";
import os from "node:os";
import path from "node:path";

let ptyProcess: pty.IPty | null = null;
let currentCwd = process.env.HOME || os.homedir();

function defaultShell(): { bin: string; args: string[] } {
  if (process.platform === "win32") {
    return { bin: process.env.COMSPEC || "powershell.exe", args: [] };
  }
  return { bin: process.env.SHELL || "/bin/bash", args: ["-l"] };
}

function terminalEnv(): Record<string, string> {
  const home = os.homedir();
  const extraPath = process.platform === "win32"
    ? path.join(home, ".local", "bin")
    : `${home}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`;
  const separator = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${extraPath}${separator}${process.env.PATH || ""}`,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8"
  } as Record<string, string>;
}

function startShell(
  win: BrowserWindow | null,
  cols: number,
  rows: number
): { ok: true; cwd: string } | { ok: false; error: string } {
  const shell = defaultShell();
  try {
    ptyProcess = pty.spawn(shell.bin, shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: currentCwd,
      env: terminalEnv()
    });
    ptyProcess.onData((data) => {
      if (win && !win.isDestroyed()) win.webContents.send("terminal:data", data);
    });
    ptyProcess.onExit(({ exitCode }) => {
      ptyProcess = null;
      if (win && !win.isDestroyed()) win.webContents.send("terminal:exit", exitCode);
    });
    return { ok: true, cwd: currentCwd };
  } catch (error) {
    ptyProcess = null;
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerTerminalIpc(): void {
  ipcMain.handle(
    "terminal:init",
    (event, opts?: { cols?: number; rows?: number; cwd?: string }) => {
      if (opts?.cwd) currentCwd = opts.cwd;
      if (ptyProcess) return { ok: true, cwd: currentCwd };
      return startShell(
        BrowserWindow.fromWebContents(event.sender),
        opts?.cols || 80,
        opts?.rows || 24
      );
    }
  );

  ipcMain.handle("terminal:write", (_event, data: string) => {
    if (!ptyProcess) return false;
    ptyProcess.write(data);
    return true;
  });

  ipcMain.handle(
    "terminal:resize",
    (_event, { cols, rows }: { cols: number; rows: number }) => {
      if (!ptyProcess || cols <= 0 || rows <= 0) return false;
      try {
        ptyProcess.resize(cols, rows);
      } catch {
        return false;
      }
      return true;
    }
  );

  ipcMain.handle(
    "terminal:restart",
    (event, opts?: { cols?: number; rows?: number; cwd?: string }) => {
      if (ptyProcess) {
        try {
          ptyProcess.kill();
        } catch {
          // The process may have exited between the check and kill.
        }
        ptyProcess = null;
      }
      if (opts?.cwd) currentCwd = opts.cwd;
      return startShell(
        BrowserWindow.fromWebContents(event.sender),
        opts?.cols || 80,
        opts?.rows || 24
      );
    }
  );

  ipcMain.handle("terminal:select-folder", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      title: "选择工作区目录 (Working Directory)"
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
}
