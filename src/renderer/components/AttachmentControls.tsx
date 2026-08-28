import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment, Language } from "@shared/types";
import {
  IconArchive,
  IconCode,
  IconFilePdf,
  IconFilePpt,
  IconFileSpreadsheet,
  IconFileText,
  IconFileWord,
  IconFolder,
  IconGear,
  IconGlobe,
  IconImage,
  IconLaptop,
  IconMusic,
  IconPaperclip,
  IconPlus,
  IconVideo
} from "./icons";

type Props = {
  attachments: Attachment[];
  onAdd: (files: Attachment[]) => void;
  onRemove: (id: string) => void;
  language?: Language;
  pluginActions?: Array<{
    id: "sites" | "browser" | "plugins";
    label: string;
    description: string;
    available: boolean;
    onSelect: () => void;
  }>;
};

function formatBytes(value = 0): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function AttachmentImage({
  attachment,
  variant = "card"
}: {
  attachment: Attachment;
  variant?: "card" | "icon";
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  if (!attachment.dataUrl) return null;
  return (
    <>
      <button
        type="button"
        className={variant === "card" ? "user-image-card" : "attachment-image-button"}
        title={attachment.name}
        aria-label={`Open ${attachment.name}`}
        onClick={() => setOpen(true)}
      >
        <img src={attachment.dataUrl} alt={attachment.name} loading="lazy" />
      </button>
      {open
        ? createPortal(
            <div
              className="image-preview-backdrop"
              role="dialog"
              aria-modal="true"
              aria-label={attachment.name}
              onMouseDown={(event) => {
                if (event.currentTarget === event.target) setOpen(false);
              }}
            >
              <button
                type="button"
                className="image-preview-close"
                aria-label="Close image preview"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
              <img className="image-preview-full" src={attachment.dataUrl} alt={attachment.name} />
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function getAttachmentExt(file: Attachment): string {
  const target = file.name || file.relativePath || file.path || "";
  const match = target.match(/\.([0-9a-z]+)$/i);
  return match ? match[1].toLowerCase() : "";
}

function getAttachmentCategory(file: Attachment): {
  kind: "folder" | "video" | "audio" | "image" | "pdf" | "ppt" | "word" | "spreadsheet" | "code" | "archive" | "text" | "file";
  label: string;
} {
  if (file.relativePath) {
    return { kind: "folder", label: "Folder" };
  }
  const ext = getAttachmentExt(file);
  const mime = (file.mime || "").toLowerCase();

  if (file.kind === "video" || mime.startsWith("video/") || ["mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v", "3gp", "ts"].includes(ext)) {
    return { kind: "video", label: ext ? `${ext.toUpperCase()} Video` : "Video" };
  }
  if (file.kind === "audio" || mime.startsWith("audio/") || ["mp3", "wav", "m4a", "aac", "flac", "ogg", "wma", "aiff"].includes(ext)) {
    return { kind: "audio", label: ext ? `${ext.toUpperCase()} Audio` : "Audio" };
  }
  if (file.kind === "image" || mime.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "ico", "tiff"].includes(ext)) {
    return { kind: "image", label: ext ? `${ext.toUpperCase()} Image` : "Image" };
  }
  if (file.kind === "pdf" || mime === "application/pdf" || ext === "pdf") {
    return { kind: "pdf", label: "PDF Document" };
  }
  if (["pptx", "ppt", "key"].includes(ext)) {
    return { kind: "ppt", label: "PowerPoint" };
  }
  if (["docx", "doc", "pages", "odt", "rtf"].includes(ext)) {
    return { kind: "word", label: "Word Document" };
  }
  if (["xlsx", "xls", "numbers", "csv", "tsv"].includes(ext)) {
    return { kind: "spreadsheet", label: ext === "csv" ? "CSV" : ext === "tsv" ? "TSV" : "Spreadsheet" };
  }
  if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz"].includes(ext)) {
    return { kind: "archive", label: ext ? `${ext.toUpperCase()} Archive` : "Archive" };
  }
  if (file.kind === "code" || ["js", "jsx", "ts", "tsx", "py", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "zsh", "bash", "sql", "graphql", "html", "htm", "css", "scss", "json", "yaml", "yml", "toml", "xml", "env"].includes(ext)) {
    return { kind: "code", label: ext ? `${ext.toUpperCase()} Code` : "Source Code" };
  }
  if (file.kind === "text" || ["txt", "md", "markdown", "log", "rst"].includes(ext)) {
    return { kind: "text", label: ext === "md" ? "Markdown" : "Text" };
  }
  if (file.kind === "document") {
    return { kind: "word", label: "Document" };
  }
  return { kind: "file", label: ext ? ext.toUpperCase() : "File" };
}

function getCategoryLabel(file: Attachment, isZh = false): string {
  const { kind, label } = getAttachmentCategory(file);
  const ext = getAttachmentExt(file).toUpperCase();
  if (!isZh) return label;
  switch (kind) {
    case "folder": return "文件夹";
    case "video": return ext ? `${ext} 视频` : "视频";
    case "audio": return ext ? `${ext} 音频` : "音频";
    case "image": return ext ? `${ext} 图片` : "图片";
    case "pdf": return "PDF 文档";
    case "ppt": return "PowerPoint 幻灯片";
    case "word": return "Word 文档";
    case "spreadsheet": return ext === "CSV" ? "CSV 表格" : ext === "TSV" ? "TSV 表格" : "Excel 表格";
    case "code": return ext ? `${ext} 源码` : "代码文件";
    case "archive": return ext ? `${ext} 压缩包` : "压缩包";
    case "text": return "文本文件";
    default: return ext ? `${ext} 文件` : "文件";
  }
}

function renderAttachmentIcon(file: Attachment) {
  if (file.kind === "image" && file.dataUrl) {
    return <AttachmentImage attachment={file} variant="icon" />;
  }
  const { kind } = getAttachmentCategory(file);
  switch (kind) {
    case "folder":
      return <IconFolder size={15} />;
    case "video":
      return <IconVideo size={15} />;
    case "audio":
      return <IconMusic size={15} />;
    case "image":
      return <IconImage size={15} />;
    case "pdf":
      return <IconFilePdf size={15} />;
    case "ppt":
      return <IconFilePpt size={15} />;
    case "word":
      return <IconFileWord size={15} />;
    case "spreadsheet":
      return <IconFileSpreadsheet size={15} />;
    case "code":
      return <IconCode size={15} />;
    case "archive":
      return <IconArchive size={15} />;
    default:
      return <IconFileText size={15} />;
  }
}

export function AttachmentList({
  attachments,
  onRemove,
  language
}: {
  attachments: Attachment[];
  onRemove?: (id: string) => void;
  language?: Language;
}) {
  if (!attachments.length) return null;
  const isZh = (language ?? "en") === "zh";

  return (
    <div className="attachment-list" aria-label="Attached files">
      {attachments.map((file) => {
        const { kind } = getAttachmentCategory(file);
        return (
          <div className="attachment-row" key={file.id} title={file.path || file.name}>
            <span className={`attachment-icon ${kind}`}>
              {renderAttachmentIcon(file)}
            </span>
            <span className="attachment-copy">
              <strong>{file.relativePath || file.name}</strong>
              <small>{[getCategoryLabel(file, isZh), formatBytes(file.size)].filter(Boolean).join(" · ")}</small>
            </span>
            {onRemove ? (
              <button type="button" className="attachment-remove" onClick={() => onRemove(file.id)} aria-label={`Remove ${file.name}`}>
                ×
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function AttachmentAddButton({ attachments, onAdd, language, pluginActions = [] }: Props) {
  const isZh = (language ?? "en") === "zh";
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const pick = async () => {
    setBusy(true);
    setOpen(false);
    try {
      const selected = await window.lumen.attachments.pickFilesAndFolders();
      if (selected.length) onAdd(selected);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="attachment-add" ref={root}>
      <button
        className="icon-chip attachment-trigger"
        type="button"
        aria-label={isZh ? "添加文件或文件夹" : "Add files or folders"}
        title={isZh ? "添加文件或文件夹" : "Add files or folders"}
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <IconPlus size={13} />
      </button>
      {open ? (
        <div className="attachment-menu" role="menu">
          <span className="attachment-menu-title">{isZh ? "添加" : "Add"}</span>
          <button type="button" role="menuitem" onClick={() => void pick()}>
            <IconPaperclip size={14} />
            <span className="attachment-menu-item-text">
              <strong>{isZh ? "文件与文件夹" : "File and folder"}</strong>
              <small>{isZh ? "图片、文档、pptx" : "Images, docs, pptx"}</small>
            </span>
          </button>
          {pluginActions.length ? (
            <>
              <div className="attachment-menu-divider" />
              <span className="attachment-menu-title">Plugins</span>
              {pluginActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  disabled={!action.available}
                  onClick={() => {
                    setOpen(false);
                    action.onSelect();
                  }}
                >
                  {action.id === "browser" ? <IconGlobe size={14} /> : action.id === "sites" ? <IconLaptop size={14} /> : <IconGear size={14} />}
                  <span className="attachment-menu-item-text">
                    <strong>{action.label}</strong>
                    <small>{action.description}</small>
                  </span>
                </button>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
      <span className="sr-only">{attachments.length} attachments</span>
    </div>
  );
}

export async function readDroppedFiles(files: FileList | File[]): Promise<Attachment[]> {
  const list = Array.from(files).slice(0, 40);
  const attachments = await Promise.all(
    list.map(async (file): Promise<Attachment | null> => {
      const base: Attachment = {
        id: crypto.randomUUID(),
        mime: file.type || "application/octet-stream",
        name: file.name,
        size: file.size,
        kind: "file"
      };
      if (file.size > 25 * 1024 * 1024) return base;
      if (file.type.startsWith("image/")) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        return { ...base, kind: "image", dataUrl };
      }
      if (file.type.startsWith("text/") || /\.(md|json|csv|xml|ya?ml|toml|log|[cm]?[jt]sx?|py|go|rs|java|swift|sh|sql)$/i.test(file.name)) {
        return { ...base, kind: "text", text: (await file.text()).slice(0, 180_000) };
      }
      return base;
    })
  );
  return attachments.filter((item): item is Attachment => item !== null);
}
