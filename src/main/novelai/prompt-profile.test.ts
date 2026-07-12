import { describe, expect, it } from "vitest";
import { compileVisualPrompt, normalizeOutfits } from "./prompt-profile";
import type { NovelAiConfig } from "./types";

const config = {
  defaultNegativePrompt: "bad hands, text",
  characterBaseTags: "1girl, pink hair",
  characterFixedTags: "purple eyes",
  characterNegativeTags: "wrong hair, text",
  photoStyleTags: "anime illustration",
  drawingStyleTags: "watercolor",
  wardrobeEnabled: true,
  activeOutfitId: "casual",
  outfits: [{ id: "casual", name: "日常", description: "", tags: "white dress", negativeTags: "school uniform" }],
} as NovelAiConfig;

describe("visual prompt profile", () => {
  it("uses one drawing flow and allows explicitly disabling outfit injection", () => {
    const photo = compileVisualPrompt(config, "by the sea", "blurry", "photo");
    expect(photo.prompt).toContain("pink hair");
    expect(photo.prompt).toContain("white dress");
    expect(photo.negativePrompt).toBe("bad hands, text, wrong hair, school uniform, blurry");

    const drawing = compileVisualPrompt(config, "a quiet lake", "", "drawing", "__none__");
    expect(drawing.prompt).toContain("anime illustration, 1girl, pink hair");
    expect(drawing.prompt).not.toContain("white dress");
  });

  it("normalizes invalid and duplicate outfit ids", () => {
    expect(normalizeOutfits([
      { id: "summer look", name: "夏日", tags: "sun dress" },
      { id: "summer look", name: "夏日二", tags: "hat" },
      { name: "缺失 tags" },
    ])).toEqual([
      { id: "summer-look", name: "夏日", description: "", tags: "sun dress", negativeTags: "" },
      { id: "summer-look-2", name: "夏日二", description: "", tags: "hat", negativeTags: "" },
    ]);
  });
});
