import { closeSync, openSync, readSync } from "node:fs";

const VALUE_SIZE: Partial<Record<number, number>> = {
  0: 1,
  1: 1,
  2: 2,
  3: 2,
  4: 4,
  5: 4,
  6: 4,
  7: 1,
  10: 8,
  11: 8,
  12: 8
};

class GgufReader {
  private offset = 0;
  private readonly fd: number;

  constructor(fd: number) {
    this.fd = fd;
  }

  read(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || length > 64 * 1024 * 1024) {
      throw new Error("Invalid GGUF metadata length.");
    }
    const out = Buffer.allocUnsafe(length);
    const bytes = readSync(this.fd, out, 0, length, this.offset);
    if (bytes !== length) throw new Error("Unexpected end of GGUF metadata.");
    this.offset += length;
    return out;
  }

  skip(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid GGUF metadata offset.");
    this.offset += length;
  }

  u32(): number {
    return this.read(4).readUInt32LE(0);
  }

  u64(): number {
    const value = this.read(8).readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("GGUF metadata value is too large.");
    return Number(value);
  }

  string(capture = true): string {
    const length = this.u64();
    if (!capture) {
      this.skip(length);
      return "";
    }
    return this.read(length).toString("utf8");
  }

  value(type: number, capture: boolean): string[] {
    if (type === 8) return [this.string(capture)].filter(Boolean);
    if (type === 9) {
      const itemType = this.u32();
      const count = this.u64();
      const values: string[] = [];
      for (let index = 0; index < count; index += 1) {
        values.push(...this.value(itemType, capture));
      }
      return values;
    }
    const size = VALUE_SIZE[type];
    if (!size) throw new Error(`Unsupported GGUF metadata type ${type}.`);
    this.skip(size);
    return [];
  }
}

export function readGgufTextMetadata(path: string): Record<string, string> {
  const fd = openSync(path, "r");
  try {
    const reader = new GgufReader(fd);
    if (reader.read(4).toString("ascii") !== "GGUF") return {};
    const version = reader.u32();
    if (version < 2 || version > 3) return {};
    reader.u64(); // tensor count
    const metadataCount = reader.u64();
    if (metadataCount > 100_000) return {};
    const wanted = new Set([
      "general.name",
      "general.basename",
      "general.url",
      "general.repo_url",
      "tokenizer.chat_template"
    ]);
    const metadata: Record<string, string> = {};
    for (let index = 0; index < metadataCount; index += 1) {
      const key = reader.string();
      const type = reader.u32();
      const capture = wanted.has(key) || key.startsWith("tokenizer.chat_template.");
      const values = reader.value(type, capture);
      if (capture && values.length) metadata[key] = values.join("\n");
    }
    return metadata;
  } catch {
    return {};
  } finally {
    closeSync(fd);
  }
}
