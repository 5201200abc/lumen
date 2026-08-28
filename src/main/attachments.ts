import { BrowserWindow, dialog, ipcMain } from "electron";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import JSZip from "jszip";
import type { Attachment } from "@shared/types";

const MAX_FILES = 120;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 180_000;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".tiff"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv", ".m4v", ".3gp", ".ts"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".wma", ".aiff"]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".tgz"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const CODE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh", ".zsh", ".bash", ".sql",
  ".graphql", ".html", ".htm", ".css", ".scss", ".json", ".yaml", ".yml", ".toml", ".xml", ".env"
]);
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".xml", ".yaml", ".yml",
  ".toml", ".ini", ".log", ".html", ".htm", ".css", ".scss", ".js", ".jsx", ".ts", ".tsx",
  ".py", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".sh", ".zsh",
  ".bash", ".sql", ".graphql", ".env"
]);

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska", ".webm": "video/webm", ".m4v": "video/x-m4v",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/m4a",
  ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg",
  ".zip": "application/zip", ".rar": "application/vnd.rar", ".7z": "application/x-7z-compressed",
  ".tar": "application/x-tar", ".gz": "application/gzip",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

function decodeXml(value: string): string {
  return value
    .replace(/<a:br\s*\/>/g, "\n")
    .replace(/<\/(?:a:p|w:p|row)>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

async function officeText(buffer: Buffer, extension: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter((name) => {
      if (extension === ".pptx") return /^ppt\/slides\/slide\d+\.xml$/.test(name);
      if (extension === ".docx") return name === "word/document.xml";
      if (extension === ".xlsx") return name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
      return false;
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const parts: string[] = [];
  for (const name of names) {
    const entry = zip.file(name);
    if (!entry) continue;
    const text = decodeXml(await entry.async("text"));
    if (text) parts.push(text);
    if (parts.join("\n\n").length >= MAX_TEXT_CHARS) break;
  }
  return parts.join("\n\n").slice(0, MAX_TEXT_CHARS);
}

async function collectFiles(root: string): Promise<Array<{ path: string; relativePath?: string }>> {
  const rootStat = await stat(root);
  if (rootStat.isFile()) return [{ path: root }];
  const out: Array<{ path: string; relativePath: string }> = [];
  const walk = async (directory: string): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= MAX_FILES || entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out.push({ path, relativePath: relative(root, path) });
    }
  };
  await walk(root);
  return out;
}

async function serializeFile(path: string, relativePath?: string): Promise<Attachment | null> {
  const info = await stat(path);
  if (!info.isFile()) return null;
  const extension = extname(path).toLowerCase();
  const mime = MIME[extension] || (TEXT_EXTENSIONS.has(extension) ? "text/plain" : "application/octet-stream");
  let kind: Attachment["kind"] = "file";
  if (IMAGE_EXTENSIONS.has(extension)) kind = "image";
  else if (VIDEO_EXTENSIONS.has(extension)) kind = "video";
  else if (AUDIO_EXTENSIONS.has(extension)) kind = "audio";
  else if (PDF_EXTENSIONS.has(extension)) kind = "pdf";
  else if (ARCHIVE_EXTENSIONS.has(extension)) kind = "archive";
  else if (extension === ".pptx" || extension === ".docx" || extension === ".xlsx" || extension === ".ppt" || extension === ".doc" || extension === ".xls") kind = "document";
  else if (CODE_EXTENSIONS.has(extension)) kind = "code";
  else if (TEXT_EXTENSIONS.has(extension)) kind = "text";

  const base: Attachment = {
    id: crypto.randomUUID(),
    mime,
    name: basename(path),
    path,
    relativePath,
    size: info.size,
    kind
  };
  // Large files remain valid local attachments. Avoid copying their entire
  // payload into renderer memory; Cowork can read the selected path directly.
  if (info.size > MAX_FILE_BYTES) return base;
  if (IMAGE_EXTENSIONS.has(extension)) {
    const buffer = await readFile(path);
    return { ...base, kind: "image", dataUrl: `data:${mime};base64,${buffer.toString("base64")}` };
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return { ...base, kind: base.kind, text: (await readFile(path, "utf8")).slice(0, MAX_TEXT_CHARS) };
  }
  if (extension === ".pptx" || extension === ".docx" || extension === ".xlsx") {
    try {
      return { ...base, kind: "document", text: await officeText(await readFile(path), extension) };
    } catch {
      return { ...base, kind: "document" };
    }
  }
  return base;
}

async function serializePaths(paths: string[]): Promise<Attachment[]> {
  const files = (await Promise.all(paths.map(collectFiles))).flat().slice(0, MAX_FILES);
  const attachments = await Promise.all(files.map((file) => serializeFile(file.path, file.relativePath)));
  return attachments.filter((item): item is Attachment => item !== null);
}

export function registerAttachmentIpc(): void {
  ipcMain.handle("attachments:pickFilesAndFolders", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      title: "Add file or folder",
      properties: ["openFile", "openDirectory", "multiSelections"]
    });
    return result.canceled ? [] : serializePaths(result.filePaths);
  });
  ipcMain.handle("attachments:pickFiles", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      title: "Add files",
      properties: ["openFile", "multiSelections"]
    });
    return result.canceled ? [] : serializePaths(result.filePaths);
  });
  ipcMain.handle("attachments:pickFolder", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      title: "Add folder",
      properties: ["openDirectory", "multiSelections"]
    });
    return result.canceled ? [] : serializePaths(result.filePaths);
  });
}
