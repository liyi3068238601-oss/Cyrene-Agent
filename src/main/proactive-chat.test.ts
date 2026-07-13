import {describe,expect,it} from "vitest";
import {shouldSendProactiveChat} from "./proactive-chat";

describe("proactive chat policy",()=>{
  const config={enabled:true,idleMinutes:30,cooldownMinutes:180};
  it("fires after idle and cooldown during daytime",()=>{const now=new Date(2026,6,13,14).getTime();expect(shouldSendProactiveChat(config,{now,hour:14,lastConversationAt:now-31*60_000,lastSentAt:now-181*60_000})).toBe(true)});
  it("respects quiet hours and recent conversation",()=>{const now=Date.now();expect(shouldSendProactiveChat(config,{now,hour:23,lastConversationAt:0,lastSentAt:0})).toBe(false);expect(shouldSendProactiveChat(config,{now,hour:14,lastConversationAt:now-5*60_000,lastSentAt:0})).toBe(false)});
});
