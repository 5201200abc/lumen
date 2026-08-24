import { useEffect, useMemo, useState } from "react";
import type { Language, Settings } from "@shared/types";
import { IconTrash } from "./icons";

type Page = "general" | "models" | "instructions" | "data";
type Action = "chat" | "cowork" | "rule" | "memory" | "chats" | "setting";
type Props = {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => Promise<void>;
  onClose: () => void;
  onDeleteAllMemories?: () => Promise<void>;
  onDeleteAllChats: () => Promise<boolean>;
};

const COPY = {
  en: {
    settings: "Settings", back: "Back", general: "General", models: "Models",
    instructions: "Instructions", data: "Data", language: "Language",
    languageHelp: "Choose the interface language.", fontSize: "Font size",
    fontHelp: "Small is the current and minimum size.", theme: "Theme",
    small: "Small · 13px", medium: "Medium · 15px", large: "Large · 17px",
    llama: "Llama endpoints", llamaHelp: "Keep multiple OpenAI-compatible Llama servers and select the active one.",
    modelList: "Model list", modelHelp: "Models listed here are available in Chat and Cowork.",
    addLlama: "Add Llama", addModel: "Add model", active: "Active", use: "Use",
    name: "Name", url: "API URL", modelName: "Model name", apiKeys: "API keys",
    custom: "Custom instructions", customHelp: "Separate guidance for Chat and tool-using Cowork sessions.",
    chatCustom: "Chat custom instructions", coworkCustom: "Cowork custom instructions",
    rule: "Model rule style", modify: "Modify", saveLock: "Save & lock",
    protected: "Style rule protected",
    protectedHelp: "Includes concise reasoning and loop prevention. Modify only to change output style.",
    memory: "Memory", deleteMemory: "Delete all memory", deleteChat: "Delete all chat",
    dataHelp: "These actions affect local data and the next Google backup.",
    save: "Save", saved: "Saved", saving: "Saving", unsaved: "Unsaved changes"
  },
  zh: {
    settings: "设置", back: "返回", general: "通用", models: "模型", instructions: "指令",
    data: "数据", language: "语言", languageHelp: "选择界面显示语言。", fontSize: "字体大小",
    fontHelp: "小号是当前字号，也是最低值。", theme: "主题", small: "小 · 13px",
    medium: "中 · 15px", large: "大 · 17px", llama: "Llama 列表",
    llamaHelp: "保存多个兼容 OpenAI 的 Llama 服务，并选择当前服务。", modelList: "模型列表",
    modelHelp: "这里的模型可在 Chat 和 Cowork 中选择。", addLlama: "新增 Llama", addModel: "新增模型",
    active: "当前", use: "使用", name: "名称", url: "API 地址", modelName: "模型名称",
    apiKeys: "API 密钥", custom: "自定义指令", customHelp: "分别设置 Chat 和使用工具的 Cowork 指令。",
    chatCustom: "Chat 自定义指令", coworkCustom: "Cowork 自定义指令", rule: "模型规则风格",
    modify: "修改", saveLock: "保存并锁定", protected: "规则已保护",
    protectedHelp: "包含简洁推理和防止循环的规则，仅在需要改变输出风格时修改。",
    memory: "记忆", deleteMemory: "删除全部记忆", deleteChat: "删除全部对话",
    dataHelp: "这些操作会影响本地数据和下一次 Google 备份。", save: "保存",
    saved: "已保存", saving: "保存中", unsaved: "未保存"
  }
} as const;

export function SettingsPanel(props: Props) {
  const s = props.settings;
  const [page, setPage] = useState<Page>("general");
  const [chatInstructions, setChatInstructions] = useState(s.chatInstructions);
  const [coworkInstructions, setCoworkInstructions] = useState(s.coworkInstructions);
  const [rule, setRule] = useState(s.systemPrompt);
  const [ruleEditable, setRuleEditable] = useState(false);
  const [saving, setSaving] = useState<Action | null>(null);
  const [saved, setSaved] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newLlama, setNewLlama] = useState({ name: "", url: "http://127.0.0.1:18082/v1" });
  const [adding, setAdding] = useState<"model" | "llama" | null>(null);
  const t = COPY[s.language];

  useEffect(() => setChatInstructions(s.chatInstructions), [s.chatInstructions]);
  useEffect(() => setCoworkInstructions(s.coworkInstructions), [s.coworkInstructions]);
  useEffect(() => setRule(s.systemPrompt), [s.systemPrompt]);

  const dirty = useMemo(() =>
    chatInstructions !== s.chatInstructions ||
    coworkInstructions !== s.coworkInstructions ||
    (ruleEditable && rule !== s.systemPrompt),
  [chatInstructions, coworkInstructions, rule, ruleEditable, s]);

  const run = async (action: Action, operation: () => Promise<void | boolean>): Promise<boolean> => {
    setSaving(action); setSaved(null); setError("");
    try {
      const completed = await operation();
      if (completed === false) return false;
      setSaved(action);
      window.setTimeout(() => setSaved((current) => current === action ? null : current), 1800);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(null);
    }
  };

  const patch = (value: Partial<Settings>) => run("setting", () => props.onChange(value));
  const requestClose = () => {
    if (dirty && !window.confirm("Discard unsaved settings changes?")) return;
    props.onClose();
  };
  const addModel = async () => {
    const model = newModel.trim();
    if (!model) return;
    if (await patch({ modelCatalog: [...new Set([...s.modelCatalog, model])], model })) {
      setNewModel(""); setAdding(null);
    }
  };
  const addLlama = async () => {
    if (!newLlama.name.trim() || !newLlama.url.trim()) return;
    const endpoint = { id: crypto.randomUUID(), name: newLlama.name.trim(), url: newLlama.url.trim() };
    if (await patch({ llamaEndpoints: [...s.llamaEndpoints, endpoint], llamaUrl: endpoint.url })) {
      setNewLlama({ name: "", url: "http://127.0.0.1:18082/v1" }); setAdding(null);
    }
  };
  const nav: Array<{ id: Page; label: string }> = [
    { id: "general", label: t.general }, { id: "models", label: t.models },
    { id: "instructions", label: t.instructions }, { id: "data", label: t.data }
  ];

  return (
    <div className="settings-stage">
      <section className="settings-shell" aria-label={t.settings}>
        <aside className="settings-nav">
          <button className="settings-back" type="button" onClick={requestClose} aria-label={t.back}>
            <span aria-hidden="true">←</span>{t.back}
          </button>
          <h2>{t.settings}</h2>
          <nav>{nav.map((item) => (
            <button key={item.id} className={page === item.id ? "active" : ""} type="button" onClick={() => setPage(item.id)}>
              {item.label}
            </button>
          ))}</nav>
        </aside>

        <main className="settings-content">
          <header><span>Lumen</span><h3>{nav.find((item) => item.id === page)?.label}</h3></header>

          {page === "general" && <div className="settings-page">
            <div className="setting-row"><div><strong>{t.language}</strong><small>{t.languageHelp}</small></div>
              <select value={s.language} onChange={(e) => void patch({ language: e.target.value as Language })}>
                <option value="en">English</option><option value="zh">中文</option>
              </select>
            </div>
            <div className="setting-row"><div><strong>{t.fontSize}</strong><small>{t.fontHelp}</small></div>
              <select value={s.fontSize} onChange={(e) => void patch({ fontSize: e.target.value as Settings["fontSize"] })}>
                <option value="small">{t.small}</option><option value="medium">{t.medium}</option><option value="large">{t.large}</option>
              </select>
            </div>
            <div className="setting-row"><div><strong>{t.theme}</strong></div>
              <select value={s.theme} onChange={(e) => void patch({ theme: e.target.value as Settings["theme"] })}>
                <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
              </select>
            </div>
          </div>}

          {page === "models" && <div className="settings-page">
            <section className="settings-list">
              <div className="settings-list-head"><div><h4>{t.llama}</h4><p>{t.llamaHelp}</p></div><button title={t.addLlama} type="button" onClick={() => setAdding(adding === "llama" ? null : "llama")}>＋</button></div>
              {s.llamaEndpoints.map((endpoint) => <div className="model-list-row" key={endpoint.id}>
                <div><strong>{endpoint.name}</strong><small>{endpoint.url}</small></div>
                <div className="row-actions">{s.llamaUrl === endpoint.url ? <span>{t.active}</span> : <button type="button" onClick={() => void patch({ llamaUrl: endpoint.url })}>{t.use}</button>}
                  <button type="button" aria-label={`Delete ${endpoint.name}`} disabled={s.llamaUrl === endpoint.url || s.llamaEndpoints.length === 1} onClick={() => void patch({ llamaEndpoints: s.llamaEndpoints.filter((item) => item.id !== endpoint.id) })}>×</button></div>
              </div>)}
              {adding === "llama" && <div className="inline-add"><input autoFocus placeholder={t.name} value={newLlama.name} onChange={(e) => setNewLlama((v) => ({ ...v, name: e.target.value }))}/><input placeholder={t.url} value={newLlama.url} onChange={(e) => setNewLlama((v) => ({ ...v, url: e.target.value }))}/><button type="button" onClick={() => void addLlama()}>{t.save}</button></div>}
            </section>
            <section className="settings-list">
              <div className="settings-list-head"><div><h4>{t.modelList}</h4><p>{t.modelHelp}</p></div><button title={t.addModel} type="button" onClick={() => setAdding(adding === "model" ? null : "model")}>＋</button></div>
              {s.modelCatalog.map((model) => <div className="model-list-row" key={model}><strong>{model}</strong>
                <div className="row-actions">{s.model === model ? <span>{t.active}</span> : <button type="button" onClick={() => void patch({ model })}>{t.use}</button>}
                  <button type="button" aria-label={`Delete ${model}`} disabled={s.modelCatalog.length === 1} onClick={() => void patch({ modelCatalog: s.modelCatalog.filter((item) => item !== model) })}>×</button></div>
              </div>)}
              {adding === "model" && <div className="inline-add single"><input autoFocus placeholder={t.modelName} value={newModel} onChange={(e) => setNewModel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void addModel()}/><button type="button" onClick={() => void addModel()}>{t.save}</button></div>}
            </section>
            <section className="settings-list">
              <div className="settings-list-head"><div><h4>{t.apiKeys}</h4></div></div>
              <label className="compact-field"><span>Llama API key</span><input type="password" value={s.llamaApiKey} onChange={(e) => void patch({ llamaApiKey: e.target.value })} placeholder="Optional"/></label>
              <label className="compact-field"><span>Tavily API key</span><input type="password" value={s.tavilyApiKey} onChange={(e) => void patch({ tavilyApiKey: e.target.value })}/></label>
              <label className="compact-field"><span>Default effort</span><select value={s.defaultEffort} onChange={(e) => void patch({ defaultEffort: e.target.value as Settings["defaultEffort"] })}><option value="low">low</option><option value="medium">medium</option><option value="xhigh">xhigh</option></select></label>
            </section>
          </div>}

          {page === "instructions" && <div className="settings-page">
            <div className="page-intro"><h4>{t.custom}</h4><p>{t.customHelp}</p></div>
            <label className="field prompt"><span>{t.chatCustom}</span><textarea value={chatInstructions} onChange={(e) => { setChatInstructions(e.target.value); setSaved(null); }} placeholder="How should Chat respond, format answers, or address you?"/><span className="field-action-row"><small>{saved === "chat" ? t.saved : chatInstructions !== s.chatInstructions ? t.unsaved : ""}</small><button className="settings-save" type="button" disabled={saving !== null || chatInstructions === s.chatInstructions} onClick={() => void run("chat", () => props.onChange({ chatInstructions }))}>{saving === "chat" ? t.saving : t.save}</button></span></label>
            <label className="field prompt"><span>{t.coworkCustom}</span><textarea value={coworkInstructions} onChange={(e) => { setCoworkInstructions(e.target.value); setSaved(null); }} placeholder="Project rules, preferred workflow, verification requirements"/><span className="field-action-row"><small>{saved === "cowork" ? t.saved : coworkInstructions !== s.coworkInstructions ? t.unsaved : ""}</small><button className="settings-save" type="button" disabled={saving !== null || coworkInstructions === s.coworkInstructions} onClick={() => void run("cowork", () => props.onChange({ coworkInstructions }))}>{saving === "cowork" ? t.saving : t.save}</button></span></label>
            <label className={`field prompt rule-field ${ruleEditable ? "editing" : "locked"}`}><span className="rule-label-row"><span>{t.rule}</span>{!ruleEditable ? <button type="button" className="text-button" onClick={() => window.confirm("Changing this rule alters the model's voice and output style. Continue?") && setRuleEditable(true)}>{t.modify}</button> : <button type="button" className="text-button" disabled={saving !== null} onClick={() => void run("rule", () => props.onChange({ systemPrompt: rule })).then((ok) => ok && setRuleEditable(false))}>{saving === "rule" ? t.saving : t.saveLock}</button>}</span><div className="locked-rule-wrap"><textarea value={rule} readOnly={!ruleEditable} onChange={(e) => setRule(e.target.value)} tabIndex={ruleEditable ? 0 : -1}/>{!ruleEditable && <div className="rule-lock-note"><span>{t.protected}</span><small>{t.protectedHelp}</small></div>}</div></label>
          </div>}

          {page === "data" && <div className="settings-page">
            <div className="page-intro"><p>{t.dataHelp}</p></div>
            <div className="danger-row"><span>{t.memory}</span><button className={`toggle ${s.memoryEnabled ? "on" : ""}`} type="button" aria-label={t.memory} aria-pressed={s.memoryEnabled} onClick={() => void patch({ memoryEnabled: !s.memoryEnabled })}><i /></button></div>
            <div className="danger-row"><span>{t.deleteMemory}</span><button className="icon-btn ghost-icon danger-icon" type="button" disabled={saving !== null} aria-label={t.deleteMemory} onClick={() => { if (window.confirm("Delete all memory? This cannot be undone.")) void run("memory", async () => { if (!props.onDeleteAllMemories) throw new Error("Memory deletion is unavailable."); await props.onDeleteAllMemories(); }); }}><IconTrash /></button></div>
            <div className="danger-row"><span>{t.deleteChat}</span><button className="icon-btn ghost-icon danger-icon" type="button" disabled={saving !== null} aria-label={t.deleteChat} onClick={() => void run("chats", props.onDeleteAllChats)}><IconTrash /></button></div>
          </div>}
          {error && <div className="settings-error" role="alert">{error}</div>}
        </main>
      </section>
    </div>
  );
}
