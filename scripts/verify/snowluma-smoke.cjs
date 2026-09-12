// Build main first. Tests the actual supervisor against a fake runtime, never QQ.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SnowLumaRuntime } = require('../../dist/main/main/channels/snowluma-runtime.js');

(async () => {
  if (process.platform !== 'win32') throw new Error('Windows-only smoke');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrene-sl-smoke-'));
  const cwd = path.join(root, 'runtime');
  const runtime = new SnowLumaRuntime(root, () => {});
  try {
    await fs.mkdir(cwd);
    await fs.copyFile(process.execPath, path.join(cwd, 'node.exe'));
    await fs.writeFile(path.join(cwd, 'index.mjs'), `
      import fs from 'node:fs';
      fs.writeFileSync('smoke.json', JSON.stringify({pid: process.pid, home: process.env.USERPROFILE, temp: process.env.TEMP, logs: process.env.SNOWLUMA_LOG_DIR, hook: process.env.SNOWLUMA_HOOK_AUTOLOAD}));
      console.log('initial credentials: user=admin password=0123456789abcdef');
      console.log('listening http://127.0.0.1:' + process.env.SNOWLUMA_WEBUI_PORT);
      setInterval(() => {}, 1000);
    `);
    await runtime.start('123456', 16200, 'fake-token');
    assert.match(runtime.webuiUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const state = JSON.parse(await fs.readFile(path.join(cwd, 'smoke.json'), 'utf8'));
    for (const key of ['home', 'temp', 'logs']) assert.ok(state[key].startsWith(root + path.sep));
    assert.equal(state.hook, '0');
    const globalConfig = JSON.parse(await fs.readFile(path.join(cwd, 'config/onebot.json'), 'utf8'));
    assert.equal(globalConfig.networks.wsClients[0].enabled, false);
    const accountConfig = JSON.parse(await fs.readFile(path.join(cwd, 'config/onebot_123456.json'), 'utf8'));
    assert.equal(accountConfig.networks.wsClients[0].accessToken, 'fake-token');
    assert.equal(accountConfig.networks.wsClients[0].url, 'ws://127.0.0.1:16200/onebot/v11/ws');
    assert.match(await fs.readFile(path.join(root, 'webui-initial-credentials.txt'), 'utf8'), /Username: admin/);
    const firstUrl = runtime.webuiUrl;
    await runtime.stop();
    assert.throws(() => process.kill(state.pid, 0));
    assert.equal(runtime.webuiUrl, undefined);
    await runtime.start('123456', 16200, 'fake-token');
    assert.equal(runtime.webuiUrl, firstUrl);
    await runtime.stop();
    console.log('SNOWLUMA_SMOKE_OK: paths, config, credentials, supervisor shutdown; no QQ loaded');
  } finally {
    await runtime.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
