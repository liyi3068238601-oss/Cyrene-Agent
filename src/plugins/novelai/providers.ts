import type {
  ImageGenerationInput,
  ImageProvider,
  ImageProviderCapabilities,
  ImageProviderKind,
  NovelAiConfig,
  ProviderImageResult,
} from "./types";

const BASIC: ImageProviderCapabilities = {
  negativePrompt: false, dimensions: true, steps: false, scale: false,
  sampler: false, seed: false, img2img: false, inpaint:false, vibe: false,
  directorReference: false, multiCharacter: false,
};
const NAI: ImageProviderCapabilities = {
  negativePrompt: true, dimensions: true, steps: true, scale: true,
  sampler: true, seed: true, img2img: true, inpaint:true, vibe: true,
  directorReference: true, multiCharacter: true,
};
const GATEWAY: ImageProviderCapabilities = { ...NAI, directorReference: false };

function cleanBaseUrl(value: string): string {
  const url = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) throw new Error("接口地址必须以 http:// 或 https:// 开头");
  return url;
}

function endpoint(config: NovelAiConfig, pathname: string): string {
  if (/^https?:\/\//i.test(pathname)) return pathname;
  const base = cleanBaseUrl(config.gatewayUrl);
  if (base.toLowerCase().endsWith("/v1") && pathname.startsWith("/v1/")) return `${base}${pathname.slice(3)}`;
  return `${base}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
}

async function request(config: NovelAiConfig, pathname: string, init: RequestInit = {}, timeoutMs = 180000): Promise<Response> {
  const headers = new Headers(init.headers);
  if (config.apiKey) headers.set("Authorization", `Bearer ${config.apiKey}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(endpoint(config, pathname), { ...init, headers, signal: controller.signal }); }
  catch (error) {
    if ((error as Error).name === "AbortError") throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw error;
  } finally { clearTimeout(timer); }
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text();
  let message=text;
  try {
    const json = JSON.parse(text);
    message=json?.error?.message || json?.detail || json?.message || text;
  } catch { /* use raw text */ }
  return diagnoseImageError(response.status,String(message||`HTTP ${response.status}`));
}
export function diagnoseImageError(status:number,message:string):string{const lower=message.toLowerCase();const requestId=message.match(/request id[:：]?\s*([\w-]+)/i)?.[1];const suffix=requestId?`（请求 ID：${requestId}）`:"";if(status===401||status===403)return`API Key 无效、已过期或没有该模型权限。${suffix}`;if(status===429||lower.includes("rate limit"))return`请求过于频繁或中转站限流，请稍后重试。${suffix}`;if(lower.includes("model_not_found")||lower.includes("no available channel")||lower.includes("model not found"))return`当前分组没有可用的绘图模型通道。请检查模型名称、中转站分组和渠道映射。${suffix}`;if(lower.includes("balance")||lower.includes("insufficient")||lower.includes("quota"))return`账户余额或绘图额度不足，请检查中转站余额与 NovelAI 权限。${suffix}`;if(status===404)return`绘图端点不存在。请检查协议模板、Base URL 和生图路径是否匹配。${suffix}`;return`${message}${suffix&&!message.includes(requestId!)?suffix:""}`}

async function assertOk(response: Response): Promise<Response> {
  if (!response.ok) throw new Error(await responseError(response));
  return response;
}

async function downloadImage(config: NovelAiConfig, url: string): Promise<ProviderImageResult> {
  const absolute = /^https?:\/\//i.test(url) ? url : endpoint(config, url);
  const response = await assertOk(await fetch(absolute));
  return { bytes: Buffer.from(await response.arrayBuffer()), mimeType: response.headers.get("content-type") || "image/png" };
}

function decodeDataUrl(value: string): ProviderImageResult | null {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/s);
  return match ? { mimeType: match[1], bytes: Buffer.from(match[2], "base64") } : null;
}

async function parseJsonImage(config: NovelAiConfig, json: any): Promise<ProviderImageResult> {
  const candidate = json?.data?.[0] || json?.result || json;
  const b64 = candidate?.b64_json || candidate?.image_base64 || candidate?.base64 || json?.image_base64;
  if (typeof b64 === "string" && b64.trim()) return decodeDataUrl(b64) || { bytes: Buffer.from(b64, "base64"), mimeType: "image/png" };
  const url = candidate?.url || candidate?.image_url || json?.image_url;
  if (typeof url === "string" && url.trim()) return downloadImage(config, url.trim());
  throw new Error("接口成功返回，但没有找到图片 URL 或 Base64 数据");
}
export async function upscaleWithGateway(config:NovelAiConfig,image:string,width:number,height:number,scale:number):Promise<ProviderImageResult>{const response=await assertOk(await request(config,"/v1/images/upscale",{method:"POST",body:JSON.stringify({image,width,height,scale:scale===2?2:4})}));return{bytes:Buffer.from(await response.arrayBuffer()),mimeType:response.headers.get("content-type")||"image/png"}}

function extractTextImage(content: string): { url?: string; dataUrl?: string } {
  const data = content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=\r\n]+/)?.[0];
  if (data) return { dataUrl: data.replace(/\s/g, "") };
  const markdown = content.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i)?.[1];
  if (markdown) return { url: markdown };
  const plain = content.match(/https?:\/\/[^\s)"'<>]+/i)?.[0];
  return plain ? { url: plain } : {};
}

async function listOpenAiModels(config: NovelAiConfig): Promise<string[]> {
  const response = await assertOk(await request(config, config.modelsPath, {}, 12000));
  const json = await response.json() as { data?: Array<{ id?: string; type?: string }> };
  return (json.data || []).map((item) => String(item.id || "")).filter(Boolean);
}

class OpenAiImagesProvider implements ImageProvider {
  readonly kind: ImageProviderKind = "openai-images";
  readonly capabilities = BASIC;
  listModels = listOpenAiModels;
  async test(config: NovelAiConfig): Promise<void> { await listOpenAiModels(config); }
  async generate(config: NovelAiConfig, input: ImageGenerationInput): Promise<ProviderImageResult> {
    const response = await assertOk(await request(config, config.generationPath, {
      method: "POST",
      body: JSON.stringify({ prompt: input.prompt, model: input.model, size: `${input.width}x${input.height}`, n: 1, response_format: "b64_json" }),
    }));
    return parseJsonImage(config, await response.json());
  }
}

class GatewayProvider implements ImageProvider {
  readonly kind: ImageProviderKind = "novelai-gateway";
  readonly capabilities = GATEWAY;
  listModels = listOpenAiModels;
  async test(config: NovelAiConfig): Promise<void> { await listOpenAiModels(config); }
  async generate(config: NovelAiConfig, input: ImageGenerationInput): Promise<ProviderImageResult> {
    let generationPath = config.generationPath;
    const body: Record<string, unknown> = {
      prompt: input.prompt, negative_prompt: input.negativePrompt, model: input.model,
      width: input.width, height: input.height, steps: input.steps, scale: input.scale,
      sampler: input.sampler, seed: input.seed, n: 1, response_format: "b64_json",
    };
    if(input.characters?.length){const charCaptions=input.characters.map((item)=>({char_caption:item.prompt,centers:[{x:item.x,y:item.y}]}));body.characterPrompts=input.characters.map((item)=>({prompt:item.prompt,uc:item.negativePrompt,center:{x:item.x,y:item.y}}));body.use_coords=true;body.v4_prompt={caption:{base_caption:input.prompt,char_captions:charCaptions},use_coords:true,use_order:true};body.v4_negative_prompt={caption:{base_caption:input.negativePrompt,char_captions:input.characters.map((item)=>({char_caption:item.negativePrompt,centers:[{x:item.x,y:item.y}]}))},legacy_uc:false}}
    if(input.referenceImage&&input.maskImage&&["inpaint","outpaint"].includes(input.referenceMode)){
      generationPath="/v1/images/inpainting";body.image=input.referenceImage;body.mask=input.maskImage;body.strength=input.referenceStrength;
      if(!String(body.model).includes("inpaint"))body.model=String(body.model).replace(/-full$/,"-full-inpainting");
    } else if (input.referenceImage && input.referenceMode === "img2img") {
      generationPath = "/v1/images/img2img";
      body.image = input.referenceImage;
      body.strength = input.referenceStrength;
    } else if ((input.referenceImages?.length || input.referenceImage) && input.referenceMode === "vibe") {
      generationPath = "/v1/images/vibe-transfer";
      const references=input.referenceImages?.length?input.referenceImages:[{image:input.referenceImage!,strength:input.referenceStrength,informationExtracted:input.referenceInformationExtracted}];
      body.reference_images = references.map((item)=>item.image);
      body.reference_strengths = references.map((item)=>item.strength);
      body.reference_information_extracted_multiple = references.map((item)=>item.informationExtracted);
      body.reference_image = references[0].image;
      body.reference_strength = references[0].strength;
      body.reference_information_extracted = references[0].informationExtracted;
    }
    const response = await assertOk(await request(config, generationPath, {
      method: "POST", body: JSON.stringify({
        ...body,
      }),
    }));
    return parseJsonImage(config, await response.json());
  }
}

class ChatCompletionsImageProvider implements ImageProvider {
  readonly kind: ImageProviderKind = "chat-completions-image";
  readonly capabilities = { ...BASIC, negativePrompt: true, steps: true, scale: true, seed: true };
  listModels = listOpenAiModels;
  async test(config: NovelAiConfig): Promise<void> { await listOpenAiModels(config); }
  async generate(config: NovelAiConfig, input: ImageGenerationInput): Promise<ProviderImageResult> {
    const userPayload = JSON.stringify({
      prompt: input.prompt, negative_prompt: input.negativePrompt, size: `${input.width}x${input.height}`,
      steps: input.steps, scale: input.scale, seed: input.seed,
    });
    const response = await assertOk(await request(config, config.generationPath, {
      method: "POST", body: JSON.stringify({ model: input.model, stream: false, messages: [{ role: "user", content: userPayload }] }),
    }));
    const json = await response.json() as any;
    const content = String(json?.choices?.[0]?.message?.content || json?.content || "");
    const found = extractTextImage(content);
    if (found.dataUrl) return decodeDataUrl(found.dataUrl)!;
    if (found.url) return downloadImage(config, found.url);
    return parseJsonImage(config, json);
  }
}

class NovelAiNativeProvider implements ImageProvider {
  readonly kind: ImageProviderKind = "novelai-native";
  readonly capabilities = NAI;
  async listModels(): Promise<string[]> { return ["nai-diffusion-4-5-full", "nai-diffusion-4-5-curated", "nai-diffusion-4-full", "nai-diffusion-3"]; }
  async test(config: NovelAiConfig): Promise<void> {
    if (!config.apiKey) throw new Error("请填写 API Key");
    if (!config.generationPath.includes("generate-image")) throw new Error("NovelAI 原生端点通常应以 /ai/generate-image 结尾");
  }
  async generate(config: NovelAiConfig, input: ImageGenerationInput): Promise<ProviderImageResult> {
    const isV4 = input.model.includes("diffusion-4");
    const parameters: Record<string, unknown> = {
      width: input.width, height: input.height, scale: input.scale, steps: input.steps,
      sampler: input.sampler, seed: input.seed < 0 ? Math.floor(Math.random() * 10_000_000_000) : input.seed,
      n_samples: 1, negative_prompt: input.negativePrompt, noise_schedule: isV4 ? "karras" : "native",
      qualityToggle: true, ucPreset: 0, sm: false, sm_dyn: false,
    };
    if (isV4) Object.assign(parameters, {
      params_version: 3, cfg_rescale: 0, legacy: false, legacy_v3_extend: false, legacy_uc: false,
      add_original_image: true, controlnet_strength: 1, dynamic_thresholding: false,
      prefer_brownian: true, normalize_reference_strength_multiple: true, use_coords: false,
      inpaintImg2ImgStrength: 1, deliberate_euler_ancestral_bug: false, skip_cfg_above_sigma: null,
      characterPrompts: [], reference_image_multiple: [], reference_information_extracted_multiple: [], reference_strength_multiple: [],
      v4_prompt: { caption: { base_caption: input.prompt, char_captions: [] }, use_coords: false, use_order: true },
      v4_negative_prompt: { caption: { base_caption: input.negativePrompt, char_captions: [] }, legacy_uc: false },
    });
    if(isV4&&input.characters?.length){const captions=input.characters.map((item)=>({char_caption:item.prompt,centers:[{x:item.x,y:item.y}]}));parameters.characterPrompts=input.characters.map((item)=>({prompt:item.prompt,uc:item.negativePrompt,center:{x:item.x,y:item.y}}));parameters.use_coords=true;parameters.v4_prompt={caption:{base_caption:input.prompt,char_captions:captions},use_coords:true,use_order:true};parameters.v4_negative_prompt={caption:{base_caption:input.negativePrompt,char_captions:input.characters.map((item)=>({char_caption:item.negativePrompt,centers:[{x:item.x,y:item.y}]}))},legacy_uc:false}}
    if(input.referenceImage&&input.maskImage&&["inpaint","outpaint"].includes(input.referenceMode)){
      parameters.image=input.referenceImage;parameters.mask=input.maskImage;parameters.strength=input.referenceStrength;
    } else if (input.referenceImage && input.referenceMode === "img2img") {
      parameters.image = input.referenceImage;
      parameters.strength = input.referenceStrength;
    } else if ((input.referenceImages?.length || input.referenceImage) && input.referenceMode === "vibe") {
      const references=input.referenceImages?.length?input.referenceImages:[{image:input.referenceImage!,strength:input.referenceStrength,informationExtracted:input.referenceInformationExtracted}];
      parameters.reference_image_multiple = references.map((item)=>item.image);
      parameters.reference_strength_multiple = references.map((item)=>item.strength);
      parameters.reference_information_extracted_multiple = references.map((item)=>item.informationExtracted);
    } else if ((input.referenceImages?.length || input.referenceImage) && input.referenceMode.startsWith("director-")) {
      const type = input.referenceMode.replace("director-", "");
      const references=input.referenceImages?.length?input.referenceImages:[{image:input.referenceImage!,strength:input.referenceStrength,informationExtracted:input.referenceInformationExtracted}];
      parameters.director_reference_images = references.map((item)=>item.image);
      parameters.director_reference_information_extracted = references.map((item)=>item.informationExtracted);
      parameters.director_reference_strength_values = references.map((item)=>item.strength);
      parameters.director_reference_descriptions = references.map(()=>({ caption: { base_caption: input.prompt, char_captions: [] }, legacy_uc: false }));
      parameters.director_reference_secondary_strength_values = references.map((item)=>type === "both" ? item.strength : type === "style" ? 1 : 0);
    }
    const response = await assertOk(await request(config, config.generationPath, {
      method: "POST", headers: { Accept: "image/png, application/zip" },
      body: JSON.stringify({ input: input.prompt, model: ["inpaint","outpaint"].includes(input.referenceMode)&&!input.model.includes("inpaint")?`${input.model}-inpainting`:input.model, action: ["inpaint","outpaint"].includes(input.referenceMode)?"infill":"generate", parameters }),
    }));
    const contentType = response.headers.get("content-type") || "";
    const bytes = Buffer.from(await response.arrayBuffer());
    if (contentType.includes("image/")) return { bytes, mimeType: contentType.split(";")[0] };
    if (bytes.subarray(0, 2).toString("hex") === "504b") {
      const unzipper = require("unzipper") as { Open: { buffer(input: Buffer): Promise<{ files: Array<{ path: string; buffer(): Promise<Buffer> }> }> } };
      const archive = await unzipper.Open.buffer(bytes);
      const image = archive.files.find((file) => /\.(png|jpe?g|webp)$/i.test(file.path));
      if (!image) throw new Error("NovelAI 返回的 ZIP 中没有图片");
      return { bytes: await image.buffer(), mimeType: image.path.toLowerCase().endsWith(".webp") ? "image/webp" : "image/png" };
    }
    throw new Error("NovelAI 原生接口返回了未知格式");
  }
}

class AsyncTaskProvider implements ImageProvider {
  readonly kind: ImageProviderKind = "async-task";
  readonly capabilities = { ...BASIC, negativePrompt: true, steps: true, scale: true, seed: true };
  async listModels(config: NovelAiConfig): Promise<string[]> {
    try { return await listOpenAiModels(config); } catch { return config.model ? [config.model] : []; }
  }
  async test(config: NovelAiConfig): Promise<void> {
    if (!config.apiKey) throw new Error("请填写中转站 API Key");
    if (!config.asyncResultPath.includes("{id}")) throw new Error("轮询路径必须包含 {id}");
  }
  async generate(config: NovelAiConfig, input: ImageGenerationInput): Promise<ProviderImageResult> {
    const submit = await assertOk(await request(config, config.generationPath, {
      method: "POST", body: JSON.stringify({
        prompt: input.prompt, negative_prompt: input.negativePrompt, model: input.model,
        width: input.width, height: input.height, steps: input.steps, scale: input.scale, seed: input.seed,
      }),
    }));
    const submitted = await submit.json() as any;
    const id = String(submitted.job_id || submitted.task_id || submitted.id || "");
    if (!id) return parseJsonImage(config, submitted);
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(500, config.pollIntervalMs)));
      const response = await assertOk(await request(config, config.asyncResultPath.replace("{id}", encodeURIComponent(id)), {}, 15000));
      const result = await response.json() as any;
      const status = String(result.status || result.state || "").toLowerCase();
      if (["completed", "succeeded", "success", "done"].includes(status)) return parseJsonImage(config, result);
      if (["failed", "error", "cancelled"].includes(status)) throw new Error(result.error || result.message || "中转站生图任务失败");
    }
    throw new Error("等待中转站生图结果超时（180 秒）");
  }
}

const providers: Record<ImageProviderKind, ImageProvider> = {
  "novelai-gateway": new GatewayProvider(),
  "openai-images": new OpenAiImagesProvider(),
  "chat-completions-image": new ChatCompletionsImageProvider(),
  "novelai-native": new NovelAiNativeProvider(),
  "async-task": new AsyncTaskProvider(),
};

export function getImageProvider(kind: ImageProviderKind): ImageProvider { return providers[kind] || providers["novelai-gateway"]; }
export function getProviderCapabilities(kind: ImageProviderKind): ImageProviderCapabilities { return getImageProvider(kind).capabilities; }
