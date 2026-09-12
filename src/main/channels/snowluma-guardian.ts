// Executed with SnowLuma's bundled Node, never imported into Electron.
// Closing Electron's stdin pipe also closes the owned runtime after a crash.
import { spawn } from "node:child_process";

if (require.main === module) {
  const child = spawn(process.execPath, ["index.mjs"], {
    cwd: process.cwd(), env: process.env, shell: false, windowsHide: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  let stopping = false;
  const stop = () => {
    if (stopping || !child.pid) return;
    stopping = true;
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, shell: false, stdio: "ignore",
      });
      killer.on("error", () => child.kill());
    } else child.kill("SIGTERM");
  };
  process.stdin.resume();
  process.stdin.on("end", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  child.on("error", () => process.exit(1));
  child.on("exit", code => process.exit(code ?? 0));
}
