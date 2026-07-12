import { describe, expect, it } from "vitest";
import { ImageTaskQueue } from "./task-queue";

describe("ImageTaskQueue", () => {
  it("runs jobs serially and keeps their status", async () => {
    const order:string[]=[];
    const queue=new ImageTaskQueue(async(input)=>{order.push(`start:${input.prompt}`);await Promise.resolve();order.push(`end:${input.prompt}`);return{id:String(input.prompt)}},()=>{});
    const first=queue.enqueue({prompt:"one"});const second=queue.enqueue({prompt:"two"});
    await Promise.all([first,second]);
    expect(order).toEqual(["start:one","end:one","start:two","end:two"]);
    expect(queue.list().every((task)=>task.status==="completed")).toBe(true);
  });

  it("cancels a queued job", async () => {
    let release!:()=>void;
    const queue=new ImageTaskQueue(async(input)=>{if(input.prompt==="one")await new Promise<void>((resolve)=>{release=resolve});return{id:"ok"}},()=>{});
    const first=queue.enqueue({prompt:"one"});const second=queue.enqueue({prompt:"two"});
    const secondId=queue.list().find((task)=>task.prompt==="two")!.id;
    expect(queue.cancel(secondId)).toBe(true);
    await expect(second).rejects.toThrow("已取消");release();await first;
    expect(queue.list().find((task)=>task.id===secondId)?.status).toBe("cancelled");
  });
});
