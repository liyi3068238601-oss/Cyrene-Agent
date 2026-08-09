import { bindNovelAiUi, runAssetAction, setActivityDrawer } from "./ui-state";

type ProviderKind = "novelai-gateway" | "openai-images" | "chat-completions-image" | "novelai-native" | "async-task";
interface Capabilities { negativePrompt:boolean; dimensions:boolean; steps:boolean; scale:boolean; sampler:boolean; seed:boolean; img2img:boolean; inpaint:boolean; vibe:boolean; directorReference:boolean; multiCharacter:boolean }
interface NovelAiResult { id:string; prompt:string; compiledPrompt?:string; model:string; providerMode?:ProviderKind; createdAt:string; dataUrl:string; width?:number; height?:number; steps?:number; scale?:number; sampler?:string; seed?:number; mode?:"photo"|"drawing"; characterId?:string|null; characterName?:string|null; outfitId?:string|null; outfitName?:string|null; negativePrompt?:string; referenceMode?:string; referenceStrength?:number|null; referenceInformationExtracted?:number|null; characters?:CharacterComposition[]; favorite?:boolean; upscaledFrom?:string }
interface OutfitPreset { id:string; name:string; description:string; tags:string; negativeTags?:string }
interface DrawingCharacterProfile { id:string; name:string; source:string; baseTags:string; fixedTags:string; negativeTags:string; protected?:boolean; activeOutfitId:string; outfits:OutfitPreset[] }
interface ImageTask { id:string; status:"queued"|"running"|"completed"|"failed"|"cancelled"; prompt:string; createdAt:string; error?:string; resultId?:string }
interface ImageAsset { id:string; name:string; dataUrl:string; createdAt:string; category?:string; favorite?:boolean }
interface CharacterComposition { id:string; name:string; prompt:string; negativePrompt:string; x:number; y:number }
interface NovelAiConfig {
  providerMode:ProviderKind; gatewayUrl:string; apiKey:string; model:string; defaultNegativePrompt:string;
  modelsPath:string; generationPath:string; asyncResultPath:string; pollIntervalMs:number;
  characterName:string; characterBaseTags:string; characterFixedTags:string; characterNegativeTags:string;
  photoStyleTags:string; drawingStyleTags:string; wardrobeEnabled:boolean; activeOutfitId:string; outfits:OutfitPreset[];
  activeCharacterId:string;characters:DrawingCharacterProfile[];outfitTemplates:OutfitPreset[];
}
declare global {
  interface Window {
    novelai: {
      minimize():void; close():void; loadConfig():Promise<NovelAiConfig>;
      saveConfig(config:Partial<NovelAiConfig>):Promise<NovelAiConfig>;
      test(config?:Partial<NovelAiConfig>):Promise<{ok:boolean;capabilities:Capabilities}>;
      models(config?:Partial<NovelAiConfig>):Promise<string[]>; capabilities(kind:ProviderKind):Promise<Capabilities>;
      generate(input:Record<string,unknown>):Promise<NovelAiResult>; history(offset?:number,limit?:number):Promise<NovelAiResult[]>; image(id:string):Promise<NovelAiResult|null>; openOutput():Promise<void>; pickImage():Promise<{name:string;dataUrl:string}|null>;
      tasks():Promise<ImageTask[]>;cancelTask(id:string):Promise<boolean>;retryTask(id:string):Promise<NovelAiResult>;onTasksChanged(cb:(tasks:ImageTask[])=>void):()=>void;
      assets():Promise<ImageAsset[]>;importAsset():Promise<ImageAsset|null>;deleteAsset(id:string):Promise<boolean>;
      upscale(id:string,scale:number):Promise<NovelAiResult>;
      translatePrompt(description:string):Promise<unknown>;
      updateAsset(id:string,patch:unknown):Promise<ImageAsset|null>;updateHistory(id:string,patch:unknown):Promise<unknown>;deleteHistory(id:string):Promise<boolean>;
    };
    cyreneTheme?: { get():Promise<string>; onChanged(cb:(theme:string)=>void):()=>void };
  }
}

const $ = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const promptDialog=(message:string,value:string)=>window.prompt(message,value);
const prompt = $<HTMLTextAreaElement>("prompt");
const negative = $<HTMLTextAreaElement>("negative");
const model = $<HTMLInputElement>("model");
const gateway = $<HTMLInputElement>("gateway-url");
const apiKey = $<HTMLInputElement>("api-key");
const providerMode = $<HTMLSelectElement>("provider-mode");
const status = $("status");
const badge = $("connection-badge");
const preview = $("preview");
const history = $("history");
let outfits:OutfitPreset[]=[];
let characterProfiles:DrawingCharacterProfile[]=[];let outfitTemplates:OutfitPreset[]=[];let activeCharacterId="__none__";
let currentCapabilities:Capabilities|null=null;
let referenceImageDataUrl="";
let referenceImages:Array<{id:string;name:string;dataUrl:string;strength:number;informationExtracted:number}>=[];
let selectedResult:NovelAiResult|null=null;
let taskRefreshTimer:number|undefined;
let maskImageDataUrl="";let maskDrawing=false;let maskErase=false;let maskHistory:ImageData[]=[];
let outpaintImageDataUrl="";let outpaintMaskDataUrl="";let outpaintWidth=0;let outpaintHeight=0;
let characters:CharacterComposition[]=[];
let allHistory:NovelAiResult[]=[];let allAssets:ImageAsset[]=[];
const HISTORY_PAGE_SIZE=40;let historyHasMore=true;let historyLoading=false;
let inspector={final:"",translated:"",outfit:""};let inspectorTab:"final"|"translated"|"outfit"="final";
const ASSET_LOAD_ERROR="参考素材加载失败，仍可继续使用文字绘图。";
const ASSET_ACTION_ERROR="素材操作失败，仍可继续使用文字绘图。";

const presets: Record<ProviderKind, Pick<NovelAiConfig,"gatewayUrl"|"modelsPath"|"generationPath"|"asyncResultPath">> = {
  "novelai-gateway": { gatewayUrl:"http://127.0.0.1:31555", modelsPath:"/v1/models", generationPath:"/v1/images/generations", asyncResultPath:"/api/get_result/{id}" },
  "openai-images": { gatewayUrl:"", modelsPath:"/v1/models", generationPath:"/v1/images/generations", asyncResultPath:"/api/get_result/{id}" },
  "chat-completions-image": { gatewayUrl:"", modelsPath:"/v1/models", generationPath:"/v1/chat/completions", asyncResultPath:"/api/get_result/{id}" },
  "novelai-native": { gatewayUrl:"https://image.novelai.net", modelsPath:"/v1/models", generationPath:"/ai/generate-image", asyncResultPath:"/api/get_result/{id}" },
  "async-task": { gatewayUrl:"", modelsPath:"/v1/models", generationPath:"/api/generate_image", asyncResultPath:"/api/get_result/{id}" },
};

function setStatus(text:string,error=false,detail?:unknown):void {
  status.textContent=text;status.classList.toggle("error",error);
  const details=$<HTMLDetailsElement>("status-details");const technical=$<HTMLPreElement>("status-technical");
  technical.textContent=detail instanceof Error?detail.stack||detail.message:detail?String(detail):"";
  details.hidden=!technical.textContent;if(details.hidden)details.open=false;
}
async function saveLocalConfig(buttonId:string,message:string):Promise<void>{const button=$<HTMLButtonElement>(buttonId);button.disabled=true;try{await window.novelai.saveConfig(configFromForm());setStatus(message)}catch(error){setStatus(error instanceof Error?error.message:String(error),true)}finally{button.disabled=false}}
function getKind():ProviderKind { return providerMode.value as ProviderKind; }
function configFromForm():Partial<NovelAiConfig> {
  syncProfileFromForm();const active=characterProfiles.find((item)=>item.id===activeCharacterId);
  return {
    providerMode:getKind(), gatewayUrl:gateway.value.trim(), apiKey:apiKey.value.trim(), model:model.value.trim(),
    defaultNegativePrompt:negative.value.trim(), modelsPath:$<HTMLInputElement>("models-path").value.trim(),
    generationPath:$<HTMLInputElement>("generation-path").value.trim(),
    asyncResultPath:$<HTMLInputElement>("async-result-path").value.trim(),
    pollIntervalMs:Number($<HTMLInputElement>("poll-interval").value) || 5000,
    photoStyleTags:$<HTMLTextAreaElement>("photo-style-tags").value.trim(),
    drawingStyleTags:$<HTMLTextAreaElement>("drawing-style-tags").value.trim(),
    wardrobeEnabled:$<HTMLInputElement>("wardrobe-enabled").checked,
    activeOutfitId:$<HTMLSelectElement>("outfit-select").value,outfits,
    activeCharacterId,characters:characterProfiles,outfitTemplates,
    characterName:active?.name||$<HTMLInputElement>("character-name").value.trim(),characterBaseTags:active?.baseTags||"",characterFixedTags:active?.fixedTags||"",characterNegativeTags:active?.negativeTags||"",
  };
}

function slug(value:string):string{return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g,"-").replace(/^-|-$/g,"")||`outfit-${Date.now()}`}
function activeProfile():DrawingCharacterProfile|undefined{return characterProfiles.find((item)=>item.id===activeCharacterId)}
function syncProfileFromForm():void{const profile=activeProfile();if(!profile)return;profile.name=$<HTMLInputElement>("character-name").value.trim()||profile.name;profile.source=$<HTMLInputElement>("character-source").value.trim();profile.baseTags=$<HTMLTextAreaElement>("character-base-tags").value.trim();profile.fixedTags=$<HTMLTextAreaElement>("character-fixed-tags").value.trim();profile.negativeTags=$<HTMLTextAreaElement>("character-negative-tags").value.trim();profile.activeOutfitId=$<HTMLSelectElement>("outfit-select").value;profile.outfits=outfits}
function renderCharacterSelectors():void{for(const id of ["drawing-character-select","profile-character-select"]){const select=$<HTMLSelectElement>(id);select.replaceChildren();const none=document.createElement("option");none.value="__none__";none.textContent="不指定角色";select.appendChild(none);for(const profile of characterProfiles){const option=document.createElement("option");option.value=profile.id;option.textContent=profile.protected?`${profile.name} · Agent 本体`:profile.name;select.appendChild(option)}select.value=activeCharacterId}const profile=activeProfile();$("delete-profile").toggleAttribute("disabled",!profile||Boolean(profile.protected))}
function loadActiveProfile():void{const profile=activeProfile();const disabled=!profile;for(const id of ["character-name","character-source","character-base-tags","character-fixed-tags","character-negative-tags"]){($<HTMLInputElement>(id)).disabled=disabled}$<HTMLInputElement>("character-name").value=profile?.name||"";$<HTMLInputElement>("character-source").value=profile?.source||"";$<HTMLTextAreaElement>("character-base-tags").value=profile?.baseTags||"";$<HTMLTextAreaElement>("character-fixed-tags").value=profile?.fixedTags||"";$<HTMLTextAreaElement>("character-negative-tags").value=profile?.negativeTags||"";outfits=profile?.outfits||[];renderOutfits(profile?.activeOutfitId||"__none__");renderCharacterSelectors();$("outfit-select-field").toggleAttribute("hidden",!profile)}
function selectCharacter(id:string):void{syncProfileFromForm();activeCharacterId=id;loadActiveProfile();updateOutfitInspector()}
function refreshOutfitSelect(activeId?:string):void{
  const select=$<HTMLSelectElement>("outfit-select");select.replaceChildren();
  const none=document.createElement("option");none.value="__none__";none.textContent="未选择 · 不注入服装";select.appendChild(none);
  for(const outfit of outfits){const option=document.createElement("option");option.value=outfit.id;option.textContent=outfit.name;select.appendChild(option)}
  select.value=activeId&&outfits.some((item)=>item.id===activeId)?activeId:"__none__";
}
function renderOutfits(activeId?:string):void{
  const editor=$("outfit-editor");editor.replaceChildren();
  outfits.forEach((outfit,index)=>{
    const row=document.createElement("div");row.className="outfit-row";
    const head=document.createElement("div");head.className="outfit-row__head";
    const name=document.createElement("input");name.value=outfit.name;name.placeholder="服装预设名称";
    const remove=document.createElement("button");remove.type="button";remove.textContent="×";remove.title="删除服装预设";
    const descLabel=document.createElement("label");descLabel.textContent="服装说明";const desc=document.createElement("input");desc.value=outfit.description;desc.placeholder="供 Agent 理解和选择的自然语言说明";descLabel.appendChild(desc);
    const tagsLabel=document.createElement("label");tagsLabel.textContent="正向服装 Tags";const tags=document.createElement("textarea");tags.rows=2;tags.value=outfit.tags;tags.placeholder="例如 white dress, floral ornament";tagsLabel.appendChild(tags);
    const negativeLabel=document.createElement("label");negativeLabel.textContent="负向服装 Tags（可选）";const negativeTags=document.createElement("textarea");negativeTags.rows=2;negativeTags.value=outfit.negativeTags||"";negativeTags.placeholder="需要排除的服装特征";negativeLabel.appendChild(negativeTags);
    const sync=()=>{outfits[index]={...outfits[index],name:name.value.trim()||`服装 ${index+1}`,description:desc.value.trim(),tags:tags.value.trim(),negativeTags:negativeTags.value.trim()};refreshOutfitSelect($<HTMLSelectElement>("outfit-select").value)};
    name.oninput=sync;desc.oninput=sync;tags.oninput=sync;negativeTags.oninput=sync;remove.onclick=()=>{const selected=$<HTMLSelectElement>("outfit-select").value;outfits.splice(index,1);renderOutfits(selected===outfit.id?"__none__":selected)};
    head.append(name,remove);row.append(head,descLabel,tagsLabel,negativeLabel);editor.appendChild(row);
  });
  refreshOutfitSelect(activeId);
}
function renderTemplates():void{const editor=$("template-editor");editor.replaceChildren();outfitTemplates.forEach((template,index)=>{const row=document.createElement("div");row.className="outfit-row";const head=document.createElement("div");head.className="outfit-row__head";const name=document.createElement("input");name.value=template.name;name.placeholder="通用模板名称";const remove=document.createElement("button");remove.type="button";remove.textContent="×";remove.title="删除模板";const tags=document.createElement("textarea");tags.rows=2;tags.value=template.tags;tags.placeholder="通用服装 Tags，不要包含角色外貌";const actions=document.createElement("div");actions.className="template-actions";const copy=document.createElement("button");copy.type="button";copy.textContent="复制到当前角色";copy.disabled=!activeProfile();copy.onclick=()=>{const profile=activeProfile();if(!profile)return;const clone={...template,id:slug(`${profile.id}-${template.name}-${Date.now()}`),name:template.name};profile.outfits.push(clone);outfits=profile.outfits;renderOutfits(clone.id);setStatus(`已将“${template.name}”复制到 ${profile.name} 的衣柜。`)};const sync=()=>{outfitTemplates[index]={...outfitTemplates[index],name:name.value.trim()||`通用模板 ${index+1}`,tags:tags.value.trim()}};name.oninput=sync;tags.oninput=sync;remove.onclick=()=>{outfitTemplates.splice(index,1);renderTemplates()};head.append(name,remove);actions.appendChild(copy);row.append(head,tags,actions);editor.appendChild(row)})}

function updateProviderLabels():void {
  const kind=getKind();
  const local=kind==="novelai-gateway";
  const native=kind==="novelai-native";
  $("base-url-label").textContent=local?"Gateway 地址":native?"NovelAI 兼容服务地址":"中转站 Base URL";
  $("api-key-label").textContent=local||native?"NovelAI API Key":"中转站 API Key";
  $("async-fields").toggleAttribute("hidden",kind!=="async-task");
  document.querySelector<HTMLElement>("[data-endpoint-field='models']")?.toggleAttribute("hidden",native);
  const help:Record<ProviderKind,string>={
    "novelai-gateway":"本地 Gateway 负责 NovelAI 参数转换、排队和限流。默认地址 http://127.0.0.1:31555。",
    "openai-images":"适用于实现 /v1/images/generations 的标准图片中转。Base URL 带不带 /v1 均可。",
    "chat-completions-image":"适用于通过 /v1/chat/completions 生图，并在响应文本中返回 Markdown 图片链接或 URL 的中转站。",
    "novelai-native":"适用于 NovelAI 官方或完整兼容 /ai/generate-image 的中转，可使用 NAI 专属采样参数。",
    "async-task":"适用于提交任务后返回 job_id/task_id，再轮询结果的中转站；轮询路径必须包含 {id}。",
  };
  $("connection-help").textContent=help[kind]+" 密钥只保存在本机加密配置中。";
}

async function applyCapabilities(capabilities?:Capabilities):Promise<void> {
  const caps=capabilities||await window.novelai.capabilities(getKind());
  currentCapabilities=caps;
  $<HTMLButtonElement>("open-upscale").disabled=getKind()!=="novelai-gateway";
  $("open-upscale").title=getKind()==="novelai-gateway"?"设置倍率并高清放大当前作品":"高清放大目前需要本地 NovelAI Gateway";
  document.querySelectorAll<HTMLElement>("[data-capability]").forEach((element)=>{
    const key=element.dataset.capability as keyof Capabilities;
    element.toggleAttribute("hidden",!caps[key]);
  });
  const mode=$<HTMLSelectElement>("reference-mode");
  for(const option of Array.from(mode.options)){
    const supported=option.value==="none"||(option.value==="img2img"&&caps.img2img)||(["inpaint","outpaint"].includes(option.value)&&caps.inpaint)||(option.value==="vibe"&&caps.vibe)||(option.value.startsWith("director-")&&caps.directorReference);option.disabled=false;option.dataset.supported=String(supported);option.textContent=(option.textContent||"").replace(/ · 当前协议不支持$/,"")+(supported?"":" · 当前协议不支持");
  }
  const supported=[caps.img2img?"图生图":"",caps.inpaint?"局部重绘":"",caps.vibe?"Vibe":"",caps.directorReference?"Director":""].filter(Boolean);
  $("reference-capability-hint").textContent=supported.length
    ? `当前协议支持：${supported.join("、")}。灰色选项需要切换到支持该能力的协议模板。`
    : "当前协议不支持参考图。请切换到本地 Gateway 或 NovelAI 原生兼容协议。";
  updateReferencePanel();
}

function updateReferencePanel():void{
  const mode=$<HTMLSelectElement>("reference-mode").value;
  if($<HTMLSelectElement>("reference-mode").selectedOptions[0]?.dataset.supported==="false")setStatus("当前协议不支持这个参考模式，请切换到本地 Gateway 或 NovelAI 原生兼容协议。",true);
  if(mode==="inpaint"&&referenceImageDataUrl&&!$<HTMLCanvasElement>("mask-canvas").width)initMaskCanvas();
  if(mode==="outpaint"&&referenceImageDataUrl&&!outpaintImageDataUrl)void prepareOutpaint().catch((error)=>setStatus(error instanceof Error?error.message:String(error),true));
  $("reference-picker").toggleAttribute("hidden",mode==="none");
  $("mask-editor").toggleAttribute("hidden",mode!=="inpaint"||!referenceImageDataUrl);
  $("outpaint-editor").toggleAttribute("hidden",mode!=="outpaint"||!referenceImageDataUrl);
  const info=$<HTMLInputElement>("reference-info").closest("label");
  info?.toggleAttribute("hidden",mode==="img2img"||mode==="inpaint"||mode==="outpaint");
}
function syncReferenceDisplay():void{
  referenceImageDataUrl=referenceImages[0]?.dataUrl||"";
  $("reference-name").textContent=referenceImages.length?`${referenceImages.length} 张：${referenceImages.map((item)=>item.name).join("、")}`:"尚未选择";
  const image=$<HTMLImageElement>("reference-preview");image.src=referenceImageDataUrl;image.hidden=!referenceImageDataUrl;
  if($<HTMLSelectElement>("reference-mode").value==="inpaint")initMaskCanvas();
  if($<HTMLSelectElement>("reference-mode").value==="outpaint")void prepareOutpaint();
}
async function prepareOutpaint():Promise<void>{if(!referenceImageDataUrl)return;const image=new Image();image.src=referenceImageDataUrl;await image.decode();const read=(id:string)=>Math.max(0,Math.min(768,Math.round(Number($<HTMLInputElement>(id).value||0)/64)*64));const left=read("outpaint-left"),right=read("outpaint-right"),top=read("outpaint-top"),bottom=read("outpaint-bottom");outpaintWidth=image.naturalWidth+left+right;outpaintHeight=image.naturalHeight+top+bottom;if(outpaintWidth>1600||outpaintHeight>1600)throw new Error(`扩图后尺寸 ${outpaintWidth}×${outpaintHeight} 超过 1600 像素限制`);const canvas=$<HTMLCanvasElement>("outpaint-canvas");canvas.width=outpaintWidth;canvas.height=outpaintHeight;const ctx=canvas.getContext("2d")!;ctx.fillStyle="#808080";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,left,top);outpaintImageDataUrl=canvas.toDataURL("image/png");const mask=document.createElement("canvas");mask.width=outpaintWidth;mask.height=outpaintHeight;const mctx=mask.getContext("2d")!;mctx.fillStyle="#fff";mctx.fillRect(0,0,mask.width,mask.height);mctx.fillStyle="#000";mctx.fillRect(left,top,image.naturalWidth,image.naturalHeight);outpaintMaskDataUrl=mask.toDataURL("image/png");$("outpaint-size-label").textContent=`新画布：${outpaintWidth} × ${outpaintHeight}`}
function initMaskCanvas():void{if(!referenceImageDataUrl)return;const source=$<HTMLImageElement>("mask-source");source.src=referenceImageDataUrl;source.onload=()=>{const canvas=$<HTMLCanvasElement>("mask-canvas");canvas.width=source.naturalWidth;canvas.height=source.naturalHeight;const ctx=canvas.getContext("2d")!;ctx.fillStyle="#000";ctx.fillRect(0,0,canvas.width,canvas.height);maskHistory=[];maskImageDataUrl="";updateReferencePanel()}}
function maskPoint(event:PointerEvent){const canvas=$<HTMLCanvasElement>("mask-canvas");const rect=canvas.getBoundingClientRect();return{x:(event.clientX-rect.left)*canvas.width/rect.width,y:(event.clientY-rect.top)*canvas.height/rect.height}}
function saveMaskState():void{const canvas=$<HTMLCanvasElement>("mask-canvas");if(!canvas.width)return;const ctx=canvas.getContext("2d")!;maskHistory.push(ctx.getImageData(0,0,canvas.width,canvas.height));if(maskHistory.length>20)maskHistory.shift()}
function drawMask(event:PointerEvent):void{if(!maskDrawing)return;const canvas=$<HTMLCanvasElement>("mask-canvas");const ctx=canvas.getContext("2d")!;const p=maskPoint(event);ctx.fillStyle=maskErase?"#000":"#fff";ctx.beginPath();ctx.arc(p.x,p.y,Number($<HTMLInputElement>("mask-size").value)*canvas.width/canvas.clientWidth/2,0,Math.PI*2);ctx.fill();maskImageDataUrl=canvas.toDataURL("image/png")}

function loadResultParams(item:NovelAiResult):void {
  prompt.value=item.prompt||"";model.value=item.model||model.value;
  if(item.width)$<HTMLSelectElement>("width").value=String(item.width);
  if(item.height)$<HTMLSelectElement>("height").value=String(item.height);
  if(item.steps)$<HTMLInputElement>("steps").value=String(item.steps);
  if(item.scale!==undefined)$<HTMLInputElement>("scale").value=String(item.scale);
  if(item.sampler)$<HTMLSelectElement>("sampler").value=item.sampler;
  if(item.seed!==undefined)$<HTMLInputElement>("seed").value=item.seed<0?"":String(item.seed);
  negative.value=item.negativePrompt||negative.value;
  if(item.characters){characters=item.characters.map((character)=>({...character}));renderCharacters()}
  selectCharacter(item.characterId||"__none__");refreshOutfitSelect(item.outfitId||"__none__");
  setStatus("已载入历史作品参数，可以修改后重新绘制。");
}
function addDetail(list:HTMLElement,label:string,value:unknown):void{
  if(value===undefined||value===null||value==="")return;
  const dt=document.createElement("dt");dt.textContent=label;
  const dd=document.createElement("dd");dd.textContent=String(value);list.append(dt,dd);
}
function showResult(item:NovelAiResult):void {
  selectedResult=item;
  preview.replaceChildren();
  const img=document.createElement("img"); img.src=item.dataUrl; img.alt=item.prompt; preview.appendChild(img);
  const download=$<HTMLAnchorElement>("download-result");download.href=item.dataUrl;download.download=`novelai-${item.id}.png`;download.hidden=false;
  $("result-summary").hidden=false;
  $("result-title").textContent=`${item.characterName||"未指定角色"} · ${item.outfitName||"未选择服装"}`;
  const chips=$("result-chips");chips.replaceChildren();
  [`${item.width||"?"}×${item.height||"?"}`,item.model,item.steps?`${item.steps} steps`:"",item.scale!==undefined?`CFG ${item.scale}`:"",item.referenceMode&&item.referenceMode!=="none"?item.referenceMode:""].filter(Boolean).forEach((text)=>{const chip=document.createElement("span");chip.textContent=String(text);chips.appendChild(chip)});
  const details=$("result-details");details.replaceChildren();
  addDetail(details,"画面描述",item.prompt);addDetail(details,"最终 Prompt",item.compiledPrompt);addDetail(details,"负面 Prompt",item.negativePrompt);
  addDetail(details,"模型",item.model);addDetail(details,"协议",item.providerMode);addDetail(details,"尺寸",`${item.width||"?"} × ${item.height||"?"}`);
  addDetail(details,"步数",item.steps);addDetail(details,"CFG",item.scale);addDetail(details,"采样器",item.sampler);addDetail(details,"种子",item.seed===-1?"随机":item.seed);
  addDetail(details,"绘图角色",item.characterName||"未指定");addDetail(details,"穿搭",item.outfitName||"未选择");addDetail(details,"参考模式",item.referenceMode&&item.referenceMode!=="none"?item.referenceMode:"未使用");addDetail(details,"生成时间",new Date(item.createdAt).toLocaleString());
  inspector.final=item.compiledPrompt||item.prompt;renderInspector();
}
function updateOutfitInspector():void{const character=activeProfile(),outfit=outfits.find((item)=>item.id===$<HTMLSelectElement>("outfit-select").value);inspector.outfit=`绘图主体：${character?.name||"不指定角色"}\n角色注入：${character?"已启用":"未启用"}\n服装注入：${outfit?.name||"未选择"}${outfit?`\n正向：${outfit.tags}${outfit.negativeTags?`\n负向：${outfit.negativeTags}`:""}`:""}\nAgent 身份：昔涟（仅负责理解和绘制）`;if(inspector.translated)inspector.final=[$<HTMLTextAreaElement>("photo-style-tags").value,character?.baseTags,character?.fixedTags,outfit?.tags,inspector.translated].filter(Boolean).join(", ");renderInspector()}
function renderInspector():void{$("prompt-inspector-content").textContent=inspector[inspectorTab]||"暂无内容";document.querySelectorAll<HTMLElement>("[data-prompt-tab]").forEach((button)=>button.classList.toggle("is-active",button.dataset.promptTab===inspectorTab))}
function editFromResult(item:NovelAiResult):void{
  loadResultParams(item);referenceImages=[{id:`history-${item.id}`,name:"历史作品",dataUrl:item.dataUrl,strength:0.7,informationExtracted:1}];syncReferenceDisplay();
  const mode=$<HTMLSelectElement>("reference-mode");const img2img=Array.from(mode.options).find((option)=>option.value==="img2img"&&!option.disabled);if(img2img)mode.value="img2img";updateReferencePanel();setStatus("已将当前作品设为图生图底图，可以修改提示词后继续创作。");
}
function renderHistory(items:NovelAiResult[]):void {
  history.replaceChildren(); $("history-count").textContent=historyHasMore?`${items.length} 张 · 下滑加载更多`:`${items.length} 张 · 已全部加载`;
  for(const item of items){
    const button=document.createElement("div"); button.className="history-item"; button.title=item.prompt;button.tabIndex=0;button.setAttribute("role","button");
    const img=document.createElement("img"); img.src=item.dataUrl; img.alt=item.prompt;
    const caption=document.createElement("div"); caption.textContent=item.prompt;
    const replay=document.createElement("button");replay.type="button";replay.className="history-item__replay";replay.textContent="☷";replay.title="载入这张作品的参数";
    replay.onclick=(event)=>{event.stopPropagation();loadResultParams(item);};
    const favorite=document.createElement("button");favorite.type="button";favorite.className="history-item__favorite";favorite.textContent=item.favorite?"★":"☆";favorite.title="收藏作品";favorite.onclick=async(event)=>{event.stopPropagation();const next=!item.favorite;await window.novelai.updateHistory(item.id,{favorite:next});item.favorite=next;applyHistoryFilter()};
    const remove=document.createElement("button");remove.type="button";remove.className="history-item__delete";remove.textContent="×";remove.title="删除作品";remove.onclick=async(event)=>{event.stopPropagation();if(!confirm("删除这张作品及其本地图片？"))return;if(await window.novelai.deleteHistory(item.id)){allHistory=allHistory.filter((entry)=>entry.id!==item.id);applyHistoryFilter()}};
    button.append(img,caption,replay,favorite,remove); button.onclick=()=>showResult(item); history.appendChild(button);
  }
}
function applyHistoryFilter():void{const query=$<HTMLInputElement>("history-search").value.trim().toLowerCase(),favorites=$<HTMLInputElement>("history-favorites").checked;renderHistory(allHistory.filter((item)=>(!favorites||item.favorite)&&(!query||`${item.prompt} ${item.model}`.toLowerCase().includes(query))))}
async function refreshHistory(selectFirst=true):Promise<void>{if(historyLoading)return;historyLoading=true;try{const firstPage=await window.novelai.history(0,HISTORY_PAGE_SIZE);allHistory=firstPage;historyHasMore=firstPage.length===HISTORY_PAGE_SIZE;applyHistoryFilter();if(selectFirst&&allHistory[0])showResult(allHistory[0])}catch(e){console.error(e)}finally{historyLoading=false}}
async function loadMoreHistory():Promise<void>{if(historyLoading||!historyHasMore)return;historyLoading=true;try{const page=await window.novelai.history(allHistory.length,HISTORY_PAGE_SIZE);const known=new Set(allHistory.map((item)=>item.id));allHistory.push(...page.filter((item)=>!known.has(item.id)));historyHasMore=page.length===HISTORY_PAGE_SIZE;applyHistoryFilter()}catch(e){console.error(e)}finally{historyLoading=false}}

function renderTasks(tasks:ImageTask[]):void{
  const list=$("task-list");list.replaceChildren();$("task-count").textContent=`${tasks.length} 项`;
  const activitySummary=$<HTMLElement>("activity-summary");
  const activeTask=tasks.find((task)=>task.status==="running"||task.status==="queued");
  const failedTask=tasks.find((task)=>task.status==="failed");
  activitySummary.textContent=activeTask
    ? `${activeTask.status==="running"?"正在生成":"等待生成"} · ${activeTask.prompt}`
    : failedTask
      ? `生成失败 · ${failedTask.error||"点击查看详情"}`
      : tasks.length
        ? `最近共有 ${tasks.length} 项任务`
        : "暂无生成任务";
  activitySummary.classList.toggle("is-error",Boolean(failedTask&&!activeTask));
  if(!tasks.length){const empty=document.createElement("p");empty.className="task-empty";empty.textContent="暂无任务";list.appendChild(empty);return}
  const labels:Record<ImageTask["status"],string>={queued:"等待中",running:"生成中",completed:"已完成",failed:"失败",cancelled:"已取消"};
  for(const task of tasks.slice(0,8)){
    const row=document.createElement("article");row.className=`task-item task-item--${task.status}`;
    const text=document.createElement("div");const title=document.createElement("strong");title.textContent=task.prompt;const meta=document.createElement("small");meta.textContent=task.error||`${labels[task.status]} · ${new Date(task.createdAt).toLocaleTimeString()}`;text.append(title,meta);
    const action=document.createElement("button");action.type="button";
    if(task.status==="queued"||task.status==="running"){action.textContent="×";action.title="取消任务";action.onclick=()=>void window.novelai.cancelTask(task.id)}
    else if(task.status==="failed"||task.status==="cancelled"){action.textContent="↻";action.title="重试任务";action.onclick=async()=>{action.disabled=true;try{const result=await window.novelai.retryTask(task.id);showResult(result);await refreshHistory()}catch(e){setStatus("任务重试失败，请稍后再试。",true,e);setActivityDrawer(true)}finally{action.disabled=false}}}
    else{action.textContent="✓";action.disabled=true;action.title="任务已完成"}
    row.append(text,action);list.appendChild(row);
  }
}
async function refreshTasks():Promise<void>{try{renderTasks(await window.novelai.tasks())}catch(e){console.error(e)}}

function renderCharacters():void{const editor=$("character-editor");editor.replaceChildren();characters.forEach((character,index)=>{const row=document.createElement("article");row.className="character-row";const name=document.createElement("input");name.value=character.name;const tags=document.createElement("textarea");tags.rows=2;tags.value=character.prompt;tags.placeholder="外观、服装、动作、表情 Tags";const negativeInput=document.createElement("input");negativeInput.value=character.negativePrompt;negativeInput.placeholder="角色负面提示词";const remove=document.createElement("button");remove.type="button";remove.textContent="×";const sync=()=>{characters[index]={...characters[index],name:name.value||`角色 ${index+1}`,prompt:tags.value,negativePrompt:negativeInput.value};renderCharacterMarkers()};name.oninput=sync;tags.oninput=sync;negativeInput.oninput=sync;remove.onclick=()=>{characters.splice(index,1);renderCharacters()};row.append(name,tags,negativeInput,remove);editor.appendChild(row)});renderCharacterMarkers()}
function renderCharacterMarkers():void{const board=$("composition-board");board.querySelectorAll("button").forEach((node)=>node.remove());characters.forEach((character,index)=>{const marker=document.createElement("button");marker.type="button";marker.textContent=String(index+1);marker.title=character.name;marker.style.left=`${character.x*100}%`;marker.style.top=`${character.y*100}%`;marker.onpointerdown=(event)=>{marker.setPointerCapture(event.pointerId);marker.onpointermove=(next)=>{const rect=board.getBoundingClientRect();character.x=Math.max(0,Math.min(1,(next.clientX-rect.left)/rect.width));character.y=Math.max(0,Math.min(1,(next.clientY-rect.top)/rect.height));marker.style.left=`${character.x*100}%`;marker.style.top=`${character.y*100}%`};marker.onpointerup=()=>{marker.onpointermove=null}};board.appendChild(marker)})}
function useAsset(asset:ImageAsset):void{
  const mode=$<HTMLSelectElement>("reference-mode");if(mode.value==="none"){const first=Array.from(mode.options).find((option)=>option.value!=="none"&&!option.disabled);if(first)mode.value=first.value}
  const multi=mode.value==="vibe"||mode.value.startsWith("director-");const exists=referenceImages.findIndex((item)=>item.id===asset.id);
  if(multi&&exists>=0)referenceImages.splice(exists,1);else if(multi)referenceImages.push({...asset,strength:0.7,informationExtracted:1});else referenceImages=[{...asset,strength:0.7,informationExtracted:1}];
  syncReferenceDisplay();updateReferencePanel();void refreshAssets();setStatus(referenceImages.length?`已选择 ${referenceImages.length} 张参考素材。再次点击可取消选择。`:"已清空参考素材。");
}
async function refreshAssets():Promise<void>{
  await runAssetAction(async()=>{
    allAssets=await window.novelai.assets();const query=$<HTMLInputElement>("asset-search").value.trim().toLowerCase(),category=$<HTMLSelectElement>("asset-category").value;const assets=allAssets.filter((asset)=>(!query||asset.name.toLowerCase().includes(query))&&(category==="all"||(category==="favorite"?asset.favorite:(asset.category||"other")===category)));const library=$("asset-library");library.replaceChildren();$("asset-count").textContent=`${assets.length}/${allAssets.length} 张`;
    if(!assets.length){const empty=document.createElement("p");empty.className="task-empty";empty.textContent="尚未导入素材";library.appendChild(empty);return}
    for(const asset of assets){
      const item=document.createElement("article");item.className="asset-item";item.classList.toggle("is-selected",referenceImages.some((selected)=>selected.id===asset.id));item.tabIndex=0;
      const image=document.createElement("img");image.src=asset.dataUrl;image.alt=asset.name;
      const name=document.createElement("span");name.textContent=asset.name;name.ondblclick=(event)=>{event.stopPropagation();const next=promptDialog("重命名素材",asset.name);if(next)void runAssetAction(async()=>{await window.novelai.updateAsset(asset.id,{name:next});await refreshAssets()},{errorMessage:ASSET_ACTION_ERROR})};
      const categorySelect=document.createElement("select");for(const [value,label] of [["character","角色"],["outfit","服装"],["pose","姿势"],["style","画风"],["other","其他"]]){const option=document.createElement("option");option.value=value;option.textContent=label;categorySelect.appendChild(option)}categorySelect.value=asset.category||"other";categorySelect.onclick=(event)=>event.stopPropagation();categorySelect.onchange=()=>{void runAssetAction(async()=>{await window.novelai.updateAsset(asset.id,{category:categorySelect.value});await refreshAssets()},{errorMessage:ASSET_ACTION_ERROR})};
      const favorite=document.createElement("button");favorite.type="button";favorite.className="asset-item__favorite";favorite.textContent=asset.favorite?"★":"☆";favorite.onclick=(event)=>{event.stopPropagation();void runAssetAction(async()=>{await window.novelai.updateAsset(asset.id,{favorite:!asset.favorite});await refreshAssets()},{errorMessage:ASSET_ACTION_ERROR})};
      const remove=document.createElement("button");remove.type="button";remove.textContent="×";remove.title="删除素材";remove.onclick=(event)=>{event.stopPropagation();void runAssetAction(async()=>{const deleted=await window.novelai.deleteAsset(asset.id);if(deleted){referenceImages=referenceImages.filter((selected)=>selected.id!==asset.id);syncReferenceDisplay()}await refreshAssets()},{errorMessage:ASSET_ACTION_ERROR})};
      item.onclick=()=>useAsset(asset);item.onkeydown=(event)=>{if(event.key==="Enter"||event.key===" ")useAsset(asset)};item.append(image,name,categorySelect,favorite,remove);library.appendChild(item);
    }
  },{errorMessage:ASSET_LOAD_ERROR,clearOnSuccess:true});
}

async function testConnection():Promise<void>{
  badge.textContent="检测中"; badge.classList.remove("ok");
  try{
    const draft=configFromForm(); const result=await window.novelai.test(draft); await applyCapabilities(result.capabilities);
    badge.textContent="已连接"; badge.classList.add("ok"); setStatus("接口连接正常。");
    try{
      const models=await window.novelai.models(draft); const options=$<HTMLDataListElement>("model-options"); options.replaceChildren();
      for(const id of models){const option=document.createElement("option");option.value=id;options.appendChild(option)}
    }catch{setStatus("接口可用，但没有提供模型列表；请手动填写模型名。")}
  }catch(e){badge.textContent="连接失败";setStatus("连接测试失败，请检查服务地址和密钥。",true,e)}
}

async function init():Promise<void>{
  try{
    const config=await window.novelai.loadConfig(); providerMode.value=config.providerMode||"novelai-gateway";
    gateway.value=config.gatewayUrl; apiKey.value=config.apiKey; negative.value=config.defaultNegativePrompt; model.value=config.model;
    $<HTMLInputElement>("models-path").value=config.modelsPath||"/v1/models";
    $<HTMLInputElement>("generation-path").value=config.generationPath||"/v1/images/generations";
    $<HTMLInputElement>("async-result-path").value=config.asyncResultPath||"/api/get_result/{id}";
    $<HTMLInputElement>("poll-interval").value=String(config.pollIntervalMs||5000);
    $<HTMLTextAreaElement>("photo-style-tags").value=config.photoStyleTags||"";
    $<HTMLTextAreaElement>("drawing-style-tags").value=config.drawingStyleTags||"";
    $<HTMLInputElement>("wardrobe-enabled").checked=config.wardrobeEnabled!==false;
    characterProfiles=Array.isArray(config.characters)?config.characters:[];outfitTemplates=Array.isArray(config.outfitTemplates)?config.outfitTemplates:[];activeCharacterId=config.activeCharacterId||"__none__";loadActiveProfile();renderTemplates();
    updateProviderLabels(); await applyCapabilities(); await Promise.all([refreshHistory(),refreshTasks(),refreshAssets()]); void testConnection();
  }catch(e){setStatus(String(e),true)}
  const theme=await window.cyreneTheme?.get?.(); if(theme)document.body.dataset.uiTheme=theme;
  window.cyreneTheme?.onChanged?.((value)=>document.body.dataset.uiTheme=value);
}

$("minimize").onclick=()=>window.novelai.minimize();
$("close").onclick=()=>window.novelai.close();
$("test").onclick=()=>void testConnection();
$("open-output").onclick=()=>void window.novelai.openOutput();
$("load-result-params").onclick=()=>{if(selectedResult)loadResultParams(selectedResult)};
$("edit-result").onclick=()=>{if(selectedResult)editFromResult(selectedResult)};
$<HTMLInputElement>("asset-search").oninput=()=>void refreshAssets();$<HTMLSelectElement>("asset-category").onchange=()=>void refreshAssets();$<HTMLInputElement>("history-search").oninput=applyHistoryFilter;$<HTMLInputElement>("history-favorites").onchange=applyHistoryFilter;
document.querySelector<HTMLElement>(".history-panel")!.onscroll=(event)=>{const panel=event.currentTarget as HTMLElement;if(panel.scrollTop+panel.clientHeight>=panel.scrollHeight-120)void loadMoreHistory()};
document.querySelectorAll<HTMLButtonElement>("[data-prompt-tab]").forEach((button)=>button.onclick=()=>{inspectorTab=button.dataset.promptTab as typeof inspectorTab;renderInspector()});
$("copy-final-prompt").onclick=()=>void navigator.clipboard.writeText(inspector.final||prompt.value);
$("translate-prompt").onclick=async()=>{const description=$<HTMLTextAreaElement>("natural-prompt").value.trim();if(!description){setStatus("请先填写自然语言画面描述。",true);return}const button=$<HTMLButtonElement>("translate-prompt");button.disabled=true;setStatus("正在理解画面并构建 NovelAI Prompt...");try{const raw=await window.novelai.translatePrompt(description);const translated=typeof raw==="string"?raw:String((raw as any)?.reply||(raw as any)?.content||"");if(!translated.trim())throw new Error("模型没有返回提示词");prompt.value=translated.trim().replace(/^```\w*|```$/g,"").trim();inspector.translated=prompt.value;updateOutfitInspector();inspectorTab="final";renderInspector();setStatus("Prompt 已构建，可以继续编辑或直接生成。") }catch(error){setStatus(error instanceof Error?error.message:String(error),true)}finally{button.disabled=false}};
$("open-upscale").onclick=()=>{if(!selectedResult)return;const width=selectedResult.width||0,height=selectedResult.height||0;$("upscale-source-size").textContent=width&&height?`${width} × ${height}`:"未知";$("upscale-2-size").textContent=width&&height?`输出 ${width*2} × ${height*2}`:"适合常规高清输出";$("upscale-4-size").textContent=width&&height?`输出 ${width*4} × ${height*4}`:"适合大尺寸输出";$<HTMLDialogElement>("upscale-dialog").showModal()};
$("upscale-result").onclick=async(event)=>{event.preventDefault();if(!selectedResult)return;const button=$<HTMLButtonElement>("upscale-result");button.disabled=true;setStatus("正在高清放大，可能消耗额外额度...");try{const scale=Number(document.querySelector<HTMLInputElement>('input[name="upscale-scale"]:checked')?.value||2);const result=await window.novelai.upscale(selectedResult.id,scale);$<HTMLDialogElement>("upscale-dialog").close();showResult(result);await refreshHistory();setStatus("高清放大完成，作品已保存。") }catch(error){setStatus(error instanceof Error?error.message:String(error),true)}finally{button.disabled=false}};
$<HTMLCanvasElement>("mask-canvas").onpointerdown=(event)=>{saveMaskState();maskDrawing=true;$<HTMLCanvasElement>("mask-canvas").setPointerCapture(event.pointerId);drawMask(event)};
$<HTMLCanvasElement>("mask-canvas").onpointermove=drawMask;$<HTMLCanvasElement>("mask-canvas").onpointerup=()=>{maskDrawing=false};
$("mask-brush").onclick=()=>{maskErase=false;$("mask-brush").classList.add("is-active");$("mask-eraser").classList.remove("is-active")};
$("mask-eraser").onclick=()=>{maskErase=true;$("mask-eraser").classList.add("is-active");$("mask-brush").classList.remove("is-active")};
$("mask-clear").onclick=()=>{const canvas=$<HTMLCanvasElement>("mask-canvas");saveMaskState();const ctx=canvas.getContext("2d")!;ctx.fillStyle="#000";ctx.fillRect(0,0,canvas.width,canvas.height);maskImageDataUrl=canvas.toDataURL("image/png")};
$("mask-undo").onclick=()=>{const state=maskHistory.pop();if(!state)return;const canvas=$<HTMLCanvasElement>("mask-canvas");canvas.getContext("2d")!.putImageData(state,0,0);maskImageDataUrl=canvas.toDataURL("image/png")};
$("outpaint-preview").onclick=()=>void prepareOutpaint().catch((error)=>setStatus(error instanceof Error?error.message:String(error),true));
$<HTMLSelectElement>("reference-mode").onchange=updateReferencePanel;
$("pick-reference").onclick=async()=>{const picked=await window.novelai.pickImage();if(!picked)return;referenceImages=[{id:`picked-${Date.now()}`,name:picked.name,dataUrl:picked.dataUrl,strength:0.7,informationExtracted:1}];syncReferenceDisplay();};
$("import-asset").onclick=()=>{void runAssetAction(async()=>{const asset=await window.novelai.importAsset();if(asset){await refreshAssets();useAsset(asset)}},{errorMessage:ASSET_ACTION_ERROR})};
$("add-character").onclick=()=>{if(characters.length>=6)return;const index=characters.length;characters.push({id:`character-${Date.now()}`,name:`角色 ${index+1}`,prompt:"",negativePrompt:"",x:(index+1)/(characters.length+2),y:.55});renderCharacters()};
$("layout-characters").onclick=()=>{characters.forEach((character,index)=>{character.x=(index+1)/(characters.length+1);character.y=.55});renderCharacters()};
$<HTMLSelectElement>("outfit-select").onchange=updateOutfitInspector;
$<HTMLSelectElement>("drawing-character-select").onchange=(event)=>selectCharacter((event.currentTarget as HTMLSelectElement).value);
$<HTMLSelectElement>("profile-character-select").onchange=(event)=>selectCharacter((event.currentTarget as HTMLSelectElement).value);
$<HTMLInputElement>("character-name").oninput=()=>{syncProfileFromForm();renderCharacterSelectors()};
$<HTMLInputElement>("character-source").oninput=syncProfileFromForm;$<HTMLTextAreaElement>("character-base-tags").oninput=syncProfileFromForm;$<HTMLTextAreaElement>("character-fixed-tags").oninput=syncProfileFromForm;$<HTMLTextAreaElement>("character-negative-tags").oninput=syncProfileFromForm;
$<HTMLButtonElement>("add-profile").onclick=()=>{syncProfileFromForm();const name=`新角色 ${characterProfiles.length+1}`,id=slug(`${name}-${Date.now()}`);characterProfiles.push({id,name,source:"",baseTags:"",fixedTags:"",negativeTags:"",activeOutfitId:"__none__",outfits:[]});activeCharacterId=id;loadActiveProfile();renderTemplates()};
$<HTMLButtonElement>("delete-profile").onclick=()=>{const profile=activeProfile();if(!profile||profile.protected)return;if(!confirm(`删除角色“${profile.name}”及其独立衣柜？`))return;characterProfiles=characterProfiles.filter((item)=>item.id!==profile.id);activeCharacterId=characterProfiles[0]?.id||"__none__";loadActiveProfile();renderTemplates()};
$<HTMLInputElement>("wardrobe-enabled").onchange=()=>refreshOutfitSelect($<HTMLSelectElement>("outfit-select").value);
$("add-outfit").onclick=()=>{const name=`新服装 ${outfits.length+1}`;outfits.push({id:slug(name+Date.now()),name,description:"",tags:"",negativeTags:""});renderOutfits(outfits[outfits.length-1].id)};
$("add-template").onclick=()=>{const name=`通用模板 ${outfitTemplates.length+1}`;outfitTemplates.push({id:slug(name+Date.now()),name,description:"",tags:"",negativeTags:""});renderTemplates()};
$("save-character").onclick=()=>void saveLocalConfig("save-character","角色档案已保存到本机。");
$("save-wardrobe").onclick=()=>void saveLocalConfig("save-wardrobe","角色衣柜与通用服装模板已保存到本机。");
providerMode.onchange=()=>{
  const preset=presets[getKind()]; gateway.value=preset.gatewayUrl; $<HTMLInputElement>("models-path").value=preset.modelsPath;
  $<HTMLInputElement>("generation-path").value=preset.generationPath; $<HTMLInputElement>("async-result-path").value=preset.asyncResultPath;
  updateProviderLabels(); void applyCapabilities(); badge.textContent="未检测"; badge.classList.remove("ok");
};
$("save").onclick=async()=>{try{await window.novelai.saveConfig(configFromForm());setStatus("配置已加密保存到本机。");await testConnection()}catch(e){setStatus(e instanceof Error?e.message:String(e),true)}};
$("generate").onclick=async()=>{
  const button=$<HTMLButtonElement>("generate");button.disabled=true;setStatus("正在提交绘图任务，请稍候...");
  try{
    await window.novelai.saveConfig(configFromForm());
    const referenceMode=$<HTMLSelectElement>("reference-mode").value;if($<HTMLSelectElement>("reference-mode").selectedOptions[0]?.dataset.supported==="false")throw new Error("当前协议不支持所选参考模式，请先切换协议模板");if(referenceMode!=="none"&&!referenceImages.length)throw new Error("请先选择参考图片");if(referenceMode==="inpaint"&&!maskImageDataUrl)throw new Error("请先涂抹需要重绘的区域");if(referenceMode==="outpaint")await prepareOutpaint();
    const strength=Number($<HTMLInputElement>("reference-strength").value);const informationExtracted=Number($<HTMLInputElement>("reference-info").value);
    const draft={prompt:prompt.value,negativePrompt:negative.value,model:model.value,characterId:activeCharacterId,outfitId:$<HTMLSelectElement>("outfit-select").value,width:referenceMode==="outpaint"?outpaintWidth:$<HTMLSelectElement>("width").value,height:referenceMode==="outpaint"?outpaintHeight:$<HTMLSelectElement>("height").value,steps:$<HTMLInputElement>("steps").value,scale:$<HTMLInputElement>("scale").value,sampler:$<HTMLSelectElement>("sampler").value,referenceMode,referenceImage:referenceMode==="outpaint"?outpaintImageDataUrl:referenceImages[0]?.dataUrl,maskImage:referenceMode==="outpaint"?outpaintMaskDataUrl:maskImageDataUrl,referenceImages:referenceImages.map((item)=>({image:item.dataUrl,strength,informationExtracted})),referenceStrength:strength,referenceInformationExtracted:informationExtracted,characters:characters.filter((item)=>item.prompt.trim())};
    if(referenceImages[0]?.id.startsWith("history-"))(draft as Record<string,unknown>).parentId=referenceImages[0].id.slice(8);const count=Math.max(1,Math.min(4,Number($<HTMLSelectElement>("variant-count").value)||1));const requestedSeed=$<HTMLInputElement>("seed").value.trim();const results=await Promise.all(Array.from({length:count},(_,index)=>window.novelai.generate({...draft,seed:requestedSeed?Number(requestedSeed)+index:""})));showResult(results[results.length-1]);await refreshHistory();setStatus(`${count} 张变体绘制完成，作品已保存。`);
  }catch(e){setStatus("绘图提交失败，请检查设置后重试。",true,e);setActivityDrawer(true)}finally{button.disabled=false}
};
bindNovelAiUi();
renderInspector();
void init();
window.novelai.onTasksChanged((tasks)=>{renderTasks(tasks);window.clearTimeout(taskRefreshTimer);taskRefreshTimer=window.setTimeout(()=>void refreshHistory(),250)});
export {};
