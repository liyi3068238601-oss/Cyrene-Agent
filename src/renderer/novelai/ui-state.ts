export type NovelAiPage = "create" | "library" | "settings";

export function showNovelAiPage(page: NovelAiPage, root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-nai-page]").forEach((panel) => {
    panel.toggleAttribute("hidden", panel.dataset.naiPage !== page);
  });
  root.querySelectorAll<HTMLElement>("[data-nai-route]").forEach((button) => {
    const active = button.dataset.naiRoute === page;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

export function setActivityDrawer(open: boolean, root: ParentNode = document): void {
  const toggle = root.querySelector<HTMLButtonElement>("#activity-toggle");
  const drawer = root.querySelector<HTMLElement>("#activity-drawer");
  if (!toggle || !drawer) return;
  toggle.setAttribute("aria-expanded", String(open));
  drawer.toggleAttribute("hidden", !open);
}

export function reportAssetStatus(text: string, error = false, detail?: unknown, root: ParentNode = document): void {
  const status = root.querySelector<HTMLElement>("#asset-status");
  const details = root.querySelector<HTMLDetailsElement>("#asset-status-details");
  const technical = root.querySelector<HTMLPreElement>("#asset-status-technical");
  if (!status || !details || !technical) return;
  status.textContent = text;
  status.classList.toggle("is-error", error);
  technical.textContent = detail instanceof Error ? detail.stack || detail.message : detail ? String(detail) : "";
  details.hidden = !technical.textContent;
  if (details.hidden) details.open = false;
}

interface AssetActionOptions<T> {
  errorMessage: string;
  clearOnSuccess?: boolean;
  isFailure?: (result: T) => boolean;
  failureDetail?: string;
  root?: ParentNode;
}

export async function runAssetAction<T>(action: () => Promise<T>, options: AssetActionOptions<T>): Promise<T | undefined> {
  const root = options.root || document;
  try {
    const result = await action();
    if (options.isFailure?.(result)) throw new Error(options.failureDetail || options.errorMessage);
    if (options.clearOnSuccess) reportAssetStatus("", false, undefined, root);
    return result;
  } catch (error) {
    reportAssetStatus(options.errorMessage, true, error, root);
    return undefined;
  }
}

export function bindNovelAiUi(root: ParentNode = document): () => void {
  const cleanups: Array<() => void> = [];
  root.querySelectorAll<HTMLButtonElement>("[data-nai-route]").forEach((button) => {
    const click = () => showNovelAiPage(button.dataset.naiRoute as NovelAiPage, root);
    button.addEventListener("click", click);
    cleanups.push(() => button.removeEventListener("click", click));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-return-to-create]").forEach((button) => {
    const click = () => showNovelAiPage("create", root);
    button.addEventListener("click", click);
    cleanups.push(() => button.removeEventListener("click", click));
  });
  const toggle = root.querySelector<HTMLButtonElement>("#activity-toggle");
  if (toggle) {
    const click = () => setActivityDrawer(toggle.getAttribute("aria-expanded") !== "true", root);
    toggle.addEventListener("click", click);
    cleanups.push(() => toggle.removeEventListener("click", click));
  }
  showNovelAiPage("create", root);
  setActivityDrawer(false, root);
  return () => cleanups.forEach((cleanup) => cleanup());
}
