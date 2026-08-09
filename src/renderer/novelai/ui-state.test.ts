// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { bindNovelAiUi, reportAssetStatus, runAssetAction, setActivityDrawer, showNovelAiPage } from "./ui-state";

beforeEach(() => {
  document.body.innerHTML = `
    <button data-nai-route="create">创作</button>
    <button data-nai-route="library">素材库</button>
    <button data-nai-route="settings">设置</button>
    <button data-return-to-create>返回创作</button>
    <section data-nai-page="create"></section>
    <section data-nai-page="library" hidden></section>
    <section data-nai-page="settings" hidden></section>
    <button id="activity-toggle" aria-expanded="false"></button>
    <section id="activity-drawer" hidden></section>
    <div id="asset-status" class="asset-status" role="status" aria-live="polite"></div>
    <details id="asset-status-details" hidden><summary>查看技术详情</summary><pre id="asset-status-technical"></pre></details>`;
});

describe("NovelAI UI state", () => {
  it("shows exactly the requested page", () => {
    showNovelAiPage("library");
    expect(document.querySelector('[data-nai-page="create"]')?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector('[data-nai-page="library"]')?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector('[data-nai-route="library"]')?.classList.contains("is-active")).toBe(true);
  });

  it("returns to the same create node", () => {
    const create = document.querySelector('[data-nai-page="create"]');
    bindNovelAiUi();
    (document.querySelector('[data-nai-route="settings"]') as HTMLButtonElement).click();
    (document.querySelector("[data-return-to-create]") as HTMLButtonElement).click();
    expect(document.querySelector('[data-nai-page="create"]')).toBe(create);
    expect(create?.hasAttribute("hidden")).toBe(false);
  });

  it("synchronizes drawer visibility and aria-expanded", () => {
    setActivityDrawer(true);
    expect(document.querySelector("#activity-drawer")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("#activity-toggle")?.getAttribute("aria-expanded")).toBe("true");
    setActivityDrawer(false);
    expect(document.querySelector("#activity-drawer")?.hasAttribute("hidden")).toBe(true);
  });

  it("toggles the drawer through its bound button", () => {
    bindNovelAiUi();
    (document.querySelector("#activity-toggle") as HTMLButtonElement).click();
    expect(document.querySelector("#activity-drawer")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("#activity-toggle")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("captures a rejected asset action and renders its technical detail", async () => {
    const failure = new Error("asset IPC unavailable");
    await expect(runAssetAction(
      async () => { throw failure; },
      { errorMessage: "素材操作失败，仍可继续使用文字绘图。" },
    )).resolves.toBeUndefined();
    expect(document.querySelector("#asset-status")?.textContent).toBe("素材操作失败，仍可继续使用文字绘图。");
    expect(document.querySelector("#asset-status")?.classList.contains("is-error")).toBe(true);
    expect(document.querySelector("#asset-status-details")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("#asset-status-details")?.hasAttribute("open")).toBe(false);
    expect(document.querySelector("#asset-status-technical")?.textContent).toContain("asset IPC unavailable");
  });

  it("treats an asset IPC failure sentinel as a captured error", async () => {
    await expect(runAssetAction(
      async () => false,
      {
        errorMessage: "素材操作失败，仍可继续使用文字绘图。",
        isFailure: (result) => result === false,
        failureDetail: "素材删除未成功。",
      },
    )).resolves.toBeUndefined();
    expect(document.querySelector("#asset-status")?.textContent).toBe("素材操作失败，仍可继续使用文字绘图。");
    expect(document.querySelector("#asset-status-technical")?.textContent).toContain("素材删除未成功。");
  });

  it("clears a previous asset error after a successful refresh action", async () => {
    reportAssetStatus("旧素材错误", true, new Error("old"));
    await expect(runAssetAction(
      async () => ["asset"],
      { errorMessage: "参考素材加载失败，仍可继续使用文字绘图。", clearOnSuccess: true },
    )).resolves.toEqual(["asset"]);
    expect(document.querySelector("#asset-status")?.textContent).toBe("");
    expect(document.querySelector("#asset-status")?.classList.contains("is-error")).toBe(false);
    expect(document.querySelector("#asset-status-details")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector("#asset-status-technical")?.textContent).toBe("");
  });
});
