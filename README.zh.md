# Lumen

[English](README.md) · [使用文档](https://5201200abc.github.io/lumen/guide.html)

本地开源模型驱动的桌面 Chat 与 Cowork 智能体。

## 1. 运行 Lumen

1. 安装 Node.js 22.12 或更高版本。
2. 克隆本仓库，执行 `npm ci`，再执行 `npm run dev`。
3. Lumen 不包含模型权重。

## 2. 安装 llama-server

1. 安装最新版 [`llama-server`](https://github.com/ggml-org/llama.cpp)，并加入 `PATH`。
2. 将 `.gguf` 放进 `~/models`；Windows 使用 `%USERPROFILE%\models`。每个模型一个目录，视觉模型的 `mmproj*.gguf` 放在同一目录。
3. 打开 Lumen；默认自动启动。也可在 Settings → General 手动启动。
4. 新增或删除模型后，在 Settings → Models 点击刷新。列表最多显示五个实际存在的模型。

Lumen 使用 `--models-max 1` 目录路由器：所有 GGUF 都可选，但内存中只加载当前模型。

## 3. Chat

选择模型后直接发送。Shift+Enter 换行；`+` 可添加文件和文件夹；`⌘⇧S` / `Ctrl+Shift+S` 主动截图。

## 4. 全网研究

1. 在 Settings → API Key 填写 Tavily Key。
2. 询问公开网页或时效信息时自动联网；地球按钮可强制任意问题联网。
3. 流程为多查询搜索、选择来源、提取正文、交叉验证和带来源报告。
4. 可选自托管 Firecrawl：Settings → Web Research，默认 `http://127.0.0.1:3002`。

## 5. Cowork

1. 进入 Cowork，选择工作目录并发送任务。
2. Cowork 使用 Claude Agent SDK 自带的当前平台原生运行时，无需另装 Claude CLI。
3. 首次运行会在 `127.0.0.1:18086` 启动本地模型桥接。
4. 可选的原始 Claude Code 终端需要 `claude` 位于 `PATH`。

## 6. 可选功能

- Google：将 `lumen.sqlite` 备份到 Drive 应用数据目录。
- Plugins / Computer use：内置浏览器、Sites 预览、插件管理及 Chrome CDP。
- 模型风格：`~/.config/llama/LLAMA.md`。

## 7. 开发

```bash
npm ci
npm run dev
```

## License

MIT License. See [LICENSE](./LICENSE) for details.
