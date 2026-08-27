import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "@shared/types";
import { IconFileText, IconGear, IconGlobe, IconLaptop, IconPlus } from "./icons";

type Props = {
  attachments: Attachment[];
  onAdd: (files: Attachment[]) => void;
  onRemove: (id: string) => void;
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

export function AttachmentList({ attachments, onRemove }: { attachments: Attachment[]; onRemove?: (id: string) => void }) {
  if (!attachments.length) return null;
  return (
    <div className="attachment-list" aria-label="Attached files">
      {attachments.map((file) => (
        <div className="attachment-row" key={file.id} title={file.path || file.name}>
          <span className={`attachment-icon ${file.kind || "file"}`}>
            {file.kind === "image" && file.dataUrl ? (
              <AttachmentImage attachment={file} variant="icon" />
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

export function AttachmentAddButton({ attachments, onAdd, pluginActions = [] }: Props) {
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
          <button type="button" role="menuitem" onClick={() => void pick()}>
            <IconFileText size={17} />
            <span><strong>File and folder</strong><small>Images, documents, code, or a local folder</small></span>
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
                  {action.id === "browser" ? <IconGlobe size={17} /> : action.id === "sites" ? <IconLaptop size={17} /> : <IconGear size={17} />}
                  <span><strong>{action.label}</strong><small>{action.description}</small></span>
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
