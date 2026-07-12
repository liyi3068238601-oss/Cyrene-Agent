import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import { toolRegistry } from "../orchestrator/tool-registry";
import { getImageProvider, getProviderCapabilities } from "./providers";
import { compileVisualPrompt, normalizeOutfits } from "./prompt-profile";
import { ImageTaskQueue, type ImageTask } from "./task-queue";
import type { ImageProviderKind, NovelAiConfig, VisualMode } from "./types";
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
    if (!merged.outfits.some((outfit) => outfit.id === merged.activeOutfitId)) merged.activeOutfitId = merged.outfits[0]?.id || "";
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
  const compiled = compileVisualPrompt(config, prompt, negativePrompt, mode, String(raw.outfitId || ""));
  const provider = getImageProvider(config.providerMode);
  const result = await provider.generate(config, {
    prompt: compiled.prompt, negativePrompt: compiled.negativePrompt, model, width, height,
    steps: Math.max(1, Math.min(50, Number(raw.steps) || 28)),
    scale: Math.max(0, Math.min(10, Number(raw.scale) || 5)),
    sampler: String(raw.sampler || "k_euler_ancestral"),
    seed: Number.isFinite(Number(raw.seed)) && String(raw.seed).trim() ? Number(raw.seed) : -1,
    referenceMode: ["img2img", "vibe", "director-character", "director-style", "director-both"].includes(String(raw.referenceMode)) ? raw.referenceMode as any : "none",
    referenceImage: String(raw.referenceImage || "").replace(/^data:image\/[^;]+;base64,/, "") || undefined,
    referenceStrength: Math.max(0, Math.min(1, Number(raw.referenceStrength) || 0.7)),
    referenceInformationExtracted: Math.max(0, Math.min(1, Number(raw.referenceInformationExtracted) || 1)),
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
    outfitId: compiled.outfit?.id || null, outfitName: compiled.outfit?.name || null,
    referenceMode: String(raw.referenceMode || "none"),
    referenceStrength: Number(raw.referenceStrength) || null,
    referenceInformationExtracted: Number(raw.referenceInformationExtracted) || null,
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

function loadHistory(): Record<string, unknown>[] {
  ensureDirs();
  return fs.readdirSync(outputDir()).filter((file) => file.endsWith(".json")).sort().reverse().slice(0, 40).flatMap((file) => {
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

interface ImageAsset { id:string; name:string; file:string; mimeType:string; createdAt:string; dataUrl?:string }
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
  ipcMain.handle(IPC.NOVELAI_HISTORY, () => loadHistory());
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
}

toolRegistry.register({
  id: "generate_novelai_image",
  name: "AI 绘图",
  description: "使用绘图工作台当前配置的供应商生成一张图片。用户明确要求画图、生成插画或角色图时使用。提示词应具体描述主体、构图、服装、表情、光线和画风。",
  enabled: true,
  risk: "network",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "详细的英文 NovelAI 绘图提示词" },
      negativePrompt: { type: "string", description: "可选的负面提示词" },
      width: { type: "number", description: "宽度，默认 1024" },
      height: { type: "number", description: "高度，默认 1024" },
      mode: { type: "string", enum: ["photo", "drawing"], description: "photo 会画当前角色并注入衣柜；drawing 是自由画作。默认 photo。" },
      outfitId: { type: "string", description: "可选穿搭预设 ID；留空使用当前穿搭。" },
    },
    required: ["prompt"],
  },
  execute: async (args) => {
    const result = await generateNovelAiImage(args);
    broadcastGeneratedImage(result);
    return `[ok] 图片已生成并保存到 NovelAI 绘图工作台。文件: ${result.file}; 提示词: ${result.prompt}`;
  },
});

toolRegistry.register({
  id: "change_visual_outfit",
  name: "切换绘图穿搭",
  description: "切换角色在后续 photo 模式绘图中使用的穿搭。仅选择已在绘图工作台衣柜中配置的预设。",
  enabled: true,
  inputSchema: {
    type: "object",
    properties: {
      outfitId: { type: "string", description: "穿搭预设 ID" },
      outfitName: { type: "string", description: "不知道 ID 时可传穿搭名称" },
    },
  },
  execute: async (args) => {
    const config = loadNovelAiConfig();
    const id = String(args.outfitId || "").trim();
    const name = String(args.outfitName || "").trim().toLowerCase();
    const outfit = config.outfits.find((item) => item.id === id) || config.outfits.find((item) => item.name.toLowerCase().includes(name) && name);
    if (!outfit) return `[error] 未找到穿搭。可用穿搭：${config.outfits.map((item) => `${item.name}(${item.id})`).join("、") || "无"}`;
    saveNovelAiConfig({ ...config, activeOutfitId: outfit.id });
    return `[ok] 已切换为“${outfit.name}”。后续 photo 模式绘图会使用：${outfit.tags}`;
  },
});
