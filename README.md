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
