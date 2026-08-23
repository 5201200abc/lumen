import { useEffect, useState } from "react";
import type { Settings } from "@shared/types";
import { IconTrash } from "./icons";

type Props = {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
  onDeleteAllMemories?: () => void;
  onDeleteAllChats: () => void;
};

export function SettingsPanel(props: Props) {
  const s = props.settings;
  const [prompt, setPrompt] = useState(s.systemPrompt);
  const [memDeleted, setMemDeleted] = useState(false);
  useEffect(() => setPrompt(s.systemPrompt), [s.systemPrompt]);

  const handleDeleteMemories = () => {
    if (props.onDeleteAllMemories) {
      props.onDeleteAllMemories();
      setMemDeleted(true);
      setTimeout(() => setMemDeleted(false), 1500);
    }
  };

  return (
    <div className="overlay" onClick={props.onClose}>
      <section className="settings" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <label className="field">
          <span>Llama API URL</span>
          <input value={s.llamaUrl} onChange={(e) => props.onChange({ llamaUrl: e.target.value })} />
        </label>
        <label className="field">
          <span>Llama API Key</span>
          <input
            type="password"
            value={s.llamaApiKey}
            onChange={(e) => props.onChange({ llamaApiKey: e.target.value })}
            placeholder="optional"
          />
        </label>
        <label className="field">
          <span>Model</span>
          <input value={s.model} onChange={(e) => props.onChange({ model: e.target.value })} />
        </label>
        <label className="field">
          <span>Tavily API Key</span>
          <input
            type="password"
            value={s.tavilyApiKey}
            onChange={(e) => props.onChange({ tavilyApiKey: e.target.value })}
          />
        </label>
        <label className="field">
          <span>default effort</span>
          <select
            value={s.defaultEffort}
            onChange={(e) => props.onChange({ defaultEffort: e.target.value as Settings["defaultEffort"] })}
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="xhigh">xhigh</option>
          </select>
        </label>
        <label className="field">
          <span>Theme</span>
          <select
            value={s.theme}
            onChange={(e) => props.onChange({ theme: e.target.value as Settings["theme"] })}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label className="field prompt">
          <span>rule</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => {
              if (prompt !== s.systemPrompt) props.onChange({ systemPrompt: prompt });
            }}
            spellCheck={false}
          />
        </label>
        <div className="row">
          <span>Memory</span>
          <button
            className={`toggle ${s.memoryEnabled ? "on" : ""}`}
            type="button"
            onClick={() => props.onChange({ memoryEnabled: !s.memoryEnabled })}
          >
            <i />
          </button>
        </div>
        <div className="row">
          <span>Delete all memory</span>
          <button
            className="icon-btn ghost-icon danger-icon"
            type="button"
            title={memDeleted ? "已清除" : "Delete all memory"}
            onClick={handleDeleteMemories}
          >
            <IconTrash />
          </button>
        </div>
        <div className="row">
          <span>Delete all chat</span>
          <button
            className="icon-btn ghost-icon danger-icon"
            type="button"
            title="Delete all chat"
            onClick={props.onDeleteAllChats}
          >
            <IconTrash />
          </button>
        </div>
      </section>
    </div>
  );
}
