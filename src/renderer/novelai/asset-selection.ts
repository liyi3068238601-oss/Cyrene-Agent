interface AssetIdentity { id: string }

export type SelectedReferenceAsset<T extends AssetIdentity> = T & {
  strength: number;
  informationExtracted: number;
};

export function toggleReferenceAssetSelection<T extends AssetIdentity>(
  selected: Array<SelectedReferenceAsset<T>>,
  asset: T,
  mode: string,
): Array<SelectedReferenceAsset<T>> {
  const next = [...selected];
  const multi = mode === "vibe" || mode.startsWith("director-");
  const exists = next.findIndex((item) => item.id === asset.id);
  if (exists >= 0) return next.filter((_, index) => index !== exists);
  const reference = { ...asset, strength: 0.7, informationExtracted: 1 };
  return multi ? [...next, reference] : [reference];
}

export function bindAssetCardSelection(card: HTMLElement, activate: () => void): void {
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  card.addEventListener("click", (event) => {
    const interactiveChild = (event.target as Element | null)?.closest?.("button, select, input, textarea, a[href]");
    if (interactiveChild && interactiveChild !== card) return;
    activate();
  });
  card.addEventListener("keydown", (event) => {
    if (event.target !== card || (event.key !== "Enter" && event.key !== " ")) return;
    if (event.key === " ") event.preventDefault();
    activate();
  });
}

export function syncAssetCardSelection(card: HTMLElement, selected: boolean): void {
  card.classList.toggle("is-selected", selected);
  card.setAttribute("aria-pressed", String(selected));
  card.removeAttribute("aria-selected");
}
