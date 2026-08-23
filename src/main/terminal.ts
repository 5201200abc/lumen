import { BrowserWindow, dialog, ipcMain } from "electron";
import * as pty from "node-pty";
import os from "os";
import fs from "fs";

let ptyProcess: pty.IPty | null = null;
let currentCwd = process.env.HOME || os.homedir();

function getClaudeBin(): string {
  const custom = `${process.env.HOME}/.local/bin/claude`;
  if (fs.existsSync(custom)) return custom;
  return "claude";
}

export function registerTerminalIpc(): void {
  ipcMain.handle("terminal:init", (event, opts?: { cols?: number; rows?: number; cwd?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const cols = opts?.cols || 80;
    const rows = opts?.rows || 24;
    if (opts?.cwd) currentCwd = opts.cwd;

    if (ptyProcess) {
      return { ok: true, cwd: currentCwd };
    }

    const claudeBin = getClaudeBin();
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:18084",
      ANTHROPIC_API_KEY: "sk-local-llama",
      PATH: `${process.env.HOME}/.local/bin:${process.env.PATH || ""}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "en_US.UTF-8",
      CLAUDE_CODE_SAFE_MODE: "0"
    };

    try {
      ptyProcess = pty.spawn(claudeBin, ["--dangerously-skip-permissions"], {
        name: "xterm-256color",
        cols,
        rows,
        cwd: currentCwd,
        env
      });

      ptyProcess.onData((data: string) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send("terminal:data", data);
        }
      });

      ptyProcess.onExit(({ exitCode }) => {
        ptyProcess = null;
        if (win && !win.isDestroyed()) {
          win.webContents.send("terminal:exit", exitCode);
        }
      });

      return { ok: true, cwd: currentCwd };
    } catch (err) {
      console.error("Failed to spawn claude pty:", err);
      // Fallback to shell
      const shell = process.env.SHELL || "/bin/zsh";
      try {
        ptyProcess = pty.spawn(shell, ["-l"], {
          name: "xterm-256color",
          cols,
          rows,
          cwd: currentCwd,
          env
        });

        ptyProcess.onData((data: string) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("terminal:data", data);
          }
        });

        ptyProcess.onExit(({ exitCode }) => {
          ptyProcess = null;
          if (win && !win.isDestroyed()) {
            win.webContents.send("terminal:exit", exitCode);
          }
        });

        return { ok: true, cwd: currentCwd, fallback: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
  });

  ipcMain.handle("terminal:write", (_event, data: string) => {
    if (ptyProcess) {
      ptyProcess.write(data);
      return true;
    }
    return false;
  });

  ipcMain.handle("terminal:resize", (_event, { cols, rows }: { cols: number; rows: number }) => {
    if (ptyProcess && cols > 0 && rows > 0) {
      try {
        ptyProcess.resize(cols, rows);
      } catch (e) {
        // ignore resize race
      }
      return true;
    }
    return false;
  });

  ipcMain.handle("terminal:restart", (event, opts?: { cols?: number; rows?: number; cwd?: string }) => {
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch (e) {}
      ptyProcess = null;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const cols = opts?.cols || 80;
    const rows = opts?.rows || 24;
    if (opts?.cwd) currentCwd = opts.cwd;

    const claudeBin = getClaudeBin();
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:18084",
      ANTHROPIC_API_KEY: "sk-local-llama",
      PATH: `${process.env.HOME}/.local/bin:${process.env.PATH || ""}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "en_US.UTF-8",
      CLAUDE_CODE_SAFE_MODE: "0"
    };

    try {
      ptyProcess = pty.spawn(claudeBin, ["--dangerously-skip-permissions"], {
        name: "xterm-256color",
        cols,
        rows,
        cwd: currentCwd,
        env
      });

      ptyProcess.onData((data: string) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send("terminal:data", data);
        }
      });

      ptyProcess.onExit(({ exitCode }) => {
        ptyProcess = null;
        if (win && !win.isDestroyed()) {
          win.webContents.send("terminal:exit", exitCode);
        }
      });

      return { ok: true, cwd: currentCwd };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle("terminal:select-folder", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      title: "选择工作区目录 (Working Directory)"
    });
    if (!res.canceled && res.filePaths[0]) {
      return res.filePaths[0];
    }
    return null;
  });
}
