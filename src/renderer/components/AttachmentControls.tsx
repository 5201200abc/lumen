import { useEffect, useRef, useState } from "react";
import type { Attachment } from "@shared/types";
import { IconFileText, IconFolder, IconPlus } from "./icons";

type Props = {
  attachments: Attachment[];
  onAdd: (files: Attachment[]) => void;
  onRemove: (id: string) => void;
};

function formatBytes(value = 0): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function AttachmentList({ attachments, onRemove }: { attachments: Attachment[]; onRemove?: (id: string) => void }) {
  if (!attachments.length) return null;
  return (
    <div className="attachment-list" aria-label="Attached files">
      {attachments.map((file) => (
        <div className="attachment-row" key={file.id} title={file.path || file.name}>
          <span className={`attachment-icon ${file.kind || "file"}`}>
            {file.kind === "image" && file.dataUrl ? (
              <img src={file.dataUrl} alt="" />
            ) : file.relativePath ? (
              <IconFolder size={15} />
            ) : (
              <IconFileText size={15} />
            )}
          </span>
          <span className="attachment-copy">
            <strong>{file.relativePath || file.name}</strong>
            <small>{[file.kind === "document" ? "Document" : file.mime, formatBytes(file.size)].filter(Boolean).join(" · ")}</small>
          </span>
          {onRemove ? (
            <button type="button" className="attachment-remove" onClick={() => onRemove(file.id)} aria-label={`Remove ${file.name}`}>
              ×
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function AttachmentAddButton({ attachments, onAdd, onRemove }: Props) {
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

  const pick = async (kind: "files" | "folder") => {
    setBusy(true);
    setOpen(false);
    try {
      const selected =
        kind === "files"
          ? await window.lumen.attachments.pickFiles()
          : await window.lumen.attachments.pickFolder();
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
        aria-label="Add files or folders"
        title="Add files or folders"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <IconPlus size={13} />
      </button>
      {open ? (
        <div className="attachment-menu" role="menu">
          <span className="attachment-menu-title">Add</span>
          <button type="button" role="menuitem" onClick={() => void pick("files")}>
            <IconFileText size={17} />
            <span><strong>Files</strong><small>Images, PPT, PDF, code, and more</small></span>
          </button>
          <button type="button" role="menuitem" onClick={() => void pick("folder")}>
            <IconFolder size={17} />
            <span><strong>Folder</strong><small>Add files inside a local folder</small></span>
          </button>
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
