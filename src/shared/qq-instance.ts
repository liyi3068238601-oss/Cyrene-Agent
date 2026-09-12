export type QqBackend = "napcat" | "snowluma";
export interface QqInstance {
  backend: QqBackend;
  accountId: string;
  autoStart: boolean;
}
export type QqInstanceAction = "status" | "create" | "start" | "stop" | "restart" | "delete" | "open" | "configure";
export interface QqInstanceRequest {
  action: QqInstanceAction;
  backend?: QqBackend;
  accountId?: string;
  autoStart?: boolean;
  removeData?: boolean;
}
export interface QqInstanceStatus {
  instance: QqInstance | null;
  phase: "absent" | "installing" | "stopped" | "starting" | "running" | "error";
  message: string;
  webuiUrl?: string;
  onebotUrl?: string;
  root: string;
  version?: string;
}
