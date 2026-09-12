import { app } from "electron";
import * as fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { QqInstance, QqInstanceRequest, QqInstanceStatus } from "../../shared/qq-instance";
import { SnowLumaRuntime, SNOWLUMA_VERSION, freeLoopbackPort } from "./snowluma-runtime";
import { loadChannelsSettings, saveChannelsSettings } from "./settings-store";
import { ONEBOT_WS_PATH } from "./adapters/qq/onebot-reverse-ws";

let runtime: SnowLumaRuntime | undefined;
let phase: QqInstanceStatus["phase"] = "stopped";
let message = "已停止";
let busy = false;
export const qqInstanceRoot = () => path.join(app.getPath("userData"), "integrations", "qq-instance");
const manifest = () => path.join(qqInstanceRoot(), "instance.json");
export function readQqInstance(): QqInstance | null {
  if (!fs.existsSync(manifest())) return null;
  const value = JSON.parse(fs.readFileSync(manifest(), "utf8"));
  if (!value || !["snowluma", "napcat"].includes(value.backend) || !/^[1-9]\d{4,9}$/.test(value.accountId)) {
    throw new Error("QQ 实例配置损坏，请检查实例目录");
  }
  return { backend: value.backend, accountId: value.accountId, autoStart: value.autoStart === true };
}
export function getSnowLumaRuntime(): SnowLumaRuntime {
  return runtime ??= new SnowLumaRuntime(path.join(qqInstanceRoot(), "snowluma"), (msg, failed) => {
    message = msg;
    if (failed) phase = "error";
  });
}
export function setQqInstancePhase(value: QqInstanceStatus["phase"], text: string): void { phase = value; message = text; }
export function qqInstanceStatus(): QqInstanceStatus {
  const instance = readQqInstance();
  return { instance, phase: busy && phase === "installing" ? phase : instance ? phase : "absent", message,
    webuiUrl: runtime?.webuiUrl,
    onebotUrl: instance?.backend === "snowluma" ? `ws://127.0.0.1:${loadChannelsSettings().qq.port}${ONEBOT_WS_PATH}` : undefined,
    root: qqInstanceRoot(), version: instance?.backend === "snowluma" ? SNOWLUMA_VERSION : undefined };
}
export async function withQqInstanceOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (busy) throw new Error("QQ 实例操作进行中，请稍候");
  busy = true;
  try { return await operation(); }
  catch (error) { phase = "error"; message = error instanceof Error ? error.message : "QQ 实例操作失败"; throw error; }
  finally { busy = false; }
}
function persist(instance: QqInstance): void {
  fs.mkdirSync(qqInstanceRoot(), { recursive: true });
  fs.writeFileSync(manifest() + ".tmp", JSON.stringify(instance, null, 2));
  fs.renameSync(manifest() + ".tmp", manifest());
}
export async function createQqInstance(request: QqInstanceRequest): Promise<void> {
  if (readQqInstance()) throw new Error("只允许一个 QQ 实例，请先删除现有实例");
  if (!request.accountId || !/^[1-9]\d{4,9}$/.test(request.accountId)) throw new Error("请输入有效机器人 QQ 号（5 至 10 位）");
  if (request.backend !== "napcat" && request.backend !== "snowluma") throw new Error("请选择 QQ 后端");
  if (loadChannelsSettings().qq.enabled) throw new Error("请先停止现有 QQ 渠道，再创建受管实例");
  phase = "installing"; message = "正在创建 QQ 实例";
  if (request.backend === "snowluma") {
    const root = path.join(qqInstanceRoot(), "snowluma");
    // Kept data must never be silently assigned to another account.
    if (fs.existsSync(path.join(root, "runtime"))) throw new Error("存在保留的 SnowLuma 数据；请先清除实例数据再创建");
    await getSnowLumaRuntime().install();
  }
  const config = loadChannelsSettings().qq;
  saveChannelsSettings({ qq: { ...config, enabled: false,
    listenMode: "loopback", port: await freeLoopbackPort(), accessToken: randomBytes(32).toString("hex"),
    allowedPrivateUserIds: [], allowedGroupIds: [], groupRequireMention: true,
    blockedUserIds: [], blockedGroupIds: [],
  } });
  persist({ backend: request.backend, accountId: request.accountId, autoStart: false });
  phase = "stopped"; message = request.backend === "snowluma" ? "实例已创建：未拉黑的消息默认放行，群聊仍需 @；可配置黑名单后启动" : "实例已创建，请添加白名单后启动";
}
export function configureQqInstance(autoStart: boolean): void {
  const instance = readQqInstance();
  if (!instance) throw new Error("尚未创建实例");
  persist({ ...instance, autoStart });
}
export async function deleteQqInstance(removeData: boolean): Promise<void> {
  await getSnowLumaRuntime().stop();
  const root = qqInstanceRoot();
  if (removeData) await fs.promises.rm(root, { recursive: true, force: true });
  else await fs.promises.rm(manifest(), { force: true });
  runtime = undefined; phase = "absent"; message = removeData ? "实例及数据已删除" : "实例已删除，数据仍保留在实例目录";
}
