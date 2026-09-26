import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isHttpUrl(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value.startsWith("https://") || value.startsWith("http://"))
  );
}

export function loadJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

export function writeText(filePath: string, text: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, "utf-8");
}

export function dumpJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function fnmatch(name: string, pattern: string): boolean {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else if (char === "[") {
      let cls = "[";
      index += 1;
      if (pattern[index] === "!") {
        cls += "^";
        index += 1;
      }
      for (; index < pattern.length && pattern[index] !== "]"; index += 1) {
        const inner = pattern[index]!;
        cls += /[\\^\]]/.test(inner) ? `\\${inner}` : inner;
      }
      source += `${cls}]`;
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^(?:${source})$`, "s").test(name);
}
