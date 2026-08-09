// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { renderTaskActivitySummary, summarizeTaskActivity } from "./task-presentation";

beforeEach(() => {
  document.body.innerHTML = `<span id="activity-summary"></span>`;
});

describe("NovelAI task activity summary", () => {
  it("summarizes the newest successful task instead of an older failure", () => {
    const tasks = [
      { id: "new", status: "completed" as const, prompt: "new success", createdAt: "2026-08-09T12:01:00Z" },
      { id: "old", status: "failed" as const, prompt: "old failure", createdAt: "2026-08-09T12:00:00Z", error: "raw upstream error" },
    ];

    renderTaskActivitySummary(document.querySelector("#activity-summary") as HTMLElement, tasks);

    expect(document.querySelector("#activity-summary")?.textContent).toBe("最近完成 · new success");
    expect(document.querySelector("#activity-summary")?.textContent).not.toContain("raw upstream error");
    expect(document.querySelector("#activity-summary")?.classList.contains("is-error")).toBe(false);
  });

  it("uses a fixed failure summary and keeps the raw error out of the status bar", () => {
    const summary = summarizeTaskActivity([
      { id: "new", status: "failed", prompt: "portrait", createdAt: "2026-08-09T12:01:00Z", error: "HTTP 500: secret debug detail" },
    ]);

    expect(summary.text).toBe("生成失败 · 点击展开查看详情");
    expect(summary.text).not.toContain("HTTP 500");
    expect(summary.isError).toBe(true);
  });

  it("prioritizes active work and safely truncates a long prompt", () => {
    const prompt = "一".repeat(80);
    const summary = summarizeTaskActivity([
      { id: "latest", status: "completed", prompt: "done", createdAt: "2026-08-09T12:02:00Z" },
      { id: "running", status: "running", prompt, createdAt: "2026-08-09T12:01:00Z" },
    ]);

    expect(summary.text).toMatch(/^正在生成 · /);
    expect(Array.from(summary.text).length).toBeLessThanOrEqual(56);
    expect(summary.text.endsWith("…")).toBe(true);
  });
});
