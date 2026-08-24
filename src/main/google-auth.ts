import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { shell } from "electron";
import Store from "electron-store";
import type { GoogleAccount } from "@shared/types";
import { databasePath, flushDb } from "./db";
import { getLegacyGoogleClientId } from "./store";
import { decryptLocalSecret, encryptLocalSecret } from "./local-secret";

declare const __LUMEN_GOOGLE_CLIENT_ID__: string;

type AuthDisk = {
  refreshTokenEnc: string;
  accessTokenEnc: string;
  expiresAt: number;
  name: string;
  email: string;
  picture: string;
  driveFileId: string;
  lastSyncedAt: number;
  clientId: string;
};

const authStore = new Store<AuthDisk>({
  name: "google-auth",
  defaults: {
    refreshTokenEnc: "",
    accessTokenEnc: "",
    expiresAt: 0,
    name: "",
    email: "",
    picture: "",
    driveFileId: "",
    lastSyncedAt: 0,
    clientId: ""
  }
});

let syncTimer: NodeJS.Timeout | null = null;
let syncInFlight: Promise<GoogleAccount> | null = null;
let suppressScheduledSync = false;
let activeLoginCancel: (() => void) | null = null;

function encrypt(value: string): string {
  return encryptLocalSecret(value);
}

function decrypt(value: string): string {
  return decryptLocalSecret(value);
}

function clientId(): string {
  return __LUMEN_GOOGLE_CLIENT_ID__ || process.env.LUMEN_GOOGLE_CLIENT_ID || getLegacyGoogleClientId();
}

function launchBrowser(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function openGoogleLogin(url: string): Promise<void> {
  try {
    if (process.platform === "darwin") {
      await launchBrowser("/usr/bin/open", ["-a", "Google Chrome", url]);
      return;
    }
    if (process.platform === "win32") {
      const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA];
      const chrome = roots
        .filter((root): root is string => Boolean(root))
        .map((root) => `${root}\\Google\\Chrome\\Application\\chrome.exe`)
        .find(existsSync);
      if (chrome) {
        await launchBrowser(chrome, [url]);
        return;
      }
    }
    if (process.platform === "linux") {
      for (const executable of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
        try {
          await launchBrowser(executable, [url]);
          return;
        } catch {
          // Try next common Chrome executable.
        }
      }
    }
  } catch {
    // Fall through when Chrome is not installed or cannot be launched.
  }
  await shell.openExternal(url);
}

export function googleStatus(error?: string): GoogleAccount {
  const connected =
    authStore.get("clientId") === clientId() &&
    Boolean(decrypt(authStore.get("refreshTokenEnc")) || decrypt(authStore.get("accessTokenEnc")));
  return {
    configured: Boolean(clientId()),
    connected,
    name: authStore.get("name") || undefined,
    email: authStore.get("email") || undefined,
    picture: authStore.get("picture") || undefined,
    lastSyncedAt: authStore.get("lastSyncedAt") || undefined,
    error
  };
}

async function tokenRequest(body: URLSearchParams): Promise<Record<string, any>> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const json = (await response.json()) as Record<string, any>;
  if (!response.ok) throw new Error(json.error_description || json.error || `Google token HTTP ${response.status}`);
  return json;
}

async function accessToken(): Promise<string> {
  const cached = decrypt(authStore.get("accessTokenEnc"));
  if (cached && authStore.get("expiresAt") > Date.now() + 60_000) return cached;
  const refresh = decrypt(authStore.get("refreshTokenEnc"));
  if (!refresh) throw new Error("Google sign-in expired. Sign in again.");
  let json: Record<string, any>;
  try {
    json = await tokenRequest(
      new URLSearchParams({
        client_id: clientId(),
        refresh_token: refresh,
        grant_type: "refresh_token"
      })
    );
  } catch (error) {
    authStore.set("accessTokenEnc", "");
    authStore.set("refreshTokenEnc", "");
    throw error;
  }
  const token = String(json.access_token || "");
  authStore.set("accessTokenEnc", encrypt(token));
  authStore.set("expiresAt", Date.now() + Number(json.expires_in || 3600) * 1000);
  return token;
}

export async function googleLogin(): Promise<GoogleAccount> {
  const id = clientId();
  if (!id) {
    return googleStatus("Google sign-in is unavailable in this build.");
  }
  if (authStore.get("clientId") && authStore.get("clientId") !== id) {
    authStore.clear();
  }
  activeLoginCancel?.();

  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("hex");

  const result = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      activeLoginCancel = null;
      server.close();
      operation();
    };
    const server = createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname !== "/oauth2/callback") {
        response.writeHead(404).end();
        return;
      }
      if (url.searchParams.get("state") !== state) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Invalid OAuth state.");
        finish(() => reject(new Error("Google OAuth state validation failed.")));
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Google sign-in was cancelled.");
        finish(() => reject(new Error(error || "Google sign-in was cancelled.")));
        return;
      }
      response
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end("<!doctype html><meta charset=utf-8><title>Lumen</title><body style='font:16px system-ui;padding:40px'>Google account connected. You can return to Lumen.</body>");
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      finish(() => resolve({ code, redirectUri: `http://127.0.0.1:${port}/oauth2/callback` }));
    });
    activeLoginCancel = () => finish(() => reject(new Error("Google sign-in was cancelled.")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.search = new URLSearchParams({
        client_id: id,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile https://www.googleapis.com/auth/drive.appdata",
        access_type: "offline",
        prompt: "select_account consent",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state
      }).toString();
      void openGoogleLogin(authUrl.toString()).catch((error) => {
        finish(() => reject(new Error(`Could not open Chrome: ${error instanceof Error ? error.message : String(error)}`)));
      });
    });
    const timeout = setTimeout(() => {
      finish(() => reject(new Error("Google sign-in timed out.")));
    }, 20_000);
    server.on("close", () => clearTimeout(timeout));
    server.on("error", (error) => finish(() => reject(error)));
  });

  const tokens = await tokenRequest(
    new URLSearchParams({
      client_id: id,
      code: result.code,
      code_verifier: verifier,
      redirect_uri: result.redirectUri,
      grant_type: "authorization_code"
    })
  );
  authStore.set("accessTokenEnc", encrypt(String(tokens.access_token || "")));
  if (tokens.refresh_token) authStore.set("refreshTokenEnc", encrypt(String(tokens.refresh_token)));
  authStore.set("expiresAt", Date.now() + Number(tokens.expires_in || 3600) * 1000);
  authStore.set("clientId", id);

  let profile: { name?: string; email?: string; picture?: string };
  try {
    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!profileResponse.ok) throw new Error(`Google profile HTTP ${profileResponse.status}`);
    profile = (await profileResponse.json()) as { name?: string; email?: string; picture?: string };
  } catch (error) {
    authStore.clear();
    throw error;
  }
  authStore.set("name", profile.name || "");
  authStore.set("email", profile.email || "");
  authStore.set("picture", profile.picture || "");
  return googleSync();
}

export function cancelGoogleLogin(): boolean {
  if (!activeLoginCancel) return false;
  activeLoginCancel();
  return true;
}

async function findDriveFile(token: string): Promise<string> {
  const known = authStore.get("driveFileId");
  if (known) return known;
  const query = new URL("https://www.googleapis.com/drive/v3/files");
  query.search = new URLSearchParams({
    spaces: "appDataFolder",
    q: "name = 'lumen-backup.sqlite' and trashed = false",
    fields: "files(id,name,modifiedTime)",
    pageSize: "1"
  }).toString();
  const response = await fetch(query, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Google Drive lookup HTTP ${response.status}`);
  const json = (await response.json()) as { files?: Array<{ id: string }> };
  const id = json.files?.[0]?.id || "";
  if (id) authStore.set("driveFileId", id);
  return id;
}

export function googleSync(): Promise<GoogleAccount> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    try {
      suppressScheduledSync = true;
      flushDb();
      suppressScheduledSync = false;
      const token = await accessToken();
      const bytes = readFileSync(databasePath());
      const fileId = await findDriveFile(token);
      let response: Response;
      if (fileId) {
        response = await fetch(
          `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/x-sqlite3"
            },
            body: bytes
          }
        );
      } else {
        const boundary = `lumen-${randomBytes(12).toString("hex")}`;
        const metadata = JSON.stringify({ name: "lumen-backup.sqlite", parents: ["appDataFolder"] });
        const prefix = Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
            `--${boundary}\r\nContent-Type: application/x-sqlite3\r\n\r\n`
        );
        const suffix = Buffer.from(`\r\n--${boundary}--`);
        response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": `multipart/related; boundary=${boundary}`
          },
          body: Buffer.concat([prefix, bytes, suffix])
        });
      }
      const json = (await response.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
      if (!response.ok) throw new Error(json.error?.message || `Google Drive upload HTTP ${response.status}`);
      if (json.id) authStore.set("driveFileId", json.id);
      authStore.set("lastSyncedAt", Date.now());
      return googleStatus();
    } catch (error) {
      suppressScheduledSync = false;
      return googleStatus(error instanceof Error ? error.message : String(error));
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

export function scheduleGoogleSync(): void {
  if (suppressScheduledSync) return;
  if (!googleStatus().connected) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void googleSync(), 2500);
}

export function cancelGoogleSync(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
}

export async function googleLogout(): Promise<GoogleAccount> {
  cancelGoogleSync();
  const token = decrypt(authStore.get("accessTokenEnc"));
  if (token) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    }).catch(() => undefined);
  }
  authStore.clear();
  return googleStatus();
}
