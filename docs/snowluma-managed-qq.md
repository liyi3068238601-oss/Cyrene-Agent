# SnowLuma 受管 QQ 接入

## 使用

设置 → 渠道分别显示 QQ（SnowLuma）与 QQ（NapCat）两张卡片，使用教程默认折叠。两者共用唯一 QQ 接入槽，不能同时启用。

SnowLuma 卡片输入机器人 QQ 号后创建实例，会下载官方 Windows x64 完整包，校验固定 SHA-256 后安装。首版固定 v1.14.15，不自动追随上游更新；不在 Cyrene 仓库或安装包内再分发 SnowLuma 二进制。创建时默认关闭自动启动。

SnowLuma 使用用户/群黑名单：
- 空黑名单默认允许所有私聊；群聊仍必须 @ 机器人。
- 用户黑名单屏蔽该用户的私聊及群内消息；群黑名单屏蔽整个群。
- 保存黑名单即时生效，不重启 SL。
- NapCat 仍使用白名单，空白名单不回复。旧版 SL 白名单不转换成黑名单，也不再限制 SL 消息。

启动时自动为绑定账号写入完整反向 WebSocket 地址 `ws://127.0.0.1:<实例端口>/onebot/v11/ws` 和 Token，无需用户手填。OneBot 端口/Token 在创建时持久化；WebUI 首次分配端口后保存到 runtime.json 并复用，已有首版实例沿用其已保存的端口。端口冲突明确报错，不偷偷换地址或终止其他程序。SL 自身若回退到别的端口，受管启动也会停止并报错。

WebUI 就绪后点击“打开 WebUI”。首次用户名为 admin，凭据保存在实例目录 `snowluma/webui-initial-credentials.txt`，不进入状态 IPC 或普通日志；该文件为敏感明文，改密后应删除。固定 WebUI 地址并不代表永不重新登录，会话有效期由 SL 自身管理。OneBot Token 与 WebUI 登录密码是不同凭据。

在官方 WebUI 阅读并确认协议，再手动选择专用 QQ 进程进行 Hook。Cyrene 不自动同意协议、不自动扫描注入现有 QQ。连接成功不代表 QQ Hook 已正常捕获消息；无回复时检查登录、Hook、黑名单、群 @ 和模型配置，勿用机器人账号给自己发消息。

## 生命周期与数据边界

- 最多一个受管实例，绑定一个机器人 QQ；已有非受管 QQ 渠道需先停用再创建。
- 握手核对 get_login_info.user_id、绑定账号与 X-Self-ID，入站逐条校验 self_id。这是防止误接入，不是对恶意后端的身份认证。
- 受管会话历史键包含机器人账号；不把旧非受管历史迁入新账号。旧请求尚未完成时拒绝启动新连接，避免跨账号回包。
- SL 的 OneBot/WebUI 只监听回环地址；受管模式禁止 UI 修改监听端口和 Token。外部 NapCat 保留原监听模式。
- 全局 OneBot 配置为禁用连接，只为绑定账号生成启用配置。每次启动关闭自动 Hook，忽略继承的 SNOWLUMA_* 环境变量。
- “随 Cyrene 启动”还要求 QQ 渠道启用。关闭至托盘不等于退出；真正退出或父进程控制管道断开时，guardian 回收其启动的 SL 进程树，不按名称批量杀进程。
- 停止 SL 不保证卸载已注入现有 QQ 的 Hook；需要时先在 WebUI 卸载。删除实例也不删除 Cyrene 对话、个人记忆及渠道消息日志。
- **黑名单默认放行并非多租户权限隔离。** 群聊共享个人记忆但禁用工具；私聊工具权限沿用全局渠道配置。请使用专用机器人并了解此边界。

受管目录为 `app.getPath('userData')/integrations/qq-instance/`：

```text
instance.json
snowluma/
  runtime/                    官方包、config、logs、SL 运行数据
    cyrene-installation.json  来源、版本、SHA-256
  environment/                独立 home、temp、appdata、localappdata
  snowluma-guardian.cjs        应用内复制出的管理入口，兼容 ASAR
  webui-initial-credentials.txt
```

安装临时目录也在实例内，正常结束或失败都会清理；强制结束可能留下 staging-*，可随实例清理删除。仅删除绑定并保留数据时，禁止把旧 SL 安装分配给新账号；无实例时仍可勾选清理数据再删除。

与正式版并行开发时应自行配置隔离启动入口，将 userData、缓存、日志、TEMP 指向开发目录；本 PR 不包含个人开发脚本。QQ 客户端、默认外部浏览器和 Windows 自身数据不受此隔离控制，不能承诺整台电脑零写入其他磁盘。Docker 非必需，也不会自动隔离 Windows QQ Hook。

## 验证与首版限制

在隔离 TEMP/npm cache 环境运行：

```powershell
npx vitest run src/main/channels src/renderer/settings/channels/qq-instance-panel.test.ts
npm run build
node scripts/verify/snowluma-smoke.cjs
```

测试包括实例单例、操作锁、安装失败重试、数据保留/清理、SL 黑名单与 NapCat 白名单、账号隔离、生成的 URL 对接真实 WebSocket 监听器、固定 WebUI 端口及冲突、两张卡片和折叠教程、黑名单免重启保存、guardian 进程回收。smoke 使用假 Node 服务，不启动真实 SL/QQ，验证受管路径、凭据、配置和跨重启地址稳定。

解压使用 yauzl 3.4.0，拒绝路径穿越、Windows 设备名、符号链接和超限包，下载先校验 SHA-256。已核对 SL 1.14.15 OneBot 流接口声明，使用其版本门槛而非 NapCat 的 4.8.115。

真实 QQ/Hook 的文字、图片、语音、大文件完整收发与安装包 E2E 仍待验收。首版没有自动升级、回滚、实例导入或自动卸载 Hook。

不复制 MoFox AGPL 代码；仅参考其受管安装与生命周期交互。个人数据、凭据、SL 二进制和开发绝对路径不可提交。公开发行前仍需确认 SnowLuma 许可及上游接入政策。

参考：[SnowLuma v1.14.15](https://github.com/SnowLuma/SnowLuma/releases/tag/v1.14.15)、[yauzl](https://github.com/thejoshwolfe/yauzl)。
