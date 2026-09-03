import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const outputDir = mkdtempSync(path.join(os.tmpdir(), "lumen-routing-"));
try {
  execFileSync(
    path.join(process.cwd(), "node_modules", ".bin", "tsc"),
    [
      "src/shared/cowork-routing.ts",
      "--target", "ES2022",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "--outDir", outputDir,
      "--skipLibCheck"
    ],
    { cwd: process.cwd(), stdio: "pipe" }
  );
  const { isCoworkDirectConversation } = await import(
    pathToFileURL(path.join(outputDir, "cowork-routing.js"))
  );

  for (const prompt of [
    "能干什么呢兄弟",
    "聊聊你怎么看这个想法",
    "帮我写一封委婉的邮件",
    "Explain quantum mechanics simply",
    "修复这个项目的 bug",
    "打开 Chrome 点击 GitHub",
    "全网搜索 llama.cpp 官方仓库",
    "运行 npm test",
    "读取 /Users/me/project/index.ts"
  ]) {
    assert.equal(isCoworkDirectConversation(prompt), false, `Expected Cowork Agent: ${prompt}`);
  }
  assert.equal(isCoworkDirectConversation("继续", false, true), false);
  assert.equal(isCoworkDirectConversation("能干什么呢兄弟", false, true), false);
  assert.equal(isCoworkDirectConversation("聊聊你怎么看这个想法", false, true), false);
  assert.equal(isCoworkDirectConversation("解释这张图片", true), false);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    defaultRoute: "agent",
    directConversation: false,
    attachments: "agent",
    continuation: "agent"
  })}\n`);
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
