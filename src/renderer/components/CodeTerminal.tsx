import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

type Props = {
  theme?: "dark" | "light" | "system";
};

export function CodeTerminal({ theme }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [cwd, setCwd] = useState<string>("~");
  const [restarting, setRestarting] = useState(false);

  const isDark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches) ||
    document.documentElement.dataset.theme === "dark";

  useEffect(() => {
    if (!containerRef.current) return;

    const baseFontSize = parseInt(document.documentElement.dataset.fontSize || "13", 10) || 13;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: baseFontSize,
      fontFamily: '"Lumen CJK", "Macano", "Monaco", "SF Mono", Menlo, monospace',
      lineHeight: 1.4,
      theme: isDark
        ? {
            background: "#161616",
            foreground: "#efefe9",
            cursor: "#fae5d7",
            selectionBackground: "rgba(250, 229, 215, 0.25)",
            black: "#161616",
            red: "#f87171",
            green: "#4ade80",
            yellow: "#facc15",
            blue: "#60a5fa",
            magenta: "#c084fc",
            cyan: "#38bdf8",
            white: "#f5f5f4",
            brightBlack: "#52525b",
            brightRed: "#fca5a5",
            brightGreen: "#86efac",
            brightYellow: "#fde047",
            brightBlue: "#93c5fd",
            brightMagenta: "#d8b4fe",
            brightCyan: "#7dd3fc",
            brightWhite: "#ffffff"
          }
        : {
            background: "#fafaf8",
            foreground: "#161616",
            cursor: "#44271a",
            selectionBackground: "rgba(68, 39, 26, 0.15)",
            black: "#161616",
            red: "#dc2626",
            green: "#16a34a",
            yellow: "#ca8a04",
            blue: "#2563eb",
            magenta: "#9333ea",
            cyan: "#0284c7",
            white: "#ffffff",
            brightBlack: "#71717a",
            brightRed: "#ef4444",
            brightGreen: "#22c55e",
            brightYellow: "#eab308",
            brightBlue: "#3b82f6",
            brightMagenta: "#a855f7",
            brightCyan: "#06b6d4",
            brightWhite: "#f4f4f5"
          }
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Initialize backend PTY
    void window.lumen.terminal.init({
      cols: term.cols,
      rows: term.rows
    }).then((res) => {
      if (res?.cwd) setCwd(res.cwd);
    });

    const offData = window.lumen.terminal.onData((data) => {
      term.write(data);
    });

    const offExit = window.lumen.terminal.onExit((code) => {
      term.writeln(`\r\n\x1b[33m[Claude Code 进程已退出 (代码: ${code})，可点击顶部按钮重新启动]\x1b[0m\r\n`);
    });

    const termDataSub = term.onData((data) => {
      void window.lumen.terminal.write(data);
    });

    const handleResize = () => {
      if (!fitAddonRef.current || !termRef.current) return;
      try {
        fitAddonRef.current.fit();
        void window.lumen.terminal.resize(termRef.current.cols, termRef.current.rows);
      } catch (e) {}
    };

    window.addEventListener("resize", handleResize);

    // Initial delayed fit to accommodate layout animations
    const timer = setTimeout(handleResize, 100);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", handleResize);
      offData();
      offExit();
      termDataSub.dispose();
      term.dispose();
    };
  }, [isDark]);

  const handleSelectFolder = async () => {
    const selected = await window.lumen.terminal.selectFolder();
    if (!selected) return;
    setCwd(selected);
    setRestarting(true);
    if (termRef.current) {
      termRef.current.clear();
      termRef.current.writeln(`\x1b[36m[正在切换工作目录至: ${selected}]\x1b[0m\r\n`);
      const res = await window.lumen.terminal.restart({
        cols: termRef.current.cols,
        rows: termRef.current.rows,
        cwd: selected
      });
      if (res?.cwd) setCwd(res.cwd);
    }
    setRestarting(false);
  };

  const handleRestart = async () => {
    setRestarting(true);
    if (termRef.current) {
      termRef.current.clear();
      termRef.current.writeln(`\x1b[36m[正在重启 Claude Code 终端会话]\x1b[0m\r\n`);
      const res = await window.lumen.terminal.restart({
        cols: termRef.current.cols,
        rows: termRef.current.rows,
        cwd
      });
      if (res?.cwd) setCwd(res.cwd);
    }
    setRestarting(false);
  };

  const handleClear = () => {
    termRef.current?.clear();
  };

  // Format cwd to compact readable path
  const compactPath = cwd.replace(/^\/Users\/[^/]+/, "~");

  return (
    <div className="terminal-view">
      <div className="terminal-toolbar">
        <div className="terminal-meta">
          <span className="terminal-tag">Claude Code</span>
          <span className="terminal-path" title={cwd}>
            📁 {compactPath}
          </span>
        </div>
        <div className="terminal-actions">
          <button
            type="button"
            className="text-btn mini"
            onClick={() => void handleSelectFolder()}
            title="选择工程目录并打开"
          >
            切换目录
          </button>
          <button
            type="button"
            className="text-btn mini"
            disabled={restarting}
            onClick={() => void handleRestart()}
            title="重启终端会话"
          >
            {restarting ? "重启中" : "重启会话"}
          </button>
          <button
            type="button"
            className="text-btn mini"
            onClick={handleClear}
            title="清空终端屏幕"
          >
            清屏
          </button>
        </div>
      </div>
      <div className="terminal-body" ref={containerRef} />
    </div>
  );
}
