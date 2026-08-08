import { describe, expect, it } from "vitest";
import { compileVisualPrompt, normalizeCharacters, normalizeOutfits, resolveDrawingCharacterId } from "./prompt-profile";
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
  activeCharacterId:"cyrene",
  agentCharacterId:"cyrene",
  characters:[{id:"cyrene",name:"昔涟",source:"",baseTags:"1girl, pink hair",fixedTags:"purple eyes",negativeTags:"wrong hair, text",activeOutfitId:"casual",outfits:[{id:"casual",name:"日常",description:"",tags:"white dress",negativeTags:"school uniform"}]}],
  outfitTemplates:[],
} as unknown as NovelAiConfig;

describe("visual prompt profile", () => {
  it("uses one drawing flow and allows explicitly disabling outfit injection", () => {
    const photo = compileVisualPrompt(config, "by the sea", "blurry", "photo");
    expect(photo.prompt).toContain("pink hair");
    expect(photo.prompt).toContain("white dress");
    expect(photo.negativePrompt).toBe("bad hands, text, wrong hair, school uniform, blurry");

    const drawing = compileVisualPrompt(config, "a quiet lake", "", "drawing", "__none__");
    expect(drawing.prompt).toContain("anime illustration, 1girl, pink hair");
    expect(drawing.prompt).not.toContain("white dress");

    const unspecified = compileVisualPrompt(config, "a silver-haired traveler", "", "photo", undefined, "__none__");
    expect(unspecified.prompt).toBe("anime illustration, a silver-haired traveler");
    expect(unspecified.prompt).not.toContain("pink hair");
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

  it("keeps wardrobes isolated while normalizing character profiles",()=>{
    const profiles=normalizeCharacters([{id:"hero",name:"角色甲",outfits:[{id:"casual",name:"便服",tags:"shirt"}],activeOutfitId:"casual"},{id:"hero",name:"角色乙",outfits:[{id:"casual",name:"便服",tags:"dress"}],activeOutfitId:"casual"}]);
    expect(profiles.map((item)=>item.id)).toEqual(["hero","hero-2"]);
    expect(profiles[0].outfits[0].tags).toBe("shirt");expect(profiles[1].outfits[0].tags).toBe("dress");
  });

  it("binds self portraits to the agent profile independently from the studio selection", () => {
    const otherActive = { ...config, activeCharacterId: "other", characters: [
      ...config.characters,
      { id: "other", name: "Other", source: "", baseTags: "silver hair", fixedTags: "", negativeTags: "", activeOutfitId: "__none__", outfits: [] },
    ] };
    expect(resolveDrawingCharacterId(otherActive, "self")).toBe("cyrene");
    expect(resolveDrawingCharacterId(otherActive, "none")).toBe("__none__");
    expect(resolveDrawingCharacterId(otherActive, "character", "other")).toBe("other");
    expect(resolveDrawingCharacterId(otherActive, "current")).toBeUndefined();

    const selfPrompt = compileVisualPrompt(otherActive, "at the beach", "", "photo", "__none__", resolveDrawingCharacterId(otherActive, "self"));
    expect(selfPrompt.prompt).toContain("pink hair");
    expect(selfPrompt.prompt).not.toContain("silver hair");

    const otherPrompt = compileVisualPrompt(otherActive, "at the beach", "", "photo", "__none__", resolveDrawingCharacterId(otherActive, "character", "other"));
    expect(otherPrompt.prompt).toContain("silver hair");
    expect(otherPrompt.prompt).not.toContain("pink hair");
  });
});
