// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { bindAssetCardSelection, syncAssetCardSelection, toggleReferenceAssetSelection } from "./asset-selection";
import { reportAssetSelection } from "./ui-state";

const first = { id: "asset-1", name: "角色一", dataUrl: "data:image/png;base64,one" };
const second = { id: "asset-2", name: "角色二", dataUrl: "data:image/png;base64,two" };

describe("NovelAI reference asset selection", () => {
  it("selects then clears the same asset in a default single-reference mode", () => {
    let selected = toggleReferenceAssetSelection([], first, "img2img");
    expect(selected.map((asset) => asset.id)).toEqual(["asset-1"]);

    selected = toggleReferenceAssetSelection(selected, first, "img2img");
    expect(selected).toEqual([]);
    document.body.innerHTML = `
      <div id="asset-status" role="status" aria-live="polite"></div>
      <details id="asset-status-details" hidden></details>
      <pre id="asset-status-technical"></pre>`;
    reportAssetSelection(selected.length);
    expect(document.querySelector("#asset-status")?.textContent).toBe("已清空参考素材。");
  });

  it("keeps multi-reference addition and cancellation behavior", () => {
    let selected = toggleReferenceAssetSelection([], first, "vibe");
    selected = toggleReferenceAssetSelection(selected, second, "vibe");
    expect(selected.map((asset) => asset.id)).toEqual(["asset-1", "asset-2"]);

    selected = toggleReferenceAssetSelection(selected, first, "vibe");
    expect(selected.map((asset) => asset.id)).toEqual(["asset-2"]);
  });

  function createBoundCard(activate: () => void): HTMLElement {
    document.body.innerHTML = `
      <article id="card">
        <img alt="角色一">
        <span>角色一</span>
        <select><option>角色</option></select>
        <button id="favorite">收藏</button>
        <button id="remove">删除</button>
      </article>`;
    const card = document.querySelector<HTMLElement>("#card")!;
    bindAssetCardSelection(card, activate);
    return card;
  }

  it("uses complete button and pressed-state semantics", () => {
    const card = createBoundCard(() => undefined);

    expect(card.getAttribute("role")).toBe("button");
    expect(card.tabIndex).toBe(0);
    syncAssetCardSelection(card, true);
    expect(card.getAttribute("aria-pressed")).toBe("true");
    expect(card.hasAttribute("aria-selected")).toBe(false);
    syncAssetCardSelection(card, false);
    expect(card.getAttribute("aria-pressed")).toBe("false");
  });

  it("prevents scrolling when Space activates the card itself", () => {
    let activations = 0;
    const card = createBoundCard(() => { activations += 1; });
    const cardSpace = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    card.dispatchEvent(cardSpace);
    expect(cardSpace.defaultPrevented).toBe(true);
    expect(activations).toBe(1);
  });

  it("ignores Enter, Space, and click bubbling from child controls", () => {
    let activations = 0;
    const card = createBoundCard(() => { activations += 1; });
    for (const child of card.querySelectorAll<HTMLElement>("button, select")) {
      child.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      const childSpace = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
      child.dispatchEvent(childSpace);
      expect(childSpace.defaultPrevented).toBe(false);
      child.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
    expect(activations).toBe(0);

    card.querySelector("span")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(activations).toBe(1);
  });
});
