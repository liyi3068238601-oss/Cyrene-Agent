import type { NovelAiConfig, OutfitPreset, VisualMode } from "./types";

function joinTags(...values: Array<string | undefined>): string {
  const seen = new Set<string>();
  return values
    .flatMap((value) => String(value || "").split(","))
    .map((tag) => tag.trim())
    .filter((tag) => {
      const key = tag.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(", ");
}

export function getActiveOutfit(config: NovelAiConfig, requestedId?: string): OutfitPreset | null {
  if (!config.wardrobeEnabled) return null;
  if (requestedId === "__none__") return null;
  const id = String(requestedId || config.activeOutfitId || "").trim();
  return config.outfits.find((outfit) => outfit.id === id) || null;
}

export function compileVisualPrompt(
  config: NovelAiConfig,
  prompt: string,
  negativePrompt: string,
  _mode: VisualMode,
  outfitId?: string,
): { prompt: string; negativePrompt: string; outfit: OutfitPreset | null } {
  const outfit = getActiveOutfit(config, outfitId);
  return {
    prompt: joinTags(config.photoStyleTags, config.characterBaseTags, config.characterFixedTags, outfit?.tags, prompt),
    negativePrompt: joinTags(config.defaultNegativePrompt, config.characterNegativeTags, outfit?.negativeTags, negativePrompt),
    outfit,
  };
}

export function normalizeOutfits(value: unknown): OutfitPreset[] {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const name = String(raw.name || "").trim();
    const tags = String(raw.tags || "").trim();
    if (!name || !tags) return [];
    let id = String(raw.id || `outfit-${index + 1}`).trim().replace(/[^a-zA-Z0-9_-]/g, "-");
    if (!id) id = `outfit-${index + 1}`;
    while (used.has(id)) id += "-2";
    used.add(id);
    return [{ id, name, description: String(raw.description || "").trim(), tags, negativeTags: String(raw.negativeTags || "").trim() }];
  });
}
