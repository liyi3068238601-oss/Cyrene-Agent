// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { bindNovelAiUi, reportAssetSelection, reportAssetStatus, reportUtilityStatus, runAssetAction, setActivityDrawer, showNovelAiPage } from "./ui-state";

beforeEach(() => {
  document.body.innerHTML = `
    <button data-nai-route="create">创作</button>
    <button data-nai-route="library">素材库</button>
    <button data-nai-route="settings">设置</button>
    <button data-return-to-create>返回创作</button>
    <section data-nai-page="create"><h1 data-nai-page-title tabindex="-1">画布</h1><div id="status">创作状态保留</div></section>
    <section data-nai-page="library" hidden><h1 data-nai-page-title tabindex="-1">素材库</h1><div id="library-status" role="status" aria-live="polite"></div><details id="library-status-details" hidden><summary>查看技术详情</summary><pre id="library-status-technical"></pre></details></section>
    <section data-nai-page="settings" hidden><h1 data-nai-page-title tabindex="-1">设置</h1><div id="settings-status" role="status" aria-live="polite"></div><details id="settings-status-details" hidden><summary>查看技术详情</summary><pre id="settings-status-technical"></pre></details></section>
    <span id="connection-badge" class="badge ok">已连接</span>
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

  it("moves focus to the destination page title after route clicks", () => {
    bindNovelAiUi();
    (document.querySelector('[data-nai-route="settings"]') as HTMLButtonElement).click();
    expect(document.activeElement).toBe(document.querySelector('[data-nai-page="settings"] [data-nai-page-title]'));
    (document.querySelector("[data-return-to-create]") as HTMLButtonElement).click();
    expect(document.activeElement).toBe(document.querySelector('[data-nai-page="create"] [data-nai-page-title]'));
  });

  it("reports library and settings actions inside their visible pages without clearing create status", () => {
    showNovelAiPage("library");
    reportUtilityStatus("library", "角色档案已保存到本机。");
    expect(document.querySelector("#library-status")?.textContent).toBe("角色档案已保存到本机。");
    expect(document.querySelector("#library-status")?.closest("[hidden]")).toBeNull();
    expect(document.querySelector("#status")?.textContent).toBe("创作状态保留");

    showNovelAiPage("settings");
    reportUtilityStatus("settings", "连接测试失败，请检查服务地址和密钥。", true, new Error("ECONNREFUSED"));
    expect(document.querySelector("#settings-status")?.textContent).toContain("连接测试失败");
    expect(document.querySelector("#settings-status-details")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("#settings-status-details")?.hasAttribute("open")).toBe(false);
    expect(document.querySelector("#settings-status-technical")?.textContent).toContain("ECONNREFUSED");
    expect(document.querySelector("#connection-badge")?.textContent).toBe("设置失败");
    expect(document.querySelector("#connection-badge")?.classList.contains("ok")).toBe(false);
    expect(document.querySelector("#asset-status")?.textContent).toBe("");
    expect(document.querySelector("#status")?.textContent).toBe("创作状态保留");
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

  it("keeps asset selection feedback visible", () => {
    reportAssetSelection(1);
    expect(document.querySelector("#asset-status")?.textContent).toContain("已选择 1 张参考素材");

    reportAssetSelection(0);
    expect(document.querySelector("#asset-status")?.textContent).toBe("已清空参考素材。");
  });
});
