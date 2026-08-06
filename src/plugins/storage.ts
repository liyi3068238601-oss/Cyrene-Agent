import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PluginStorage } from "./types";

/** 每个 key 一个 JSON 文件：<rootDir>/<key>.json */
export function createPluginStorage(rootDir: string): PluginStorage {
  mkdirSync(rootDir, { recursive: true });
  const fileFor = (key: string): string => path.join(rootDir, `${key}.json`);
  return {
    get<T>(key: string): T | undefined {
      const p = fileFor(key);
      if (!existsSync(p)) return undefined;
      try {
        return JSON.parse(readFileSync(p, "utf8")) as T;
      } catch {
        return undefined;
      }
    },
    set<T>(key: string, value: T): void {
      writeFileSync(fileFor(key), JSON.stringify(value, null, 2), "utf8");
    },
    rootDir: () => rootDir,
  };
}
