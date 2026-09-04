# 使用说明

按照步骤依次配置即可快速上手。

## 1. 运行 Lumen

### 从源码运行

安装 Node.js 22.12 或更高版本，克隆本仓库，然后执行 `npm ci` 和 `npm run dev`。

### 启动应用

启动 Lumen。应用本身不捆绑模型权重文件，需配合本地模型使用。

## 2. 安装与配置 llama-server

### 配置环境变量 PATH

安装当前版本的 [`llama-server`](https://github.com/ggml-org/llama.cpp) 并确保其位于系统的 `PATH` 环境变量中。

### 放置 GGUF 模型

将 `.gguf` 格式的模型文件放置在 `~/models` 目录下（Windows 路径为 `%USERPROFILE%\models`）。每个模型使用单独的文件夹。

### 视觉模型 (Vision)

如需使用视觉多模态大模型，请将投影文件 `mmproj*.gguf` 放置在与该视觉模型相同的文件夹中。

## 3. 启动本地路由引擎

### 自动启动

打开 Lumen，应用默认会自动启动本地模型路由服务。

### 手动启停

在应用设置：设置 (Settings) → 通用 (General) → 启动 / 重启 / 停止。

### 刷新模型列表

向 `~/models` 添加新模型文件后：设置 → 模型 (Models) → 刷新模型列表 (Model Refresh) 即可在模型选择器中看到新模型。

### 运行机制说明

Lumen 使用目录路由器（`--models-max 1` 模式）：所有放入的模型都会常驻注册，但仅有当前使用的模型加载进内存/显存，切换其他模型时自动卸载，显存零浪费。

## 4. 对话 (Chat)

### 对话面板

在左侧侧边栏切换到「对话」(Chat)。

### 发送消息

在顶部或输入栏选择模型。按回车 `Enter` 发送，`Shift+Enter` 换行。

### 附件与截图

点击输入栏左下角 `+` 号添加文件或文件夹（支持图片、PPTX、Word、Excel、PDF、代码等）。快捷截图发送：macOS 按 `⌘⇧S`，Windows 按 `Ctrl+Shift+S`。

## 5. 全网深度研究 (Web Research)

### 配置 Tavily 密钥

设置 → API 密钥 (API Key) → 添加 Tavily API 密钥。

### 启动全网研究

在输入框点击地球图标开启网络研究，然后发送问题。

### 研究流水线

流程：全网检索 → 精选 3–5 个相关来源 → 深度抓取正文 → 交叉多方核验 → 结构化综合报告。

### Firecrawl 爬虫引擎（可选）

设置 → 网络研究 → Firecrawl（支持自建服务，默认地址为 `http://127.0.0.1:3002`）。

## 6. Cowork 智能体与代码协作

### 安装 Claude CLI

确保系统中已安装 Claude CLI 工具（例如位于 `~/.local/bin/claude`）。

### 代码协作面板

侧边栏切换至「代码」(Code)。选择本地项目工作目录，直接向智能体指派任务。

### 智能体运行架构

Cowork 基于 Claude Agent SDK 驱动，并通过 Lumen 独创的本地模型桥接服务运行。

### 桥接服务 (Bridge)

首次运行会自动在本地启动桥接服务 `127.0.0.1:18086`；当检测到已有健康的匹配桥接实例时将自动复用。

## 7. 进阶功能与配置

### Google 云端备份

侧边栏底部账号菜单，支持 Google 账号静默备份 `lumen.sqlite` 数据库至云端应用私有存储。

### 插件与 Computer Use

设置 → 插件 (Plugins) / Computer Use：支持应用内置浏览器、本地网页预览、Chrome CDP 远程控制。

### 自定义提示词与模型风格

设置 → 自定义指令 (Instructions)。全局模型风格规则存储于 `~/.config/llama/LLAMA.md`。

## 8. 源码开发与构建

### 本地开发

```bash
npm ci
npm run dev
```
