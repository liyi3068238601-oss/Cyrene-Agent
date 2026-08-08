import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const instances: MockWindow[] = [];

  class MockWindow {
    destroyed = false;
    events = new Map<string, () => void>();
    focus = vi.fn();
    show = vi.fn();
    minimize = vi.fn();
    loadFile = vi.fn(async () => {});
    loadURL = vi.fn(async () => {});

    constructor(public options: Record<string, unknown>) {
      instances.push(this);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    once(event: string, callback: () => void): void {
      this.events.set(event, callback);
    }

    on(event: string, callback: () => void): void {
      this.events.set(event, callback);
    }

    close(): void {
      this.destroyed = true;
      this.events.get("closed")?.();
    }
  }

  return { BrowserWindow: MockWindow, instances };
});

vi.mock("electron", () => ({ BrowserWindow: electron.BrowserWindow }));

import {
  closeWorkbenchWindow,
  createWorkbenchWindow,
  minimizeWorkbenchWindow,
} from "./workbench";

describe("NovelAI 工作台窗口", () => {
  beforeEach(() => {
    electron.instances.length = 0;
  });

  it("重复打开时复用窗口，并支持最小化和关闭", () => {
    createWorkbenchWindow();
    createWorkbenchWindow();

    expect(electron.instances).toHaveLength(1);
    expect(electron.instances[0].focus).toHaveBeenCalledOnce();
    expect(electron.instances[0].loadFile).toHaveBeenCalledOnce();

    minimizeWorkbenchWindow();
    expect(electron.instances[0].minimize).toHaveBeenCalledOnce();

    closeWorkbenchWindow();
    expect(electron.instances[0].destroyed).toBe(true);
  });
});
