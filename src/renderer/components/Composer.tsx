import { useRef } from "react";
import type { Attachment, Effort } from "@shared/types";
import { IconArrowUp, IconGlobe, IconStop } from "./icons";
import { ModelPicker } from "./ModelPicker";

type Props = {
  value: string;
  model: string;
  models: string[];
  effort: Effort;
  webSearch: boolean;
  streaming: boolean;
  attachments: Attachment[];
  onChange: (v: string) => void;
  onModel: (m: string) => void;
  onEffort: (e: Effort) => void;
  onWebSearch: (v: boolean) => void;
  onSend: () => void;
  onStop: () => void;
  onAttach: (files: Attachment[]) => void;
  onRemove: (id: string) => void;
};

async function readFiles(files: FileList | File[]): Promise<Attachment[]> {
  const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
  const attachments = await Promise.all(
    list.map(
      (file) =>
        new Promise<Attachment | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              id: crypto.randomUUID(),
              mime: file.type,
              name: file.name,
              dataUrl: String(reader.result)
            });
          reader.onerror = () => resolve(null);
          reader.onabort = () => resolve(null);
          reader.readAsDataURL(file);
        })
    )
  );
  return attachments.filter((item): item is Attachment => item !== null);
}

export function Composer(props: Props) {
  const area = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="composer-wrap">
      <div
        className="composer"
        onDragOver={(e) => {
          e.preventDefault();
          e.currentTarget.classList.add("drop");
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove("drop")}
        onDrop={async (e) => {
          e.preventDefault();
          e.currentTarget.classList.remove("drop");
          if (e.dataTransfer.files.length) props.onAttach(await readFiles(e.dataTransfer.files));
        }}
      >
        {props.attachments.length > 0 && (
          <div className="attach-list">
            {props.attachments.map((a) => (
              <div className="attach" key={a.id}>
                <img src={a.dataUrl} alt={a.name} />
                <button type="button" onClick={() => props.onRemove(a.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          rows={2}
          placeholder="Ask Lumen"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          onPaste={async (e) => {
            const files = Array.from(e.clipboardData.items)
              .map((i) => i.getAsFile())
              .filter((f): f is File => Boolean(f && f.type.startsWith("image/")));
            if (files.length) {
              e.preventDefault();
              props.onAttach(await readFiles(files));
            }
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            props.onSend();
          }}
        />
        <div className="composer-bar">
          <div className="left-tools">
            <button
              className="icon-chip"
              type="button"
              aria-pressed={props.webSearch}
              aria-label="全网检索"
              title="全网检索"
              onClick={() => props.onWebSearch(!props.webSearch)}
            >
              <IconGlobe />
            </button>
          </div>
          <div className="right-tools">
            <ModelPicker
              model={props.model}
              models={props.models}
              effort={props.effort}
              onModel={props.onModel}
              onEffort={props.onEffort}
            />
            {props.streaming ? (
              <button className="send stop" type="button" onClick={props.onStop} aria-label="停止生成" title="停止生成">
                <IconStop />
              </button>
            ) : (
              <button
                className="send"
                type="button"
                disabled={!props.value.trim() && props.attachments.length === 0}
                onClick={props.onSend}
                aria-label="发送"
                title="发送"
              >
                <IconArrowUp />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
