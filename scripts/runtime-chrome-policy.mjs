import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const outputDir = mkdtempSync(path.join(os.tmpdir(), "lumen-chrome-policy-"));
try {
  execFileSync(
    path.join(process.cwd(), "node_modules", ".bin", "tsc"),
    [
      "src/main/chrome-control-policy.ts",
      "--target", "ES2022",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "--outDir", outputDir,
      "--skipLibCheck"
    ],
    { cwd: process.cwd(), stdio: "pipe" }
  );
  const { selectChromeController } = await import(
    pathToFileURL(path.join(outputDir, "chrome-control-policy.js"))
  );

  assert.equal(selectChromeController({
    mode: "auto",
    extensionConnected: true,
    activeController: null,
    requireExisting: false
  }), "extension");
  assert.throws(() => selectChromeController({
    mode: "auto",
    extensionConnected: false,
    activeController: null,
    requireExisting: false
  }), /extension is not connected/);
  assert.equal(selectChromeController({
    mode: "isolated",
    extensionConnected: false,
    activeController: null,
    requireExisting: false
  }), "isolated");
  assert.throws(() => selectChromeController({
    mode: "auto",
    extensionConnected: false,
    activeController: "extension",
    requireExisting: true
  }), /disconnected from the active Chrome task/);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    extensionPreferred: true,
    missingExtensionFailsClosed: true,
    isolatedRequiresExplicitMode: true
  })}\n`);
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
