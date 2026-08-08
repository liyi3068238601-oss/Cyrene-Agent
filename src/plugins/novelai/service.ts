import { BrowserWindow, dialog, safeStorage, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import type { PluginContext } from "../types";
import { NOVELAI } from "./channels";
import { getImageProvider, getProviderCapabilities, upscaleWithGateway } from "./providers";
import { compileVisualPrompt, getAgentCharacter, normalizeCharacters, normalizeOutfits, resolveDrawingCharacterId } from "./prompt-profile";
import { ImageTaskQueue, type ImageTask } from "./task-queue";
import type { CharacterComposition, DrawingSubject, ImageProviderKind, NovelAiConfig, VisualMode } from "./types";
export type { NovelAiConfig } from "./types";

let pluginContext: PluginContext | undefined;

function requireContext(): PluginContext {
  if (!pluginContext) throw new Error("NovelAI 插件尚未注册");
  return pluginContext;
}

/** 用主聊天模型做一次简单翻译调用（非流式），返回纯文本 */
async function translatePromptWithLLM(messages: Array<{ role: "system" | "user"; content: string }>): Promise<string> {
  const llm = requireContext().deps.llm;
  if (!llm) throw new Error("NovelAI 插件未获得 llm 权限");
  return llm.translateText(messages);
}

interface StoredConfig extends Omit<NovelAiConfig, "apiKey"> { encryptedApiKey?: string; apiKeyPlain?: string }

const defaults: NovelAiConfig = {
  providerMode: "novelai-gateway",
  gatewayUrl: "http://127.0.0.1:31555",
  apiKey: "",
  model: "nai-v4.5-full",
  defaultNegativePrompt: "lowres, bad anatomy, blurry, text, watermark",
  modelsPath: "/v1/models",
  generationPath: "/v1/images/generations",
  asyncResultPath: "/api/get_result/{id}",
  pollIntervalMs: 5000,
  characterName: "昔涟",
  characterBaseTags: "1girl, Cyrene (Honkai: Star Rail), pink hair, long hair, purple eyes",
  characterFixedTags: "detailed eyes, gentle expression",
  characterNegativeTags: "different character, wrong hair color, wrong eye color",
  photoStyleTags: "masterpiece, best quality, anime illustration, soft shading, candid composition",
  drawingStyleTags: "hand-drawn illustration, sketch, visible brush strokes, paper texture",
  wardrobeEnabled: true,
  activeOutfitId: "default",
  outfits: [{ id: "default", name: "默认服装", description: "昔涟的日常默认穿搭", tags: "white and purple dress, floral ornament" }],
  activeCharacterId:"cyrene",
  agentCharacterId:"cyrene",
  characters:[{id:"cyrene",name:"昔涟",source:"崩坏：星穹铁道",baseTags:"1girl, Cyrene (Honkai: Star Rail), pink hair, long hair, purple eyes",fixedTags:"detailed eyes, gentle expression",negativeTags:"different character, wrong hair color, wrong eye color",protected:true,activeOutfitId:"default",outfits:[{id:"default",name:"默认服装",description:"昔涟的日常默认穿搭",tags:"white and purple dress, floral ornament"}]}],
  outfitTemplates:[],
};

function rootDir(): string { return requireContext().storage.rootDir(); }
function outputDir(): string { return path.join(rootDir(), "images"); }
function assetsDir(): string { return path.join(rootDir(), "assets"); }
function ensureDirs(): void { fs.mkdirSync(outputDir(), { recursive: true }); fs.mkdirSync(assetsDir(), { recursive: true }); }
function cleanUrl(value: unknown): string {
  const url = String(value || defaults.gatewayUrl).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) throw new Error("Gateway 地址必须以 http:// 或 https:// 开头");
  return url;
}

export function loadNovelAiConfig(): NovelAiConfig {
  ensureDirs();
  try {
    const stored = requireContext().storage.get<StoredConfig>("config");
    if (!stored) return { ...defaults };
    let apiKey = stored.apiKeyPlain || "";
    if (stored.encryptedApiKey && safeStorage.isEncryptionAvailable()) {
      apiKey = safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, "base64"));
    }
    const legacyMode = String((stored as StoredConfig & { providerMode?: string }).providerMode || "novelai-gateway");
    const providerMode: ImageProviderKind = legacyMode === "openai-compatible" ? "openai-images" : legacyMode as ImageProviderKind;
    const merged = { ...defaults, ...stored, providerMode, apiKey, gatewayUrl: cleanUrl(stored.gatewayUrl) };
    merged.outfits = normalizeOutfits(stored.outfits ?? defaults.outfits);
    if (merged.activeOutfitId !== "__none__" && !merged.outfits.some((outfit) => outfit.id === merged.activeOutfitId)) merged.activeOutfitId = "__none__";
    merged.characters=normalizeCharacters(stored.characters);
    if(!merged.characters.length)merged.characters=normalizeCharacters([{id:"cyrene",name:merged.characterName||"昔涟",source:"崩坏：星穹铁道",baseTags:merged.characterBaseTags,fixedTags:merged.characterFixedTags,negativeTags:merged.characterNegativeTags,protected:true,activeOutfitId:merged.activeOutfitId,outfits:merged.outfits}]);
    merged.activeCharacterId=String(stored.activeCharacterId||merged.characters[0]?.id||"__none__");
    if(merged.activeCharacterId!=="__none__"&&!merged.characters.some((item)=>item.id===merged.activeCharacterId))merged.activeCharacterId="__none__";
    const requestedAgentId=String(stored.agentCharacterId||"").trim();
    merged.agentCharacterId=merged.characters.find((item)=>item.id===requestedAgentId)?.id||merged.characters.find((item)=>item.protected)?.id||merged.characters.find((item)=>item.id==="cyrene")?.id||"__none__";
    merged.outfitTemplates=normalizeOutfits(stored.outfitTemplates);
    return merged;
  } catch { return { ...defaults }; }
}

export function saveNovelAiConfig(raw: Partial<NovelAiConfig>): NovelAiConfig {
  const next = { ...loadNovelAiConfig(), ...raw, gatewayUrl: cleanUrl(raw.gatewayUrl) };
  const stored: StoredConfig = {
    providerMode: next.providerMode,
    gatewayUrl: next.gatewayUrl,
    model: String(next.model || defaults.model).trim(),
    defaultNegativePrompt: String(next.defaultNegativePrompt || "").trim(),
    modelsPath: String(next.modelsPath || defaults.modelsPath).trim(),
    generationPath: String(next.generationPath || defaults.generationPath).trim(),
    asyncResultPath: String(next.asyncResultPath || defaults.asyncResultPath).trim(),
    pollIntervalMs: Math.max(500, Math.min(30000, Number(next.pollIntervalMs) || defaults.pollIntervalMs)),
    characterName: String(next.characterName || defaults.characterName).trim(),
    characterBaseTags: String(next.characterBaseTags || "").trim(),
    characterFixedTags: String(next.characterFixedTags || "").trim(),
    characterNegativeTags: String(next.characterNegativeTags || "").trim(),
    photoStyleTags: String(next.photoStyleTags || "").trim(),
    drawingStyleTags: String(next.drawingStyleTags || "").trim(),
    wardrobeEnabled: next.wardrobeEnabled !== false,
    activeOutfitId: String(next.activeOutfitId || "").trim(),
    outfits: normalizeOutfits(next.outfits),
    activeCharacterId:String(next.activeCharacterId||"__none__"),
    agentCharacterId:String(next.agentCharacterId||next.characters.find((item)=>item.protected)?.id||"cyrene"),
    characters:normalizeCharacters(next.characters),
    outfitTemplates:normalizeOutfits(next.outfitTemplates),
  };
  if (next.apiKey) {
    if (safeStorage.isEncryptionAvailable()) stored.encryptedApiKey = safeStorage.encryptString(next.apiKey).toString("base64");
    else stored.apiKeyPlain = next.apiKey;
  }
  ensureDirs();
  requireContext().storage.set("config", stored);
  return next;
}

export async function listNovelAiModels(override?: Partial<NovelAiConfig>): Promise<string[]> {
  const config = { ...loadNovelAiConfig(), ...override };
  const models = await getImageProvider(config.providerMode).listModels(config);
  return models.filter((id) => !id.toLowerCase().includes("chat") && !id.toLowerCase().includes("tts"));
}

async function performNovelAiImage(raw: Record<string, unknown>, isCancelled: () => boolean = () => false): Promise<Record<string, unknown>> {
  const config = loadNovelAiConfig();
  const prompt = String(raw.prompt || "").trim();
  if (!prompt) throw new Error("请输入绘图提示词");
  const subjectValue=String(raw.subject||"current");
  const subject:DrawingSubject=["self","character","none","current"].includes(subjectValue)?subjectValue as DrawingSubject:"current";
  const resolvedCharacterId=resolveDrawingCharacterId(config,subject,raw.characterId===undefined?undefined:String(raw.characterId));
  if(subject==="self"&&!getAgentCharacter(config))throw new Error("尚未配置 Cyrene 的 Agent 本体角色档案");
  if(subject==="character"&&(resolvedCharacterId==="__none__"||!config.characters.some((item)=>item.id===resolvedCharacterId))){
    throw new Error(`未找到指定绘图角色。可用角色：${config.characters.map((item)=>`${item.name}(${item.id})`).join("、")||"无"}`);
  }
  const width = Math.max(64, Math.min(1600, Number(raw.width) || 1024));
  const height = Math.max(64, Math.min(1600, Number(raw.height) || 1024));
  const negativePrompt = String(raw.negativePrompt || config.defaultNegativePrompt || "");
  const model = String(raw.model || config.model);
  const mode: VisualMode = raw.mode === "drawing" ? "drawing" : "photo";
  const provider = getImageProvider(config.providerMode);
  const characters:CharacterComposition[]=Array.isArray(raw.characters)?raw.characters.slice(0,6).flatMap((entry,index)=>{if(!entry||typeof entry!=="object")return[];const item=entry as Record<string,unknown>;const characterPrompt=String(item.prompt||"").trim();if(!characterPrompt)return[];const x=Number(item.x),y=Number(item.y);return[{id:String(item.id||`character-${index+1}`),name:String(item.name||`角色 ${index+1}`),prompt:characterPrompt,negativePrompt:String(item.negativePrompt||""),x:Math.max(0,Math.min(1,Number.isFinite(x)?x:0.5)),y:Math.max(0,Math.min(1,Number.isFinite(y)?y:0.5))}]}):[];
  const fallbackCharacters=!provider.capabilities.multiCharacter&&characters.length?`, ${characters.map((item)=>`${item.name}: ${item.prompt}, positioned at ${Math.round(item.x*100)}% from left and ${Math.round(item.y*100)}% from top`).join(", ")}`:"";
  const compiled = compileVisualPrompt(config, prompt+fallbackCharacters, negativePrompt, mode, raw.outfitId===undefined?undefined:String(raw.outfitId),resolvedCharacterId);
  const inlineReferenceImages = Array.isArray(raw.referenceImages) ? raw.referenceImages.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const image = String(item.image || "").replace(/^data:image\/[^;]+;base64,/, "");
    return image ? [{ image, strength: Math.max(0, Math.min(1, Number(item.strength) || 0.7)), informationExtracted: Math.max(0, Math.min(1, Number(item.informationExtracted) || 1)) }] : [];
  }) : [];
  const requestedAssetIds=Array.isArray(raw.referenceAssetIds)?raw.referenceAssetIds.map((id)=>String(id||"").trim()).filter(Boolean).slice(0,4):[];
  const assetMap=new Map(loadAssetCatalog().map((asset)=>[asset.id,asset]));
  const missingAssetIds=requestedAssetIds.filter((id)=>!assetMap.has(id));
  if(missingAssetIds.length)throw new Error(`未找到参考素材：${missingAssetIds.join("、")}。请先调用 novelai_inspect_drawing_context 获取可用素材。`);
  const assetReferenceImages=requestedAssetIds.flatMap((id)=>{const asset=assetMap.get(id);if(!asset)return[];try{const image=fs.readFileSync(path.join(assetsDir(),path.basename(asset.file))).toString("base64");return[{image,strength:Math.max(0,Math.min(1,Number(raw.referenceStrength)||0.7)),informationExtracted:Math.max(0,Math.min(1,Number(raw.referenceInformationExtracted)||1))}]}catch{return[]}});
  const referenceImages=[...inlineReferenceImages,...assetReferenceImages];
  const referenceImage=String(raw.referenceImage||"").replace(/^data:image\/[^;]+;base64,/,"")||assetReferenceImages[0]?.image;
  const referenceModeValue=String(raw.referenceMode||"none");
  const referenceMode=["img2img","inpaint","outpaint","vibe","director-character","director-style","director-both"].includes(referenceModeValue)?referenceModeValue:"none";
  const requiredCapability=referenceMode==="img2img"?provider.capabilities.img2img:["inpaint","outpaint"].includes(referenceMode)?provider.capabilities.inpaint:referenceMode==="vibe"?provider.capabilities.vibe:referenceMode.startsWith("director-")?provider.capabilities.directorReference:true;
  if(!requiredCapability)throw new Error(`当前绘图供应商不支持 ${referenceMode} 参考模式。请调用 novelai_inspect_drawing_context 查看可用能力。`);
  if(referenceMode!=="none"&&!referenceImage&&!referenceImages.length)throw new Error(`${referenceMode} 参考模式需要 referenceAssetIds。请先从素材库选择参考图片。`);
  const result = await provider.generate(config, {
    prompt: compiled.prompt, negativePrompt: compiled.negativePrompt, model, width, height,
    steps: Math.max(1, Math.min(50, Number(raw.steps) || 28)),
    scale: Math.max(0, Math.min(10, Number(raw.scale) || 5)),
    sampler: String(raw.sampler || "k_euler_ancestral"),
    seed: Number.isFinite(Number(raw.seed)) && String(raw.seed).trim() ? Number(raw.seed) : -1,
    referenceMode: referenceMode as any,
    referenceImage: referenceImage || undefined,
    maskImage: String(raw.maskImage || "").replace(/^data:image\/[^;]+;base64,/, "") || undefined,
    referenceImages,
    referenceStrength: Math.max(0, Math.min(1, Number(raw.referenceStrength) || 0.7)),
    referenceInformationExtracted: Math.max(0, Math.min(1, Number(raw.referenceInformationExtracted) || 1)),
    characters,
  });
  if (isCancelled()) throw new Error("绘图任务已取消");
  ensureDirs();
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const ext = result.mimeType.includes("webp") ? "webp" : result.mimeType.includes("jpeg") ? "jpg" : "png";
  const imagePath = path.join(outputDir(), `${id}.${ext}`);
  fs.writeFileSync(imagePath, result.bytes);
  const meta = {
    id, prompt, compiledPrompt: compiled.prompt, negativePrompt: compiled.negativePrompt, subject,
    model, providerMode: config.providerMode, mode,
    characterId:compiled.character?.id||null,characterName:compiled.character?.name||null,
    outfitId: compiled.outfit?.id || null, outfitName: compiled.outfit?.name || null,
    referenceMode,
    referenceStrength: Number(raw.referenceStrength) || null,
    referenceInformationExtracted: Number(raw.referenceInformationExtracted) || null,
    characters,
    parentId: String(raw.parentId || "") || null,
    width, height,
    steps: Math.max(1, Math.min(50, Number(raw.steps) || 28)),
    scale: Math.max(0, Math.min(10, Number(raw.scale) || 5)),
    sampler: String(raw.sampler || "k_euler_ancestral"),
    seed: Number.isFinite(Number(raw.seed)) && String(raw.seed).trim() ? Number(raw.seed) : -1,
    createdAt: new Date().toISOString(), file: path.basename(imagePath), mimeType: result.mimeType,
  };
  fs.writeFileSync(path.join(outputDir(), `${id}.json`), JSON.stringify(meta, null, 2), "utf8");
  return { ...meta, dataUrl: `data:${result.mimeType};base64,${result.bytes.toString("base64")}` };
}

function broadcastTasks(tasks: ImageTask[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(
      `plugin:novelai:${NOVELAI.TASKS_CHANGED}`,
      tasks.map(({ input: _input, ...task }) => task),
    );
  }
}

const imageQueue = new ImageTaskQueue(performNovelAiImage, broadcastTasks);

export function generateNovelAiImage(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  return imageQueue.enqueue(raw);
}

function broadcastGeneratedImage(result: Record<string, unknown>): void {
  const payload = {
    id: result.id,
    prompt: result.prompt,
    model: result.model,
    width: result.width,
    height: result.height,
    dataUrl: result.dataUrl,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send("agui:event", { type: "CUSTOM", name: "cyrene.novelai-image", value: payload });
    } catch { /* window may be closing */ }
  }
}

function loadHistory(rawOffset:unknown=0,rawLimit:unknown=40): Record<string, unknown>[] {
  ensureDirs();
  const offset=Math.max(0,Number(rawOffset)||0),limit=Math.max(1,Math.min(100,Number(rawLimit)||40));
  return fs.readdirSync(outputDir()).filter((file) => file.endsWith(".json")).sort().reverse().slice(offset,offset+limit).flatMap((file) => {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(outputDir(), file), "utf8"));
      const bytes = fs.readFileSync(path.join(outputDir(), meta.file));
      return [{ ...meta, dataUrl: `data:${meta.mimeType || "image/png"};base64,${bytes.toString("base64")}` }];
    } catch { return []; }
  });
}

function loadImageById(rawId: unknown): Record<string, unknown> | null {
  const id = String(rawId || "");
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(outputDir(), `${id}.json`), "utf8"));
    const bytes = fs.readFileSync(path.join(outputDir(), path.basename(String(meta.file || ""))));
    return { ...meta, dataUrl: `data:${meta.mimeType || "image/png"};base64,${bytes.toString("base64")}` };
  } catch { return null; }
}
function updateHistoryMeta(rawId:unknown,rawPatch:unknown):Record<string,unknown>|null{const id=String(rawId||"");if(!/^[a-zA-Z0-9-]+$/.test(id))return null;try{const filePath=path.join(outputDir(),`${id}.json`);const meta=JSON.parse(fs.readFileSync(filePath,"utf8"));const patch=(rawPatch&&typeof rawPatch==="object"?rawPatch:{}) as Record<string,unknown>;if("favorite" in patch)meta.favorite=Boolean(patch.favorite);fs.writeFileSync(filePath,JSON.stringify(meta,null,2),"utf8");return meta}catch{return null}}
function deleteHistoryItem(rawId:unknown):boolean{const id=String(rawId||"");if(!/^[a-zA-Z0-9-]+$/.test(id))return false;try{const metaPath=path.join(outputDir(),`${id}.json`);const meta=JSON.parse(fs.readFileSync(metaPath,"utf8"));fs.unlinkSync(path.join(outputDir(),path.basename(String(meta.file))));fs.unlinkSync(metaPath);return true}catch{return false}}
async function upscaleImageById(rawId:unknown,rawScale:unknown):Promise<Record<string,unknown>>{const source=loadImageById(rawId);if(!source)throw new Error("未找到要放大的作品");const config=loadNovelAiConfig();if(config.providerMode!=="novelai-gateway")throw new Error("当前仅本地 NovelAI Gateway 支持高清放大");const scale=Number(rawScale)===2?2:4;const result=await upscaleWithGateway(config,String(source.dataUrl||"").replace(/^data:image\/[^;]+;base64,/,""),Number(source.width)||1024,Number(source.height)||1024,scale);ensureDirs();const id=`${Date.now()}-upscale-${Math.random().toString(16).slice(2,7)}`;const file=`${id}.png`;fs.writeFileSync(path.join(outputDir(),file),result.bytes);const meta={...source,id,file,mimeType:result.mimeType,width:(Number(source.width)||1024)*scale,height:(Number(source.height)||1024)*scale,createdAt:new Date().toISOString(),upscaledFrom:source.id,upscaleScale:scale};delete (meta as any).dataUrl;fs.writeFileSync(path.join(outputDir(),`${id}.json`),JSON.stringify(meta,null,2),"utf8");return{...meta,dataUrl:`data:${result.mimeType};base64,${result.bytes.toString("base64")}`}}

interface ImageAsset { id:string; name:string; file:string; mimeType:string; createdAt:string; category?:string; favorite?:boolean; dataUrl?:string }
function assetMetaPath(id:string):string{return path.join(assetsDir(),`${id}.json`)}
function loadAssetCatalog():ImageAsset[]{
  ensureDirs();
  return fs.readdirSync(assetsDir()).filter((file)=>file.endsWith(".json")).sort().reverse().flatMap((file)=>{
    try{return[JSON.parse(fs.readFileSync(path.join(assetsDir(),file),"utf8")) as ImageAsset]}catch{return[]}
  });
}
function loadAssets():ImageAsset[]{
  return loadAssetCatalog().flatMap((meta)=>{
    try{const bytes=fs.readFileSync(path.join(assetsDir(),path.basename(meta.file)));return[{...meta,dataUrl:`data:${meta.mimeType};base64,${bytes.toString("base64")}`}]}catch{return[]}
  });
}
function deleteAsset(rawId:unknown):boolean{
  const id=String(rawId||"");if(!/^[a-zA-Z0-9-]+$/.test(id))return false;
  try{const meta=JSON.parse(fs.readFileSync(assetMetaPath(id),"utf8")) as ImageAsset;fs.unlinkSync(path.join(assetsDir(),path.basename(meta.file)));fs.unlinkSync(assetMetaPath(id));return true}catch{return false}
}
function updateAsset(rawId:unknown,rawPatch:unknown):ImageAsset|null{const id=String(rawId||"");if(!/^[a-zA-Z0-9-]+$/.test(id))return null;try{const filePath=assetMetaPath(id);const meta=JSON.parse(fs.readFileSync(filePath,"utf8")) as ImageAsset;const patch=(rawPatch&&typeof rawPatch==="object"?rawPatch:{}) as Record<string,unknown>;if("name" in patch)meta.name=String(patch.name||meta.name).trim().slice(0,80)||meta.name;if("category" in patch&&["character","outfit","pose","style","other"].includes(String(patch.category)))meta.category=String(patch.category);if("favorite" in patch)meta.favorite=Boolean(patch.favorite);fs.writeFileSync(filePath,JSON.stringify(meta,null,2),"utf8");return meta}catch{return null}}
async function importAsset():Promise<ImageAsset|null>{
  ensureDirs();
  const picked=await dialog.showOpenDialog({properties:["openFile"],filters:[{name:"图片",extensions:["png","jpg","jpeg","webp"]}]});
  if(picked.canceled||!picked.filePaths[0])return null;
  const source=picked.filePaths[0];const ext=path.extname(source).toLowerCase();const id=`asset-${Date.now()}-${Math.random().toString(16).slice(2,7)}`;
  const mimeType=ext===".webp"?"image/webp":ext===".jpg"||ext===".jpeg"?"image/jpeg":"image/png";const file=`${id}${ext}`;fs.copyFileSync(source,path.join(assetsDir(),file));
  const meta:ImageAsset={id,name:path.basename(source,path.extname(source)),file,mimeType,createdAt:new Date().toISOString()};fs.writeFileSync(assetMetaPath(id),JSON.stringify(meta,null,2),"utf8");
  return{...meta,dataUrl:`data:${mimeType};base64,${fs.readFileSync(path.join(assetsDir(),file)).toString("base64")}`};
}

export function registerNovelAi(ctx: PluginContext): void {
  pluginContext = ctx;
  ctx.registerIpc(NOVELAI.LOAD_CONFIG, () => loadNovelAiConfig());
  ctx.registerIpc(NOVELAI.SAVE_CONFIG, (config) => saveNovelAiConfig(config || {}));
  ctx.registerIpc(NOVELAI.TEST, async (config) => {
    const merged = { ...loadNovelAiConfig(), ...(config || {}) };
    const provider = getImageProvider(merged.providerMode);
    await provider.test(merged);
    return { ok: true, capabilities: provider.capabilities };
  });
  ctx.registerIpc(NOVELAI.CAPABILITIES, (kind) => getProviderCapabilities(kind as ImageProviderKind));
  ctx.registerIpc(NOVELAI.MODELS, (config) => listNovelAiModels(config || undefined));
  ctx.registerIpc(NOVELAI.GENERATE, (input) => generateNovelAiImage((input || {}) as Record<string, unknown>));
  ctx.registerIpc(NOVELAI.TASKS, () => imageQueue.list().map(({ input: _input, ...task }) => task));
  ctx.registerIpc(NOVELAI.TASK_CANCEL, (id) => imageQueue.cancel(String(id || "")));
  ctx.registerIpc(NOVELAI.TASK_RETRY, (id) => imageQueue.retry(String(id || "")));
  ctx.registerIpc(NOVELAI.HISTORY, (offset, limit) => loadHistory(offset, limit));
  ctx.registerIpc(NOVELAI.GET_IMAGE, (id) => loadImageById(id));
  ctx.registerIpc(NOVELAI.OPEN_OUTPUT, () => shell.openPath(outputDir()));
  ctx.registerIpc(NOVELAI.PICK_IMAGE, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const bytes = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = ext === ".webp" ? "image/webp" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
    return { name: path.basename(filePath), dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` };
  });
  ctx.registerIpc(NOVELAI.ASSETS, () => loadAssets());
  ctx.registerIpc(NOVELAI.ASSET_IMPORT, () => importAsset());
  ctx.registerIpc(NOVELAI.ASSET_DELETE, (id) => deleteAsset(id));
  ctx.registerIpc(NOVELAI.UPSCALE, (id, scale) => upscaleImageById(id, scale));
  ctx.registerIpc(NOVELAI.ASSET_UPDATE, (id, patch) => updateAsset(id, patch));
  ctx.registerIpc(NOVELAI.HISTORY_UPDATE, (id, patch) => updateHistoryMeta(id, patch));
  ctx.registerIpc(NOVELAI.HISTORY_DELETE, (id) => deleteHistoryItem(id));
  ctx.registerIpc(NOVELAI.TRANSLATE_PROMPT, (messages) => {
    return translatePromptWithLLM(messages as Array<{ role: "system" | "user"; content: string }>);
  });

  ctx.registerTool({
  id: "novelai_inspect_drawing_context",
  name: "查看绘图上下文",
  description: "读取当前绘图工作台可用的角色档案、各角色衣柜、参考素材和供应商能力。需要选择角色、服装、参考图，或不确定当前绘图能力时先调用；返回内容不包含 API Key 和图片数据。",
  enabled: true,
  inputSchema: { type: "object", properties: {} },
  execute: async () => {
    const config=loadNovelAiConfig();
    const agentCharacter=getAgentCharacter(config);
    const capabilities=getProviderCapabilities(config.providerMode);
    const assets=loadAssetCatalog().slice(0,100).map(({dataUrl:_dataUrl,file:_file,...asset})=>asset);
    return JSON.stringify({
      identityRules:{
        selfSubject:"画 Cyrene/昔涟本人、自拍、她自己的照片时必须使用 subject=self；角色身份标签会由后端完整注入，不要手写或改写。",
        otherCharacter:"画其他角色时使用 subject=character 并提供 characterId；不要注入 Cyrene 标签。",
        noProfile:"画原创人物或不绑定档案时使用 subject=none。",
      },
      agentCharacter:agentCharacter?{id:agentCharacter.id,name:agentCharacter.name,source:agentCharacter.source,outfits:agentCharacter.outfits.map((outfit)=>({id:outfit.id,name:outfit.name,description:outfit.description})),activeOutfitId:agentCharacter.activeOutfitId}:null,
      studioSelection:config.activeCharacterId,
      characters:config.characters.map((character)=>({id:character.id,name:character.name,source:character.source,isAgentSelf:character.id===agentCharacter?.id,activeOutfitId:character.activeOutfitId,outfits:character.outfits.map((outfit)=>({id:outfit.id,name:outfit.name,description:outfit.description}))})),
      referenceAssets:assets.map((asset)=>({id:asset.id,name:asset.name,category:asset.category||"other",favorite:Boolean(asset.favorite)})),
      provider:{kind:config.providerMode,model:config.model,capabilities},
      limits:{count:[1,4],referenceAssets:4,width:[64,1600],height:[64,1600],steps:[1,50],scale:[0,10]},
    },null,2);
  },
});

  ctx.registerTool({
  id: "novelai_generate_image",
  name: "AI 绘图",
  description: "生成图片并直接分享到聊天。必须明确 subject：画 Cyrene/昔涟本人、自拍或她自己的照片一律用 self，后端会强制注入完整本体角色标签；画档案中的其他角色用 character；原创人物或不绑定角色用 none。需要角色、衣柜、素材 ID 或能力信息时先调用 novelai_inspect_drawing_context。",
  enabled: true,
  risk: "network",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "详细的英文 NovelAI 绘图提示词" },
      subject:{type:"string",enum:["self","character","none","current"],description:"绘图主体语义。self=Cyrene/昔涟本人并强制绑定本体档案；character=指定其他角色；none=不注入固定角色；current=明确沿用工作台选择。"},
      negativePrompt: { type: "string", description: "可选的负面提示词" },
      width: { type: "number", description: "宽度，默认 1024" },
      height: { type: "number", description: "高度，默认 1024" },
      model:{type:"string",description:"可选模型；留空使用工作台当前模型。"},
      steps:{type:"number",description:"采样步数，1 到 50，默认 28。"},
      scale:{type:"number",description:"提示词遵循强度，0 到 10，默认 5。"},
      sampler:{type:"string",description:"采样器；留空使用 k_euler_ancestral。"},
      seed:{type:"number",description:"可选随机种子；复现画面时使用。"},
      characterId:{type:"string",description:"subject=character 时必填的角色档案 ID；subject=self 时会被忽略并强制使用 Agent 本体。"},
      outfitId: { type: "string", description: "可选服装预设 ID；留空使用当前选择，传 __none__ 则不注入服装。" },
      characters: { type: "array", description: "可选的多角色构图，坐标范围 0 到 1。", items: { type: "object", properties: { name:{type:"string"}, prompt:{type:"string"}, negativePrompt:{type:"string"}, x:{type:"number"}, y:{type:"number"} }, required:["prompt","x","y"] } },
      referenceMode:{type:"string",enum:["none","img2img","vibe","director-character","director-style","director-both"],description:"参考素材用途。使用前通过 novelai_inspect_drawing_context 确认当前供应商支持。"},
      referenceAssetIds:{type:"array",description:"素材库中的参考图片 ID，最多 4 个。",items:{type:"string"}},
      referenceStrength:{type:"number",description:"参考强度，0 到 1，默认 0.7。"},
      referenceInformationExtracted:{type:"number",description:"参考图信息提取量，0 到 1，默认 1。"},
      count: { type: "number", description: "生成变体数量，1 到 8，默认 1。一次生成多张时所有图片会同时显示在聊天中。" },
    },
    required: ["prompt","subject"],
  },
  execute: async (args) => {
    const count=Math.max(1,Math.min(8,Number(args.count)||1));const results:Record<string,unknown>[]=[];
    for(let index=0;index<count;index++){const result=await generateNovelAiImage({...args,count:undefined,seed:args.seed===undefined?undefined:Number(args.seed)+index});results.push(result);broadcastGeneratedImage(result)}
    return [
      `[ok] 已生成 ${results.length} 张图片，并已直接显示在当前聊天中。`,
      "接下来请像真人在聊天里分享刚拍好或刚画好的图片一样，自然简短地说一句，请用户看看即可。",
      "不要提及文件名、保存路径、图片 ID、提示词、模型参数、NovelAI、绘图工作台或工具调用。",
    ].join("\n");
  },
});

  ctx.registerTool({
  id: "novelai_change_visual_outfit",
  name: "切换绘图穿搭",
  description: "切换后续绘图使用的角色服装预设。给 Cyrene/昔涟本人换装时使用 subject=self，避免修改工作台当前选中的其他角色；不知道服装 ID 时先调用 novelai_inspect_drawing_context。",
  enabled: true,
  inputSchema: {
    type: "object",
    properties: {
      subject:{type:"string",enum:["self","character","current"],description:"self=Cyrene/昔涟本人；character=指定角色；current=工作台当前角色。"},
      characterId:{type:"string",description:"角色档案 ID；留空使用当前绘图角色"},
      outfitId: { type: "string", description: "穿搭预设 ID" },
      outfitName: { type: "string", description: "不知道 ID 时可传穿搭名称" },
    },
  },
  execute: async (args) => {
    const config = loadNovelAiConfig();
    const subjectValue=String(args.subject||"current");
    const subject:DrawingSubject=["self","character","current"].includes(subjectValue)?subjectValue as DrawingSubject:"current";
    const characterId=resolveDrawingCharacterId(config,subject,args.characterId===undefined?undefined:String(args.characterId))||config.activeCharacterId;
    const character=config.characters.find((item)=>item.id===characterId);
    if(!character)return `[error] 当前没有可用绘图角色。请先选择角色；可用角色：${config.characters.map((item)=>`${item.name}(${item.id})`).join("、")||"无"}`;
    const id = String(args.outfitId || "").trim();
    const name = String(args.outfitName || "").trim().toLowerCase();
    const activeOutfitId=id==="__none__"||name==="未选择"?"__none__":character.outfits.find((item)=>item.id===id)?.id||character.outfits.find((item)=>item.name.toLowerCase().includes(name)&&name)?.id;
    if(!activeOutfitId)return `[error] 未找到 ${character.name} 的服装。可用服装：${character.outfits.map((item)=>`${item.name}(${item.id})`).join("、")||"无"}`;
    const characters=config.characters.map((item)=>item.id===character.id?{...item,activeOutfitId}:item);saveNovelAiConfig({...config,characters,activeCharacterId:character.id});
    if(activeOutfitId==="__none__")return `[ok] 已取消 ${character.name} 的服装选择。`;
    const outfit=character.outfits.find((item)=>item.id===activeOutfitId)!;return `[ok] 已为 ${character.name} 切换为“${outfit.name}”。后续绘图会使用：${outfit.tags}`;
  },
});

  ctx.registerTool({id:"novelai_change_drawing_character",name:"切换绘图角色",description:"切换后续 AI 绘图的画面主体；不会改变 Agent 自身身份。",enabled:true,inputSchema:{type:"object",properties:{characterId:{type:"string",description:"角色档案 ID，传 __none__ 不注入角色"},characterName:{type:"string",description:"角色名称"}}},execute:async(args)=>{const config=loadNovelAiConfig();const id=String(args.characterId||"").trim(),name=String(args.characterName||"").trim().toLowerCase();if(id==="__none__"||name==="不指定角色"){saveNovelAiConfig({...config,activeCharacterId:"__none__"});return"[ok] 后续绘图不注入固定角色。"}const character=config.characters.find((item)=>item.id===id)||config.characters.find((item)=>item.name.toLowerCase().includes(name)&&name);if(!character)return`[error] 未找到绘图角色。可用角色：${config.characters.map((item)=>`${item.name}(${item.id})`).join("、")||"无"}`;saveNovelAiConfig({...config,activeCharacterId:character.id});return`[ok] 后续绘图主体已切换为“${character.name}”。`}});

// ── 历史作品查阅工具 ──────────────────────────────────────

/** 轻量读取全部历史作品的元数据（不读图片字节，避免列表场景无谓 IO）。 */
function loadHistoryMeta(): Record<string, unknown>[] {
  ensureDirs();
  return fs.readdirSync(outputDir())
    .filter((file) => file.endsWith(".json"))
    .sort().reverse()
    .flatMap((file) => {
      try { return [JSON.parse(fs.readFileSync(path.join(outputDir(), file), "utf8")) as Record<string, unknown>]; }
      catch { return []; }
    });
}

/** 把完整 meta 压缩成适合塞进 LLM 上下文的摘要（长文本字段截断）。 */
function summarizeHistoryMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const pick = (k: string, max?: number): unknown => {
    const v = meta[k];
    if (v == null) return undefined;
    if (max && typeof v === "string") return v.slice(0, max);
    return v;
  };
  return {
    id: meta.id,
    prompt: pick("prompt"),
    compiledPrompt: pick("compiledPrompt", 280),
    negativePrompt: pick("negativePrompt", 160),
    subject: meta.subject,
    characterId: meta.characterId,
    characterName: meta.characterName,
    outfitId: meta.outfitId,
    outfitName: meta.outfitName,
    mode: meta.mode,
    model: meta.model,
    width: meta.width,
    height: meta.height,
    steps: meta.steps,
    scale: meta.scale,
    sampler: meta.sampler,
    seed: meta.seed,
    favorite: meta.favorite ?? false,
    createdAt: meta.createdAt,
    referenceMode: meta.referenceMode && meta.referenceMode !== "none" ? meta.referenceMode : undefined,
  };
}

  ctx.registerTool({
  id: "novelai_list_drawing_history",
  name: "查看绘图历史",
  description:
    "列出已生成的绘图历史作品，支持按关键词检索提示词/编译提示词/负面词/角色名/服装名，返回每张作品的 ID、提示词、编译后提示词（节选）、负面词、角色、服装、尺寸、采样参数与创建时间。\n\n" +
    "何时用：\n" +
    "- 用户问「我之前画过什么」「上次那张图」「找一张某某主题的」「看看历史作品」\n" +
    "- 需要按主题/角色/服装检索旧图\n" +
    "- 用户想复用某张图的参数或提示词（先列出拿到 ID，再看详情）\n\n" +
    "不要用于：\n" +
    "- 查看单张作品的完整参数和图片本身（那是 novelai_get_drawing_detail）\n" +
    "- 生成新图（那是 novelai_generate_image）\n\n" +
    "参数：query (可选，关键词，不区分大小写)，offset (可选，默认0)，limit (可选，默认10，最大40)，favoriteOnly (可选，只看收藏)。",
  enabled: true,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "检索关键词（不区分大小写），匹配提示词/编译提示词/负面词/角色名/服装名；留空则按时间倒序列出全部" },
      offset: { type: "number", description: "分页偏移，默认 0" },
      limit: { type: "number", description: "返回条数，默认 10，最大 40" },
      favoriteOnly: { type: "boolean", description: "是否只返回收藏作品，默认 false" },
    },
  },
  execute: async (args) => {
    const query = String(args.query || "").trim().toLowerCase();
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Math.min(40, Number(args.limit) || 10));
    const favoriteOnly = Boolean(args.favoriteOnly);
    const all = loadHistoryMeta();
    const filtered = all.filter((meta) => {
      if (favoriteOnly && !meta.favorite) return false;
      if (!query) return true;
      const haystack = [meta.prompt, meta.compiledPrompt, meta.negativePrompt, meta.characterName, meta.outfitName]
        .filter((v): v is string => typeof v === "string")
        .join(" \n ")
        .toLowerCase();
      return haystack.includes(query);
    });
    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit).map(summarizeHistoryMeta);
    if (page.length === 0) {
      return query
        ? `[空] 没有匹配「${args.query}」的历史作品。共 ${total} 张作品。`
        : `[空] 暂无绘图历史作品。`;
    }
    return JSON.stringify({ total, offset, limit, returned: page.length, items: page }, null, 2);
  },
});

  ctx.registerTool({
  id: "novelai_get_drawing_detail",
  name: "查看绘图作品详情",
  description:
    "按 ID 查看绘图作品的完整元数据（含完整提示词、编译后提示词、负面词、角色/服装、参考模式、全部采样参数与种子），并把图片直接显示到当前聊天里。支持一次查看多张：传 ids 数组可同时取出多张作品并全部显示在聊天中。\n\n" +
    "何时用：\n" +
    "- 用户想看某张历史图的完整 tag/提示词/参数\n" +
    "- 用户说「把那张图找出来给我看看」「看看这张图的提示词」「那张图用的什么种子」\n" +
    "- 用户想一次看多张图（传 ids 数组，最多 8 张）\n" +
    "- 需要复用某张图的完整参数重新生成\n\n" +
    "不要用于：\n" +
    "- 列出多张作品的摘要（那是 novelai_list_drawing_history，先列出拿到 ID 再看详情）\n" +
    "- 生成新图（那是 novelai_generate_image）\n\n" +
    "参数：id (单个作品 ID) 或 ids (多个作品 ID 数组，最多 8 个)。二选一，ids 优先。",
  enabled: true,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "单个作品 ID（与 ids 二选一）" },
      ids: { type: "array", items: { type: "string" }, description: "多个作品 ID 数组，最多 8 个（与 id 二选一，优先于 id）" },
    },
  },
  execute: async (args) => {
    // 收集 ID 列表：ids 优先，回退到单个 id
    const rawIds: string[] = Array.isArray(args.ids) && args.ids.length > 0
      ? args.ids.map(String)
      : (args.id ? [String(args.id)] : []);
    const ids = rawIds.map(s => s.trim()).filter(s => /^[a-zA-Z0-9-]+$/.test(s)).slice(0, 8);
    if (ids.length === 0) return "[错误] 未提供合法的作品 ID。请先调用 novelai_list_drawing_history 查看可用作品。";
    const found: Record<string, unknown>[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const image = loadImageById(id);
      if (image) {
        found.push(image);
        broadcastGeneratedImage(image);
      } else {
        missing.push(id);
      }
    }
    if (found.length === 0) {
      return `[错误] 未找到任何作品。请求的 ID：${ids.join("、")}。请先调用 novelai_list_drawing_history 查看可用作品。`;
    }
    const metas = found.map((image) => {
      const { dataUrl: _dataUrl, ...meta } = image;
      return meta;
    });
    const lines: string[] = [
      `已找到 ${found.length} 张作品${missing.length > 0 ? `（${missing.length} 张未找到：${missing.join("、")}）` : ""}并显示在聊天中。以下是完整参数：`,
      "```json",
      JSON.stringify(metas.length === 1 ? metas[0] : metas, null, 2),
      "```",
      "如需复用这些参数重新生成，可直接调用 novelai_generate_image 并传入对应字段。",
    ];
    return lines.join("\n");
  },
});
}

export function unregisterNovelAi(): void {
  pluginContext = undefined;
}
