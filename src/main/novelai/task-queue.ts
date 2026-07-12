export type ImageTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ImageTask {
  id: string;
  status: ImageTaskStatus;
  prompt: string;
  input: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  resultId?: string;
}

interface Deferred {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export class ImageTaskQueue {
  private tasks: ImageTask[] = [];
  private deferred = new Map<string, Deferred>();
  private processing = false;

  constructor(
    private readonly run: (input: Record<string, unknown>, isCancelled: () => boolean) => Promise<Record<string, unknown>>,
    private readonly changed: (tasks: ImageTask[]) => void,
  ) {}

  list(): ImageTask[] { return this.tasks.map((task) => ({ ...task, input: { ...task.input } })); }

  enqueue(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const task: ImageTask = {
      id: `task-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      status: "queued",
      prompt: String(input.prompt || "未命名绘图"),
      input: { ...input },
      createdAt: new Date().toISOString(),
    };
    this.tasks.unshift(task);
    this.trim();
    this.emit();
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => this.deferred.set(task.id, { resolve, reject }));
    void this.process();
    return promise;
  }

  cancel(id: string): boolean {
    const task = this.tasks.find((item) => item.id === id);
    if (!task || !["queued", "running"].includes(task.status)) return false;
    task.status = "cancelled";
    task.finishedAt = new Date().toISOString();
    this.deferred.get(id)?.reject(new Error("绘图任务已取消"));
    this.deferred.delete(id);
    this.emit();
    return true;
  }

  retry(id: string): Promise<Record<string, unknown>> {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) return Promise.reject(new Error("未找到绘图任务"));
    return this.enqueue(task.input);
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (true) {
        const task = [...this.tasks].reverse().find((item) => item.status === "queued");
        if (!task) break;
        task.status = "running"; task.startedAt = new Date().toISOString(); this.emit();
        try {
          const result = await this.run(task.input, () => this.isCancelled(task));
          if (this.isCancelled(task)) continue;
          task.status = "completed"; task.resultId = String(result.id || ""); task.finishedAt = new Date().toISOString();
          this.deferred.get(task.id)?.resolve(result);
        } catch (error) {
          if (!this.isCancelled(task)) {
            task.status = "failed"; task.error = error instanceof Error ? error.message : String(error); task.finishedAt = new Date().toISOString();
            this.deferred.get(task.id)?.reject(error instanceof Error ? error : new Error(String(error)));
          }
        } finally { this.deferred.delete(task.id); this.emit(); }
      }
    } finally { this.processing = false; }
  }

  private trim(): void { if (this.tasks.length > 50) this.tasks.length = 50; }
  private isCancelled(task: ImageTask): boolean { return task.status === "cancelled"; }
  private emit(): void { this.changed(this.list()); }
}
