import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import { toolRegistry } from "../orchestrator/tool-registry";
import { getImageProvider, getProviderCapabilities, upscaleWithGateway } from "./providers";
import { compileVisualPrompt, normalizeCharacters, normalizeOutfits } from "./prompt-profile";
import { ImageTaskQueue, type ImageTask } from "./task-queue";
import type { CharacterComposition, ImageProviderKind, NovelAiConfig, VisualMode } from "./types";
export type { NovelAiConfig } from "./types";

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
  characters:[{id:"cyrene",name:"昔涟",source:"崩坏：星穹铁道",baseTags:"1girl, Cyrene (Honkai: Star Rail), pink hair, long hair, purple eyes",fixedTags:"detailed eyes, gentle expression",negativeTags:"different character, wrong hair color, wrong eye color",protected:true,activeOutfitId:"default",outfits:[{id:"default",name:"默认服装",description:"昔涟的日常默认穿搭",tags:"white and purple dress, floral ornament"}]}],
  outfitTemplates:[],
};

function rootDir(): string { return path.join(app.getPath("userData"), "novelai"); }
function configPath(): string { return path.join(rootDir(), "config.json"); }
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
    const stored = JSON.parse(fs.readFileSync(configPath(), "utf8")) as StoredConfig;
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
    characters:normalizeCharacters(next.characters),
    outfitTemplates:normalizeOutfits(next.outfitTemplates),
  };
  if (next.apiKey) {
    if (safeStorage.isEncryptionAvailable()) stored.encryptedApiKey = safeStorage.encryptString(next.apiKey).toString("base64");
    else stored.apiKeyPlain = next.apiKey;
  }
  ensureDirs();
  fs.writeFileSync(configPath(), JSON.stringify(stored, null, 2), "utf8");
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
  const width = Math.max(64, Math.min(1600, Number(raw.width) || 1024));
  const height = Math.max(64, Math.min(1600, Number(raw.height) || 1024));
  const negativePrompt = String(raw.negativePrompt || config.defaultNegativePrompt || "");
  const model = String(raw.model || config.model);
  const mode: VisualMode = raw.mode === "drawing" ? "drawing" : "photo";
  const provider = getImageProvider(config.providerMode);
  const characters:CharacterComposition[]=Array.isArray(raw.characters)?raw.characters.slice(0,6).flatMap((entry,index)=>{if(!entry||typeof entry!=="object")return[];const item=entry as Record<string,unknown>;const characterPrompt=String(item.prompt||"").trim();if(!characterPrompt)return[];const x=Number(item.x),y=Number(item.y);return[{id:String(item.id||`character-${index+1}`),name:String(item.name||`角色 ${index+1}`),prompt:characterPrompt,negativePrompt:String(item.negativePrompt||""),x:Math.max(0,Math.min(1,Number.isFinite(x)?x:0.5)),y:Math.max(0,Math.min(1,Number.isFinite(y)?y:0.5))}]}):[];
  const fallbackCharacters=!provider.capabilities.multiCharacter&&characters.length?`, ${characters.map((item)=>`${item.name}: ${item.prompt}, positioned at ${Math.round(item.x*100)}% from left and ${Math.round(item.y*100)}% from top`).join(", ")}`:"";
  const compiled = compileVisualPrompt(config, prompt+fallbackCharacters, negativePrompt, mode, raw.outfitId===undefined?undefined:String(raw.outfitId),raw.characterId===undefined?undefined:String(raw.characterId));
  const referenceImages = Array.isArray(raw.referenceImages) ? raw.referenceImages.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const image = String(item.image || "").replace(/^data:image\/[^;]+;base64,/, "");
    return image ? [{ image, strength: Math.max(0, Math.min(1, Number(item.strength) || 0.7)), informationExtracted: Math.max(0, Math.min(1, Number(item.informationExtracted) || 1)) }] : [];
  }) : [];
  const result = await provider.generate(config, {
    prompt: compiled.prompt, negativePrompt: compiled.negativePrompt, model, width, height,
    steps: Math.max(1, Math.min(50, Number(raw.steps) || 28)),
    scale: Math.max(0, Math.min(10, Number(raw.scale) || 5)),
    sampler: String(raw.sampler || "k_euler_ancestral"),
    seed: Number.isFinite(Number(raw.seed)) && String(raw.seed).trim() ? Number(raw.seed) : -1,
    referenceMode: ["img2img", "inpaint", "outpaint", "vibe", "director-character", "director-style", "director-both"].includes(String(raw.referenceMode)) ? raw.referenceMode as any : "none",
    referenceImage: String(raw.referenceImage || "").replace(/^data:image\/[^;]+;base64,/, "") || undefined,
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
    id, prompt, compiledPrompt: compiled.prompt, negativePrompt: compiled.negativePrompt,
    model, providerMode: config.providerMode, mode,
    characterId:compiled.character?.id||null,characterName:compiled.character?.name||null,
    outfitId: compiled.outfit?.id || null, outfitName: compiled.outfit?.name || null,
    referenceMode: String(raw.referenceMode || "none"),
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
    if (!win.isDestroyed()) win.webContents.send(IPC.NOVELAI_TASKS_CHANGED, tasks.map(({ input: _input, ...task }) => task));
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
      win.webContents.send(IPC.AGUI_EVENT, { type: "CUSTOM", name: "cyrene.novelai-image", value: payload });
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
function loadAssets():ImageAsset[]{
  ensureDirs();
  return fs.readdirSync(assetsDir()).filter((file)=>file.endsWith(".json")).sort().reverse().flatMap((file)=>{
    try{const meta=JSON.parse(fs.readFileSync(path.join(assetsDir(),file),"utf8")) as ImageAsset;const bytes=fs.readFileSync(path.join(assetsDir(),path.basename(meta.file)));return[{...meta,dataUrl:`data:${meta.mimeType};base64,${bytes.toString("base64")}`}]}catch{return[]}
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

export function registerNovelAiIpc(openWindow: () => void, minimizeWindow: () => void, closeWindow: () => void): void {
  ipcMain.on(IPC.NOVELAI_OPEN, openWindow);
  ipcMain.on(IPC.NOVELAI_MINIMIZE, minimizeWindow);
  ipcMain.on(IPC.NOVELAI_CLOSE, closeWindow);
  ipcMain.handle(IPC.NOVELAI_LOAD_CONFIG, () => loadNovelAiConfig());
  ipcMain.handle(IPC.NOVELAI_SAVE_CONFIG, (_event, config) => saveNovelAiConfig(config || {}));
  ipcMain.handle(IPC.NOVELAI_TEST, async (_event, config) => {
    const merged = { ...loadNovelAiConfig(), ...(config || {}) };
    const provider = getImageProvider(merged.providerMode);
    await provider.test(merged);
    return { ok: true, capabilities: provider.capabilities };
  });
  ipcMain.handle(IPC.NOVELAI_CAPABILITIES, (_event, kind: ImageProviderKind) => getProviderCapabilities(kind));
  ipcMain.handle(IPC.NOVELAI_MODELS, (_event, config) => listNovelAiModels(config || undefined));
  ipcMain.handle(IPC.NOVELAI_GENERATE, (_event, input) => generateNovelAiImage(input || {}));
  ipcMain.handle(IPC.NOVELAI_TASKS, () => imageQueue.list().map(({ input: _input, ...task }) => task));
  ipcMain.handle(IPC.NOVELAI_TASK_CANCEL, (_event, id) => imageQueue.cancel(String(id || "")));
  ipcMain.handle(IPC.NOVELAI_TASK_RETRY, async (_event, id) => imageQueue.retry(String(id || "")));
  ipcMain.handle(IPC.NOVELAI_HISTORY, (_event,offset,limit) => loadHistory(offset,limit));
  ipcMain.handle(IPC.NOVELAI_GET_IMAGE, (_event, id) => loadImageById(id));
  ipcMain.handle(IPC.NOVELAI_OPEN_OUTPUT, () => shell.openPath(outputDir()));
  ipcMain.handle(IPC.NOVELAI_PICK_IMAGE, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const bytes = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = ext === ".webp" ? "image/webp" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
    return { name: path.basename(filePath), dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` };
  });
  ipcMain.handle(IPC.NOVELAI_ASSETS, () => loadAssets());
  ipcMain.handle(IPC.NOVELAI_ASSET_IMPORT, () => importAsset());
  ipcMain.handle(IPC.NOVELAI_ASSET_DELETE, (_event, id) => deleteAsset(id));
  ipcMain.handle(IPC.NOVELAI_UPSCALE, (_event, id, scale) => upscaleImageById(id, scale));
  ipcMain.handle(IPC.NOVELAI_ASSET_UPDATE, (_event,id,patch) => updateAsset(id,patch));
  ipcMain.handle(IPC.NOVELAI_HISTORY_UPDATE, (_event,id,patch) => updateHistoryMeta(id,patch));
  ipcMain.handle(IPC.NOVELAI_HISTORY_DELETE, (_event,id) => deleteHistoryItem(id));
}

toolRegistry.register({
  id: "generate_novelai_image",
  name: "AI 绘图",
  description: "生成图片并直接作为聊天图片分享给用户。用户明确要求画图、生成插画、角色图或想看照片时使用。提示词应具体描述主体、构图、服装、表情、光线和画风；生成后用自然聊天口吻分享，不要向用户复述文件名、路径、图片 ID、模型参数或内部工作流。",
  enabled: true,
  risk: "network",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "详细的英文 NovelAI 绘图提示词" },
      negativePrompt: { type: "string", description: "可选的负面提示词" },
      width: { type: "number", description: "宽度，默认 1024" },
      height: { type: "number", description: "高度，默认 1024" },
      characterId:{type:"string",description:"绘图角色档案 ID；传 __none__ 不注入角色，留空使用工作台当前选择。"},
      outfitId: { type: "string", description: "可选服装预设 ID；留空使用当前选择，传 __none__ 则不注入服装。" },
      characters: { type: "array", description: "可选的多角色构图，坐标范围 0 到 1。", items: { type: "object", properties: { name:{type:"string"}, prompt:{type:"string"}, negativePrompt:{type:"string"}, x:{type:"number"}, y:{type:"number"} }, required:["prompt","x","y"] } },
      count: { type: "number", description: "生成变体数量，1 到 4，默认 1。" },
    },
    required: ["prompt"],
  },
  execute: async (args) => {
    const count=Math.max(1,Math.min(4,Number(args.count)||1));const results:Record<string,unknown>[]=[];
    for(let index=0;index<count;index++){const result=await generateNovelAiImage({...args,count:undefined,seed:args.seed===undefined?undefined:Number(args.seed)+index});results.push(result);broadcastGeneratedImage(result)}
    return [
      `[ok] 已生成 ${results.length} 张图片，并已直接显示在当前聊天中。`,
      "接下来请像真人在聊天里分享刚拍好或刚画好的图片一样，自然简短地说一句，请用户看看即可。",
      "不要提及文件名、保存路径、图片 ID、提示词、模型参数、NovelAI、绘图工作台或工具调用。",
    ].join("\n");
  },
});

toolRegistry.register({
  id: "change_visual_outfit",
  name: "切换绘图穿搭",
  description: "切换后续绘图使用的角色服装预设，也可以传 __none__ 取消服装注入。",
  enabled: true,
  inputSchema: {
    type: "object",
    properties: {
      characterId:{type:"string",description:"角色档案 ID；留空使用当前绘图角色"},
      outfitId: { type: "string", description: "穿搭预设 ID" },
      outfitName: { type: "string", description: "不知道 ID 时可传穿搭名称" },
    },
  },
  execute: async (args) => {
    const config = loadNovelAiConfig();
    const characterId=String(args.characterId||config.activeCharacterId||"");
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

toolRegistry.register({id:"change_drawing_character",name:"切换绘图角色",description:"切换后续 AI 绘图的画面主体；不会改变 Agent 自身身份。",enabled:true,inputSchema:{type:"object",properties:{characterId:{type:"string",description:"角色档案 ID，传 __none__ 不注入角色"},characterName:{type:"string",description:"角色名称"}}},execute:async(args)=>{const config=loadNovelAiConfig();const id=String(args.characterId||"").trim(),name=String(args.characterName||"").trim().toLowerCase();if(id==="__none__"||name==="不指定角色"){saveNovelAiConfig({...config,activeCharacterId:"__none__"});return"[ok] 后续绘图不注入固定角色。"}const character=config.characters.find((item)=>item.id===id)||config.characters.find((item)=>item.name.toLowerCase().includes(name)&&name);if(!character)return`[error] 未找到绘图角色。可用角色：${config.characters.map((item)=>`${item.name}(${item.id})`).join("、")||"无"}`;saveNovelAiConfig({...config,activeCharacterId:character.id});return`[ok] 后续绘图主体已切换为“${character.name}”。`}});
