// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindGenerationFlow } from "./generation-flow";

beforeEach(() => {
  document.body.innerHTML = `
    <button id="generate" type="button">开始绘制</button>
    <button id="load-result-params" type="button">使用当前设置再次绘制</button>
    <div id="status" role="status" aria-live="polite"></div>
    <details id="status-details" hidden><summary>查看技术详情</summary><pre id="status-technical"></pre></details>
    <button id="activity-toggle" aria-expanded="false"></button>
    <section id="activity-drawer" hidden></section>`;
});

describe("NovelAI generation flow", () => {
  it("loads the selected result before submitting another generation", async () => {
    const events: string[] = [];
    const selected = { id: "result-1" };
    document.querySelector("#status")?.classList.add("error");
    bindGenerationFlow({
      getSelectedResult: () => selected,
      loadResultParams: (result) => events.push(`load:${result.id}`),
      validateAndPrepare: async () => { events.push("validate"); },
      persistSettings: async () => { events.push("persist"); },
      generate: async () => { events.push("generate"); return "image"; },
      onGenerated: async (result) => { events.push(`complete:${result}`); },
    });

    (document.querySelector("#load-result-params") as HTMLButtonElement).click();

    await vi.waitFor(() => expect(events).toContain("complete:image"));
    expect(events).toEqual(["load:result-1", "validate", "persist", "generate", "complete:image"]);
    expect(document.querySelector("#status")?.classList.contains("error")).toBe(false);
  });

  it("keeps the task drawer collapsed when local validation rejects the request", async () => {
    const generate = vi.fn(async () => "image");
    bindGenerationFlow({
      getSelectedResult: () => null,
      loadResultParams: () => undefined,
      validateAndPrepare: async () => { throw new Error("请先选择参考图片"); },
      persistSettings: async () => undefined,
      generate,
      onGenerated: async () => undefined,
    });

    (document.querySelector("#generate") as HTMLButtonElement).click();

    await vi.waitFor(() => expect(document.querySelector("#status")?.textContent).toBe("请先选择参考图片"));
    expect(generate).not.toHaveBeenCalled();
    expect(document.querySelector("#activity-drawer")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector("#activity-toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("#status-details")?.hasAttribute("hidden")).toBe(true);
  });

  it("opens the drawer only when the generation request is rejected", async () => {
    bindGenerationFlow({
      getSelectedResult: () => null,
      loadResultParams: () => undefined,
      validateAndPrepare: async () => undefined,
      persistSettings: async () => undefined,
      generate: async () => { throw new Error("gateway refused request"); },
      onGenerated: async () => undefined,
    });

    (document.querySelector("#generate") as HTMLButtonElement).click();

    await vi.waitFor(() => expect(document.querySelector("#activity-drawer")?.hasAttribute("hidden")).toBe(false));
    expect(document.querySelector("#status")?.textContent).toContain("绘图提交失败");
    expect(document.querySelector("#status-technical")?.textContent).toContain("gateway refused request");
  });

  it("replaces an existing binding instead of submitting twice", async () => {
    const generate = vi.fn(async () => "image");
    const options = {
      getSelectedResult: () => null,
      loadResultParams: () => undefined,
      validateAndPrepare: async () => undefined,
      persistSettings: async () => undefined,
      generate,
      onGenerated: async () => undefined,
    };
    bindGenerationFlow(options);
    bindGenerationFlow(options);

    (document.querySelector("#generate") as HTMLButtonElement).click();

    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  });
});
