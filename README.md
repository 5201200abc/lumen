# Lumen

本地开源模型对话与 Cowork 智能体桌面应用。

## 下载

从 [GitHub Releases](https://github.com/5201200abc/lumen/releases/latest) 下载 macOS、Windows、Linux 的 x64 或 ARM64 构建。安装包由带注释的语义版本标签触发 CI 构建并发布。

发布新版本时，先同步 `package.json`、`package-lock.json` 和 `docs/index.html` 中的版本，再创建标签：

```bash
git tag -a 0.3.0 -m "Release 0.3.0"
git push origin main 0.3.0
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

应用会递归发现三层以内的 GGUF，并使用随安装包提供的 macOS、Linux 或
Windows 启动脚本运行模型。默认配置为 16,384 tokens、单并行槽、GPU
offload，并且不会停止或替换已经在 `127.0.0.1:18082` 健康运行的服务。

也可以在 Settings → Models 中添加远程 OpenAI-compatible Llama endpoint；
远程 endpoint 不会触发任何本地进程。

Cowork 需要用户安装 Claude CLI。Lumen 安装包已包含本地
Anthropic-to-OpenAI bridge；首次运行 Cowork 时自动在 `127.0.0.1:18084`
启动。如果该端口已经有健康 bridge，Lumen 会保留现有进程，不会停止或替换。
