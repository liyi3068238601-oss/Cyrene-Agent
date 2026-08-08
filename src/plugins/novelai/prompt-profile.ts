import type { DrawingCharacterProfile, DrawingSubject, NovelAiConfig, OutfitPreset, VisualMode } from "./types";

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

export function getActiveCharacter(config:NovelAiConfig,requestedId?:string):DrawingCharacterProfile|null {
  const id=String(requestedId===undefined?config.activeCharacterId:requestedId).trim();
  if(id==="__none__")return null;
  return config.characters.find((character)=>character.id===id)||null;
}

export function getAgentCharacter(config: NovelAiConfig): DrawingCharacterProfile | null {
  const explicit = config.characters.find((character) => character.id === config.agentCharacterId);
  return explicit || config.characters.find((character) => character.protected) || config.characters.find((character) => character.id === "cyrene") || null;
}

export function resolveDrawingCharacterId(
  config: NovelAiConfig,
  subject: DrawingSubject = "current",
  requestedId?: string,
): string | undefined {
  if (subject === "self") return getAgentCharacter(config)?.id || "__none__";
  if (subject === "none") return "__none__";
  if (subject === "character") return String(requestedId || "").trim() || "__none__";
  return requestedId === undefined ? undefined : String(requestedId).trim();
}

export function getActiveOutfit(config: NovelAiConfig, requestedId?: string, character?:DrawingCharacterProfile|null): OutfitPreset | null {
  if (!config.wardrobeEnabled) return null;
  if (requestedId === "__none__") return null;
  const wardrobe=character?.outfits||config.outfits;
  const id = String(requestedId || character?.activeOutfitId || config.activeOutfitId || "").trim();
  return wardrobe.find((outfit) => outfit.id === id) || null;
}

export function compileVisualPrompt(
  config: NovelAiConfig,
  prompt: string,
  negativePrompt: string,
  _mode: VisualMode,
  outfitId?: string,
  characterId?:string,
): { prompt: string; negativePrompt: string; outfit: OutfitPreset | null; character:DrawingCharacterProfile|null } {
  const character=getActiveCharacter(config,characterId);
  const outfit = character ? getActiveOutfit(config, outfitId,character) : null;
  return {
    prompt: joinTags(config.photoStyleTags, character?.baseTags, character?.fixedTags, outfit?.tags, prompt),
    negativePrompt: joinTags(config.defaultNegativePrompt, character?.negativeTags, outfit?.negativeTags, negativePrompt),
    outfit,character,
  };
}

export function normalizeCharacters(value:unknown):DrawingCharacterProfile[]{
  if(!Array.isArray(value))return[];const used=new Set<string>();
  return value.flatMap((item,index)=>{if(!item||typeof item!=="object")return[];const raw=item as Record<string,unknown>;const name=String(raw.name||"").trim();if(!name)return[];let id=String(raw.id||`character-${index+1}`).trim().replace(/[^a-zA-Z0-9_-]/g,"-")||`character-${index+1}`;while(used.has(id))id+="-2";used.add(id);const outfits=normalizeOutfits(raw.outfits);const active=String(raw.activeOutfitId||"__none__");return[{id,name,source:String(raw.source||"").trim(),baseTags:String(raw.baseTags||"").trim(),fixedTags:String(raw.fixedTags||"").trim(),negativeTags:String(raw.negativeTags||"").trim(),protected:Boolean(raw.protected),activeOutfitId:active==="__none__"||outfits.some((outfit)=>outfit.id===active)?active:"__none__",outfits}]});
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
