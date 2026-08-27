# Lumen

本地开源模型对话与 Cowork 智能体桌面应用。

## 下载

从 [GitHub Releases](https://github.com/5201200abc/lumen/releases/latest) 下载 macOS、Windows、Linux 的 x64 或 ARM64 构建。安装包由带注释的语义版本标签触发 CI 构建并发布。

发布新版本时，先同步 `package.json` 与 `package-lock.json`，再创建标签：

```bash
git tag -a 0.6.0 -m "Release 0.6.0"
git push origin main 0.6.0
```

CI 自动创建 GitHub Release、上传六种系统/架构构建及 `SHA256SUMS.txt`；无需再手工执行 `gh release create`。

## 开发

```bash
npm ci
npm run dev
```

## 本地模型

Lumen 不分发模型权重。安装当前版本的
[`llama-server`](https://github.com/ggml-org/llama.cpp) 并确保它位于 `PATH`，
然后把一个或多个 `.gguf` 文件放在以下默认目录：

- macOS / Linux：`~/models`
- Windows：`%USERPROFILE%\models`

应用会递归发现三层以内的 GGUF。每个模型应放在独立子目录；当前
`llama.cpp` 可用 router 模式一次对接整个目录；端口由 Lumen 从正在运行的
`llama-server` 监听器自动发现并持久化：

```bash
llama-server --models-dir ~/models --models-max 1 --host 127.0.0.1 --port <port>
```

`--models-max 1` 只限制同时驻留内存的模型数量，不是单模型服务；目录里的
全部模型仍由同一个永久 router 注册，并按每次请求的 `model` 自动卸载、
加载和切换，适合本机有限内存。

Lumen 启动时只维护 router 模式；若检测到旧的 `-m` 单模型服务，会在它的
真实监听端口替换为目录 router。General 可持久设置端口、自动启动，并直接
Start / Restart / Stop；若未配置且没有现有监听器，Lumen 自动保留一个可用
loopback 端口。日志与 PID 放在应用数据目录，`~/models` 只保存模型权重。
Model Configuration 中的“模型刷新”会重新扫描 `~/models` 并重启 router，
因此新下载的模型及其同目录 `mmproj*.gguf` 可立即出现并使用。默认运行参数为
16,384 tokens、单并行槽与 GPU offload。

Cowork 需要用户安装 Claude CLI。Lumen 安装包已包含本地
Anthropic-to-OpenAI bridge；首次运行 Cowork 时自动在 `127.0.0.1:18084`
启动。如果该端口已经有健康 bridge，Lumen 会保留现有进程，不会停止或替换。

## Deep Research

Chat 中的 **Research** 开关使用完整研究链路：

`模型 → Tavily Search → 筛选 3–5 个来源 → Tavily Extract → 交叉验证 → 报告`

Settings → Web Research 将 Tavily 标记为云端服务，并将 Firecrawl 限定为
可选自托管服务。默认链路直接共用一个 Tavily API 完成 Search + Extract；
Search 每轮最多返回 10 个候选页，模型挑选高价值 URL 后，Extract 单次可批量
处理最多 20 个 URL。Basic 更快；Advanced 更适合表格、嵌入内容和复杂页面。
Tavily Search 也支持 `include_raw_content`，但本项目采用官方建议的先筛选再
Extract，减少无效全文抓取。选择 Firecrawl 时只接受自托管 API 地址；安装包内
附带跨平台 lifecycle 脚本管理官方 Firecrawl `v2.11.0` checkout。
