export interface TaskActivity {
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  prompt: string;
}

const PROMPT_SUMMARY_LENGTH = 48;

function truncatePrompt(prompt: string): string {
  const characters = Array.from(prompt.trim() || "未命名绘图");
  return characters.length <= PROMPT_SUMMARY_LENGTH
    ? characters.join("")
    : `${characters.slice(0, PROMPT_SUMMARY_LENGTH - 1).join("")}…`;
}

export function summarizeTaskActivity(tasks: readonly TaskActivity[]): { text: string; isError: boolean } {
  const active = tasks.find((task) => task.status === "running")
    || tasks.find((task) => task.status === "queued");
  if (active) {
    return {
      text: `${active.status === "running" ? "正在生成" : "等待生成"} · ${truncatePrompt(active.prompt)}`,
      isError: false,
    };
  }

  const latest = tasks[0];
  if (!latest) return { text: "暂无生成任务", isError: false };
  if (latest.status === "failed") return { text: "生成失败 · 点击展开查看详情", isError: true };
  if (latest.status === "cancelled") return { text: `最近任务已取消 · ${truncatePrompt(latest.prompt)}`, isError: false };
  return { text: `最近完成 · ${truncatePrompt(latest.prompt)}`, isError: false };
}

export function renderTaskActivitySummary(element: HTMLElement, tasks: readonly TaskActivity[]): void {
  const summary = summarizeTaskActivity(tasks);
  element.textContent = summary.text;
  element.classList.toggle("is-error", summary.isError);
}
