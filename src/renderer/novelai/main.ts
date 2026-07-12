type ProviderKind = "novelai-gateway" | "openai-images" | "chat-completions-image" | "novelai-native" | "async-task";
interface Capabilities { negativePrompt:boolean; dimensions:boolean; steps:boolean; scale:boolean; sampler:boolean; seed:boolean; img2img:boolean; vibe:boolean; directorReference:boolean; multiCharacter:boolean }
interface NovelAiResult { id:string; prompt:string; compiledPrompt?:string; model:string; providerMode?:ProviderKind; createdAt:string; dataUrl:string; width?:number; height?:number; steps?:number; scale?:number; sampler?:string; seed?:number; mode?:"photo"|"drawing"; outfitId?:string|null; outfitName?:string|null; negativePrompt?:string; referenceMode?:string; referenceStrength?:number|null; referenceInformationExtracted?:number|null }
interface OutfitPreset { id:string; name:string; description:string; tags:string }
interface ImageTask { id:string; status:"queued"|"running"|"completed"|"failed"|"cancelled"; prompt:string; createdAt:string; error?:string; resultId?:string }
interface ImageAsset { id:string; name:string; dataUrl:string; createdAt:string }
interface NovelAiConfig {
  providerMode:ProviderKind; gatewayUrl:string; apiKey:string; model:string; defaultNegativePrompt:string;
  modelsPath:string; generationPath:string; asyncResultPath:string; pollIntervalMs:number;
  characterName:string; characterBaseTags:string; characterFixedTags:string; characterNegativeTags:string;
  photoStyleTags:string; drawingStyleTags:string; wardrobeEnabled:boolean; activeOutfitId:string; outfits:OutfitPreset[];
}
declare global {
  interface Window {
    novelai: {
      minimize():void; close():void; loadConfig():Promise<NovelAiConfig>;
      saveConfig(config:Partial<NovelAiConfig>):Promise<NovelAiConfig>;
      test(config?:Partial<NovelAiConfig>):Promise<{ok:boolean;capabilities:Capabilities}>;
      models(config?:Partial<NovelAiConfig>):Promise<string[]>; capabilities(kind:ProviderKind):Promise<Capabilities>;
      generate(input:Record<string,unknown>):Promise<NovelAiResult>; history():Promise<NovelAiResult[]>; image(id:string):Promise<NovelAiResult|null>; openOutput():Promise<void>; pickImage():Promise<{name:string;dataUrl:string}|null>;
      tasks():Promise<ImageTask[]>;cancelTask(id:string):Promise<boolean>;retryTask(id:string):Promise<NovelAiResult>;onTasksChanged(cb:(tasks:ImageTask[])=>void):()=>void;
      assets():Promise<ImageAsset[]>;importAsset():Promise<ImageAsset|null>;deleteAsset(id:string):Promise<boolean>;
    };
    cyreneTheme?: { get():Promise<string>; onChanged(cb:(theme:string)=>void):()=>void };
  }
}

const $ = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
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
let currentCapabilities:Capabilities|null=null;
let referenceImageDataUrl="";
let selectedResult:NovelAiResult|null=null;
let taskRefreshTimer:number|undefined;

const presets: Record<ProviderKind, Pick<NovelAiConfig,"gatewayUrl"|"modelsPath"|"generationPath"|"asyncResultPath">> = {
  "novelai-gateway": { gatewayUrl:"http://127.0.0.1:31555", modelsPath:"/v1/models", generationPath:"/v1/images/generations", asyncResultPath:"/api/get_result/{id}" },
  "openai-images": { gatewayUrl:"", modelsPath:"/v1/models", generationPath:"/v1/images/generations", asyncResultPath:"/api/get_result/{id}" },
  "chat-completions-image": { gatewayUrl:"", modelsPath:"/v1/models", generationPath:"/v1/chat/completions", asyncResultPath:"/api/get_result/{id}" },
  "novelai-native": { gatewayUrl:"https://image.novelai.net", modelsPath:"/v1/models", generationPath:"/ai/generate-image", asyncResultPath:"/api/get_result/{id}" },
  "async-task": { gatewayUrl:"", modelsPath:"/v1/models", generationPath:"/api/generate_image", asyncResultPath:"/api/get_result/{id}" },
};

function setStatus(text:string,error=false):void { status.textContent=text; status.classList.toggle("error",error); }
function getKind():ProviderKind { return providerMode.value as ProviderKind; }
function configFromForm():Partial<NovelAiConfig> {
  return {
    providerMode:getKind(), gatewayUrl:gateway.value.trim(), apiKey:apiKey.value.trim(), model:model.value.trim(),
    defaultNegativePrompt:negative.value.trim(), modelsPath:$<HTMLInputElement>("models-path").value.trim(),
    generationPath:$<HTMLInputElement>("generation-path").value.trim(),
    asyncResultPath:$<HTMLInputElement>("async-result-path").value.trim(),
    pollIntervalMs:Number($<HTMLInputElement>("poll-interval").value) || 5000,
    characterName:$<HTMLInputElement>("character-name").value.trim(),
    characterBaseTags:$<HTMLTextAreaElement>("character-base-tags").value.trim(),
    characterFixedTags:$<HTMLTextAreaElement>("character-fixed-tags").value.trim(),
    characterNegativeTags:$<HTMLTextAreaElement>("character-negative-tags").value.trim(),
    photoStyleTags:$<HTMLTextAreaElement>("photo-style-tags").value.trim(),
    drawingStyleTags:$<HTMLTextAreaElement>("drawing-style-tags").value.trim(),
    wardrobeEnabled:$<HTMLInputElement>("wardrobe-enabled").checked,
    activeOutfitId:$<HTMLSelectElement>("outfit-select").value,
    outfits,
  };
}

function slug(value:string):string{return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g,"-").replace(/^-|-$/g,"")||`outfit-${Date.now()}`}
function refreshOutfitSelect(activeId?:string):void{
  const select=$<HTMLSelectElement>("outfit-select");select.replaceChildren();
  for(const outfit of outfits){const option=document.createElement("option");option.value=outfit.id;option.textContent=outfit.name;select.appendChild(option)}
  if(activeId&&outfits.some((item)=>item.id===activeId))select.value=activeId;
  $("outfit-select-field").toggleAttribute("hidden",$<HTMLSelectElement>("visual-mode").value!=="photo"||!$<HTMLInputElement>("wardrobe-enabled").checked);
}
function renderOutfits(activeId?:string):void{
  const editor=$("outfit-editor");editor.replaceChildren();
  outfits.forEach((outfit,index)=>{
    const row=document.createElement("div");row.className="outfit-row";
    const head=document.createElement("div");head.className="outfit-row__head";
    const name=document.createElement("input");name.value=outfit.name;name.placeholder="穿搭名称";
    const remove=document.createElement("button");remove.type="button";remove.textContent="×";remove.title="删除穿搭";
    const descLabel=document.createElement("label");descLabel.textContent="说明";const desc=document.createElement("input");desc.value=outfit.description;desc.placeholder="给 Agent 理解的自然语言说明";descLabel.appendChild(desc);
    const tagsLabel=document.createElement("label");tagsLabel.textContent="Tags";const tags=document.createElement("textarea");tags.rows=2;tags.value=outfit.tags;tags.placeholder="实际注入提示词的服装 tags";tagsLabel.appendChild(tags);
    const sync=()=>{outfits[index]={...outfits[index],name:name.value.trim()||`穿搭 ${index+1}`,description:desc.value.trim(),tags:tags.value.trim()};refreshOutfitSelect($<HTMLSelectElement>("outfit-select").value)};
    name.oninput=sync;desc.oninput=sync;tags.oninput=sync;remove.onclick=()=>{outfits.splice(index,1);renderOutfits(outfits[0]?.id)};
    head.append(name,remove);row.append(head,descLabel,tagsLabel);editor.appendChild(row);
  });
  refreshOutfitSelect(activeId);
}

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
  document.querySelectorAll<HTMLElement>("[data-capability]").forEach((element)=>{
    const key=element.dataset.capability as keyof Capabilities;
    element.toggleAttribute("hidden",!caps[key]);
  });
  const mode=$<HTMLSelectElement>("reference-mode");
  for(const option of Array.from(mode.options)){
    if(option.value==="none")option.disabled=false;
    else if(option.value==="img2img")option.disabled=!caps.img2img;
    else if(option.value==="vibe")option.disabled=!caps.vibe;
    else option.disabled=!caps.directorReference;
  }
  const supported=[caps.img2img?"图生图":"",caps.vibe?"Vibe":"",caps.directorReference?"Director":""].filter(Boolean);
  $("reference-capability-hint").textContent=supported.length
    ? `当前协议支持：${supported.join("、")}。灰色选项需要切换到支持该能力的协议模板。`
    : "当前协议不支持参考图。请切换到本地 Gateway 或 NovelAI 原生兼容协议。";
  if(mode.selectedOptions[0]?.disabled)mode.value="none";
  updateReferencePanel();
}

function updateReferencePanel():void{
  const mode=$<HTMLSelectElement>("reference-mode").value;
  $("reference-picker").toggleAttribute("hidden",mode==="none");
  const info=$<HTMLInputElement>("reference-info").closest("label");
  info?.toggleAttribute("hidden",mode==="img2img");
}

function loadResultParams(item:NovelAiResult):void {
  prompt.value=item.prompt||"";model.value=item.model||model.value;
  if(item.width)$<HTMLSelectElement>("width").value=String(item.width);
  if(item.height)$<HTMLSelectElement>("height").value=String(item.height);
  if(item.steps)$<HTMLInputElement>("steps").value=String(item.steps);
  if(item.scale!==undefined)$<HTMLInputElement>("scale").value=String(item.scale);
  if(item.sampler)$<HTMLSelectElement>("sampler").value=item.sampler;
  if(item.seed!==undefined)$<HTMLInputElement>("seed").value=item.seed<0?"":String(item.seed);
  if(item.mode)$<HTMLSelectElement>("visual-mode").value=item.mode;
  negative.value=item.negativePrompt||negative.value;
  refreshOutfitSelect(item.outfitId||undefined);
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
  $("result-summary").hidden=false;
  $("result-title").textContent=item.outfitName?`${item.outfitName} · ${item.mode==="drawing"?"自由画作":"角色照片"}`:(item.mode==="drawing"?"自由画作":"角色照片");
  const chips=$("result-chips");chips.replaceChildren();
  [`${item.width||"?"}×${item.height||"?"}`,item.model,item.steps?`${item.steps} steps`:"",item.scale!==undefined?`CFG ${item.scale}`:"",item.referenceMode&&item.referenceMode!=="none"?item.referenceMode:""].filter(Boolean).forEach((text)=>{const chip=document.createElement("span");chip.textContent=String(text);chips.appendChild(chip)});
  const details=$("result-details");details.replaceChildren();
  addDetail(details,"画面描述",item.prompt);addDetail(details,"最终 Prompt",item.compiledPrompt);addDetail(details,"负面 Prompt",item.negativePrompt);
  addDetail(details,"模型",item.model);addDetail(details,"协议",item.providerMode);addDetail(details,"尺寸",`${item.width||"?"} × ${item.height||"?"}`);
  addDetail(details,"步数",item.steps);addDetail(details,"CFG",item.scale);addDetail(details,"采样器",item.sampler);addDetail(details,"种子",item.seed===-1?"随机":item.seed);
  addDetail(details,"穿搭",item.outfitName);addDetail(details,"参考模式",item.referenceMode&&item.referenceMode!=="none"?item.referenceMode:"未使用");addDetail(details,"生成时间",new Date(item.createdAt).toLocaleString());
}
function renderHistory(items:NovelAiResult[]):void {
  history.replaceChildren(); $("history-count").textContent=`${items.length} 张`;
  for(const item of items){
    const button=document.createElement("div"); button.className="history-item"; button.title=item.prompt;button.tabIndex=0;button.setAttribute("role","button");
    const img=document.createElement("img"); img.src=item.dataUrl; img.alt=item.prompt;
    const caption=document.createElement("div"); caption.textContent=item.prompt;
    const replay=document.createElement("button");replay.type="button";replay.className="history-item__replay";replay.textContent="☷";replay.title="载入这张作品的参数";
    replay.onclick=(event)=>{event.stopPropagation();loadResultParams(item);};
    button.append(img,caption,replay); button.onclick=()=>showResult(item); history.appendChild(button);
  }
}
async function refreshHistory():Promise<void>{try{const items=await window.novelai.history();renderHistory(items);if(items[0])showResult(items[0])}catch(e){console.error(e)}}

function renderTasks(tasks:ImageTask[]):void{
  const list=$("task-list");list.replaceChildren();$("task-count").textContent=`${tasks.length} 项`;
  if(!tasks.length){const empty=document.createElement("p");empty.className="task-empty";empty.textContent="暂无任务";list.appendChild(empty);return}
  const labels:Record<ImageTask["status"],string>={queued:"等待中",running:"生成中",completed:"已完成",failed:"失败",cancelled:"已取消"};
  for(const task of tasks.slice(0,8)){
    const row=document.createElement("article");row.className=`task-item task-item--${task.status}`;
    const text=document.createElement("div");const title=document.createElement("strong");title.textContent=task.prompt;const meta=document.createElement("small");meta.textContent=task.error||`${labels[task.status]} · ${new Date(task.createdAt).toLocaleTimeString()}`;text.append(title,meta);
    const action=document.createElement("button");action.type="button";
    if(task.status==="queued"||task.status==="running"){action.textContent="×";action.title="取消任务";action.onclick=()=>void window.novelai.cancelTask(task.id)}
    else if(task.status==="failed"||task.status==="cancelled"){action.textContent="↻";action.title="重试任务";action.onclick=async()=>{action.disabled=true;try{const result=await window.novelai.retryTask(task.id);showResult(result);await refreshHistory()}catch(e){setStatus(e instanceof Error?e.message:String(e),true)}finally{action.disabled=false}}}
    else{action.textContent="✓";action.disabled=true;action.title="任务已完成"}
    row.append(text,action);list.appendChild(row);
  }
}
async function refreshTasks():Promise<void>{try{renderTasks(await window.novelai.tasks())}catch(e){console.error(e)}}

function useAsset(asset:ImageAsset):void{
  referenceImageDataUrl=asset.dataUrl;$("reference-name").textContent=asset.name;const image=$<HTMLImageElement>("reference-preview");image.src=asset.dataUrl;image.hidden=false;
  const mode=$<HTMLSelectElement>("reference-mode");if(mode.value==="none"){const first=Array.from(mode.options).find((option)=>option.value!=="none"&&!option.disabled);if(first)mode.value=first.value}updateReferencePanel();setStatus(`已选择参考素材：${asset.name}`);
}
async function refreshAssets():Promise<void>{
  const assets=await window.novelai.assets();const library=$("asset-library");library.replaceChildren();$("asset-count").textContent=`${assets.length} 张`;
  if(!assets.length){const empty=document.createElement("p");empty.className="task-empty";empty.textContent="尚未导入素材";library.appendChild(empty);return}
  for(const asset of assets){const item=document.createElement("article");item.className="asset-item";item.tabIndex=0;const image=document.createElement("img");image.src=asset.dataUrl;image.alt=asset.name;const name=document.createElement("span");name.textContent=asset.name;const remove=document.createElement("button");remove.type="button";remove.textContent="×";remove.title="删除素材";remove.onclick=async(event)=>{event.stopPropagation();await window.novelai.deleteAsset(asset.id);await refreshAssets()};item.onclick=()=>useAsset(asset);item.onkeydown=(event)=>{if(event.key==="Enter"||event.key===" ")useAsset(asset)};item.append(image,name,remove);library.appendChild(item)}
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
  }catch(e){badge.textContent="连接失败";setStatus(e instanceof Error?e.message:String(e),true)}
}

async function init():Promise<void>{
  try{
    const config=await window.novelai.loadConfig(); providerMode.value=config.providerMode||"novelai-gateway";
    gateway.value=config.gatewayUrl; apiKey.value=config.apiKey; negative.value=config.defaultNegativePrompt; model.value=config.model;
    $<HTMLInputElement>("models-path").value=config.modelsPath||"/v1/models";
    $<HTMLInputElement>("generation-path").value=config.generationPath||"/v1/images/generations";
    $<HTMLInputElement>("async-result-path").value=config.asyncResultPath||"/api/get_result/{id}";
    $<HTMLInputElement>("poll-interval").value=String(config.pollIntervalMs||5000);
    $<HTMLInputElement>("character-name").value=config.characterName||"昔涟";
    $<HTMLTextAreaElement>("character-base-tags").value=config.characterBaseTags||"";
    $<HTMLTextAreaElement>("character-fixed-tags").value=config.characterFixedTags||"";
    $<HTMLTextAreaElement>("character-negative-tags").value=config.characterNegativeTags||"";
    $<HTMLTextAreaElement>("photo-style-tags").value=config.photoStyleTags||"";
    $<HTMLTextAreaElement>("drawing-style-tags").value=config.drawingStyleTags||"";
    $<HTMLInputElement>("wardrobe-enabled").checked=config.wardrobeEnabled!==false;
    outfits=Array.isArray(config.outfits)?config.outfits:[];renderOutfits(config.activeOutfitId);
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
$<HTMLSelectElement>("reference-mode").onchange=updateReferencePanel;
$("pick-reference").onclick=async()=>{const picked=await window.novelai.pickImage();if(!picked)return;referenceImageDataUrl=picked.dataUrl;$("reference-name").textContent=picked.name;const image=$<HTMLImageElement>("reference-preview");image.src=picked.dataUrl;image.hidden=false;};
$("import-asset").onclick=async()=>{const asset=await window.novelai.importAsset();if(asset){await refreshAssets();useAsset(asset)}};
$<HTMLSelectElement>("visual-mode").onchange=()=>refreshOutfitSelect($<HTMLSelectElement>("outfit-select").value);
$<HTMLInputElement>("wardrobe-enabled").onchange=()=>refreshOutfitSelect($<HTMLSelectElement>("outfit-select").value);
$("add-outfit").onclick=()=>{const name=`新穿搭 ${outfits.length+1}`;outfits.push({id:slug(name+Date.now()),name,description:"",tags:""});renderOutfits(outfits[outfits.length-1].id)};
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
    const referenceMode=$<HTMLSelectElement>("reference-mode").value;if(referenceMode!=="none"&&!referenceImageDataUrl)throw new Error("请先选择参考图片");
    const result=await window.novelai.generate({prompt:prompt.value,negativePrompt:negative.value,model:model.value,mode:$<HTMLSelectElement>("visual-mode").value,outfitId:$<HTMLSelectElement>("outfit-select").value,width:$<HTMLSelectElement>("width").value,height:$<HTMLSelectElement>("height").value,steps:$<HTMLInputElement>("steps").value,scale:$<HTMLInputElement>("scale").value,sampler:$<HTMLSelectElement>("sampler").value,seed:$<HTMLInputElement>("seed").value,referenceMode,referenceImage:referenceImageDataUrl,referenceStrength:$<HTMLInputElement>("reference-strength").value,referenceInformationExtracted:$<HTMLInputElement>("reference-info").value});
    showResult(result);await refreshHistory();setStatus("绘制完成，作品已保存。");
  }catch(e){setStatus(e instanceof Error?e.message:String(e),true)}finally{button.disabled=false}
};
void init();
window.novelai.onTasksChanged((tasks)=>{renderTasks(tasks);window.clearTimeout(taskRefreshTimer);taskRefreshTimer=window.setTimeout(()=>void refreshHistory(),250)});
export {};
