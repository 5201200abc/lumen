import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentRewindResult } from "./agent-runtime.js";
import type { NativeModelMessage } from "./native-model-client.js";

const execFileAsync = promisify(execFile);
const MAX_CHECKPOINT_FILES = 20_000;
const MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;
const FALLBACK_EXCLUDES = new Set([".git", "node_modules", "out", "dist", "build"]);

type SessionEvent =
  | { type: "snapshot"; messages: NativeModelMessage[]; at: number }
  | { type: "message"; message: NativeModelMessage; at: number }
  | { type: "turn"; checkpointId: string; at: number };

type CheckpointEntry = {
  path: string;
  hash?: string;
  size?: number;
  symlink?: boolean;
};

type CheckpointManifest = {
  workspace: string;
  createdAt: number;
  entries: CheckpointEntry[];
};

function defaultRoot(): string {
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "Lumen", "native-agent")
    : path.join(os.homedir(), ".lumen", "native-agent");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}

async function relevantFiles(root: string): Promise<string[]> {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }
    );
    return Buffer.from(result.stdout)
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
  } catch {
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (FALLBACK_EXCLUDES.has(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(root, absolute);
        if (entry.isDirectory()) await walk(absolute);
        else files.push(relative);
        if (files.length > MAX_CHECKPOINT_FILES) {
          throw new Error(`Checkpoint exceeds ${MAX_CHECKPOINT_FILES} files.`);
        }
      }
    };
    await walk(root);
    return files.sort();
  }
}

async function hasSymlinkComponent(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, target);
  if (!isInside(root, target)) return true;
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return true;
    } catch {
      break;
    }
  }
  return false;
}

async function hashFile(file: string): Promise<string> {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function lineCount(file: string): Promise<number> {
  try {
    const stat = await fs.stat(file);
    if (stat.size > 2 * 1024 * 1024) return 0;
    return (await fs.readFile(file, "utf8")).split("\n").length;
  } catch {
    return 0;
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export class NativeSessionStore {
  readonly sessionId: string;
  private readonly sessionDirectory: string;
  private readonly logPath: string;
  private readonly checkpointDirectory: string;

  constructor(sessionId?: string, root = defaultRoot()) {
    this.sessionId = sessionId || crypto.randomUUID();
    this.sessionDirectory = path.join(root, safeName(this.sessionId));
    this.logPath = path.join(this.sessionDirectory, "events.jsonl");
    this.checkpointDirectory = path.join(this.sessionDirectory, "checkpoints");
  }

  async loadMessages(): Promise<NativeModelMessage[]> {
    let raw = "";
    try {
      raw = await fs.readFile(this.logPath, "utf8");
    } catch {
      return [];
    }
    let messages: NativeModelMessage[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as SessionEvent;
        if (event.type === "snapshot") messages = event.messages;
        else if (event.type === "message") messages.push(event.message);
      } catch {
        // A crash can leave one incomplete final JSONL line. Earlier events remain valid.
      }
    }
    return messages;
  }

  private async append(event: SessionEvent): Promise<void> {
    await fs.mkdir(this.sessionDirectory, { recursive: true });
    await fs.appendFile(this.logPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  async appendMessage(message: NativeModelMessage): Promise<void> {
    await this.append({ type: "message", message, at: Date.now() });
  }

  async replaceMessages(messages: NativeModelMessage[]): Promise<void> {
    await this.append({ type: "snapshot", messages, at: Date.now() });
  }

  async beginTurn(checkpointId: string): Promise<void> {
    await this.append({ type: "turn", checkpointId, at: Date.now() });
  }

  async createCheckpoint(workspace: string, checkpointId: string): Promise<void> {
    const root = await fs.realpath(workspace);
    const directory = path.join(this.checkpointDirectory, safeName(checkpointId));
    const contentDirectory = path.join(directory, "files");
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(contentDirectory, { recursive: true });
    const entries: CheckpointEntry[] = [];
    let bytes = 0;
    const files = await relevantFiles(root);
    if (files.length > MAX_CHECKPOINT_FILES) {
      throw new Error(`Checkpoint exceeds ${MAX_CHECKPOINT_FILES} files.`);
    }
    for (const relative of files) {
      const source = path.resolve(root, relative);
      if (!isInside(root, source)) continue;
      const target = path.join(contentDirectory, relative);
      try {
        const stat = await fs.lstat(source);
        if (stat.isSymbolicLink()) {
          entries.push({ path: relative, symlink: true });
          continue;
        }
        if (!stat.isFile()) continue;
        bytes += stat.size;
        if (bytes > MAX_CHECKPOINT_BYTES) {
          await fs.rm(directory, { recursive: true, force: true });
          throw new Error(`Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes.`);
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target);
        entries.push({
          path: relative,
          size: stat.size,
          hash: await hashFile(target)
        });
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        await fs.rm(target, { force: true });
      }
    }
    const manifest: CheckpointManifest = {
      workspace: root,
      createdAt: Date.now(),
      entries
    };
    await fs.writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify(manifest),
      "utf8"
    );
  }

  async rewindFiles(
    workspace: string,
    checkpointId: string,
    dryRun = false
  ): Promise<AgentRewindResult> {
    const root = await fs.realpath(workspace);
    const directory = path.join(this.checkpointDirectory, safeName(checkpointId));
    let manifest: CheckpointManifest;
    try {
      manifest = JSON.parse(
        await fs.readFile(path.join(directory, "manifest.json"), "utf8")
      ) as CheckpointManifest;
    } catch {
      return { canRewind: false, error: "Native Agent checkpoint was not found." };
    }
    if (manifest.workspace !== root) {
      return { canRewind: false, error: "Checkpoint workspace does not match." };
    }
    const before = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    const current = new Set(await relevantFiles(root));
    const changed: string[] = [];
    let skippedLinks = 0;
    let insertions = 0;
    let deletions = 0;

    for (const [relative, entry] of before) {
      const target = path.resolve(root, relative);
      if (!isInside(root, target) || entry.symlink || await hasSymlinkComponent(root, target)) {
        skippedLinks += 1;
        continue;
      }
      let currentHash = "";
      try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) {
          skippedLinks += 1;
          continue;
        }
        if (stat.isFile()) currentHash = await hashFile(target);
      } catch {
        currentHash = "";
      }
      if (currentHash === entry.hash) continue;
      changed.push(relative);
      insertions += await lineCount(path.join(directory, "files", relative));
      deletions += await lineCount(target);
      if (!dryRun) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(directory, "files", relative), target);
      }
    }

    for (const relative of current) {
      if (before.has(relative)) continue;
      const target = path.resolve(root, relative);
      if (!isInside(root, target) || await hasSymlinkComponent(root, target)) {
        skippedLinks += 1;
        continue;
      }
      try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) {
          skippedLinks += 1;
          continue;
        }
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
      changed.push(relative);
      deletions += await lineCount(target);
      if (!dryRun) await fs.rm(target);
    }

    return {
      canRewind: changed.length > 0,
      filesChanged: changed.sort(),
      insertions,
      deletions,
      skippedLinks
    };
  }
}
