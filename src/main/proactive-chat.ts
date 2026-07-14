import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

export interface ProactiveChatConfig { enabled:boolean; idleMinutes:number; cooldownMinutes:number }
export interface ProactiveChatSnapshot { now:number; hour:number; lastConversationAt:number; lastSentAt:number }

const TICK_MS=60_000;
let timer:ReturnType<typeof setInterval>|null=null;
let running=false;

export function shouldSendProactiveChat(config:ProactiveChatConfig,snapshot:ProactiveChatSnapshot):boolean{
  if(!config.enabled||running)return false;
  if(snapshot.hour<8||snapshot.hour>=23)return false;
  const idleMs=Math.max(5,config.idleMinutes)*60_000;
  const cooldownMs=Math.max(15,config.cooldownMinutes)*60_000;
  if(snapshot.now-snapshot.lastConversationAt<idleMs)return false;
  if(snapshot.now-snapshot.lastSentAt<cooldownMs)return false;
  return true;
}

function statePath():string{return path.join(app.getPath("userData"),"proactive-chat-state.json")}
export function loadLastSentAt():number{try{return Number(JSON.parse(fs.readFileSync(statePath(),"utf8"))?.lastSentAt)||0}catch{return 0}}
export function saveLastSentAt(lastSentAt:number):void{try{fs.writeFileSync(statePath(),JSON.stringify({lastSentAt},null,2),"utf8")}catch(error){console.warn("[ProactiveChat] 保存状态失败",error)}}

export function startProactiveChat(getConfig:()=>ProactiveChatConfig,getLastConversationAt:()=>number,onTrigger:()=>Promise<boolean|void>):void{
  stopProactiveChat();
  const tick=async()=>{const config=getConfig(),now=Date.now();if(!shouldSendProactiveChat(config,{now,hour:new Date(now).getHours(),lastConversationAt:getLastConversationAt(),lastSentAt:loadLastSentAt()}))return;running=true;try{const sent=await onTrigger();if(sent!==false)saveLastSentAt(now)}catch(error){console.warn("[ProactiveChat] 主动消息生成失败",error)}finally{running=false}};
  timer=setInterval(()=>void tick(),TICK_MS);
}

export function stopProactiveChat():void{if(timer){clearInterval(timer);timer=null}running=false}
