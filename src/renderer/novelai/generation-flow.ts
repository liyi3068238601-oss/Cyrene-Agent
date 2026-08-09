import { reportCreateStatus, setActivityDrawer } from "./ui-state";

interface GenerationFlowOptions<TSelection, TResult> {
  getSelectedResult(): TSelection | null;
  loadResultParams(result: TSelection): void;
  validateAndPrepare(): Promise<void>;
  persistSettings(): Promise<void>;
  generate(): Promise<TResult>;
  onGenerated(result: TResult): Promise<void> | void;
  root?: ParentNode;
}

const activeBindings = new WeakMap<ParentNode, () => void>();

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function bindGenerationFlow<TSelection, TResult>(options: GenerationFlowOptions<TSelection, TResult>): () => void {
  const root = options.root || document;
  activeBindings.get(root)?.();
  const generateButton = root.querySelector<HTMLButtonElement>("#generate");
  const redrawButton = root.querySelector<HTMLButtonElement>("#load-result-params");
  if (!generateButton || !redrawButton) return () => undefined;

  const setDisabled = (disabled: boolean) => {
    generateButton.disabled = disabled;
    redrawButton.disabled = disabled;
  };
  const submit = async () => {
    setDisabled(true);
    try {
      try {
        await options.validateAndPrepare();
      } catch (error) {
        reportCreateStatus(errorMessage(error, "绘图设置有误，请检查后重试。"), true, undefined, root);
        return;
      }

      try {
        await options.persistSettings();
      } catch (error) {
        reportCreateStatus("绘图设置保存失败，请检查本机配置后重试。", true, error, root);
        return;
      }

      reportCreateStatus("正在提交绘图任务，请稍候...", false, undefined, root);
      let result: TResult;
      try {
        result = await options.generate();
      } catch (error) {
        reportCreateStatus("绘图提交失败，请检查设置后重试。", true, error, root);
        setActivityDrawer(true, root);
        return;
      }
      await options.onGenerated(result);
    } finally {
      setDisabled(false);
    }
  };
  const generateClick = () => { void submit(); };
  const redrawClick = () => {
    const selected = options.getSelectedResult();
    if (!selected) return;
    options.loadResultParams(selected);
    void submit();
  };
  generateButton.addEventListener("click", generateClick);
  redrawButton.addEventListener("click", redrawClick);
  const cleanup = () => {
    generateButton.removeEventListener("click", generateClick);
    redrawButton.removeEventListener("click", redrawClick);
    if (activeBindings.get(root) === cleanup) activeBindings.delete(root);
  };
  activeBindings.set(root, cleanup);
  return cleanup;
}
