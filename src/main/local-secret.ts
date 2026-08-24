import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";

const PREFIX = "lumen:v1:";
const key = createHash("sha256")
  .update(`Lumen local secrets\0${hostname()}\0${homedir()}`)
  .digest();

export function encryptLocalSecret(value: string): string {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, encrypted]).toString("base64")}`;
}

export function decryptLocalSecret(value: string): string {
  if (!value) return "";
  if (value.startsWith("plain:")) return value.slice(6);
  if (!value.startsWith(PREFIX)) return "";
  try {
    const payload = Buffer.from(value.slice(PREFIX.length), "base64");
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
