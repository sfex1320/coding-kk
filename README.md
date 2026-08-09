# coding kk

**AI 编程工具状态监控伴侣** —— 电脑上跑着 Claude Code / Codex / ZCode 干活，人却不用守在屏幕前：手机、平板变成实时状态副屏，任务完成自动微信 / 邮件推送提醒，还能语音播报。

> 又名 CodeStatus Companion。免安装、纯本地、开源。

## ✨ 能做什么

| 功能 | 说明 |
| --- | --- |
| 🖥️ 实时监控 | 监控 Claude Code、Codex、ZCode、VS Code / Cursor 及 Kimi Code、Cline 等 AI 编码工具的工作状态（思考中 / 写代码 / 跑命令 / 等待授权 / 完成 / 出错） |
| ⚡ 秒级响应 | 进程扫描 2 秒一轮，软件启动后 **2 秒内** 出现在面板；状态变化立即上报，无延迟 |
| 🧰 通用采集 | 打开即自动监控 ComfyUI / Ollama / OpenCode / Kimi 桌面版 / ZCode / PyCharm / Windsurf 等 24+ 工具（采集器内嵌，无需单独启动）|
| 🔌 插件保活 | VS Code / Cursor 扩展 15 秒心跳保活，Agent 后启动也能自动发现；Kimi Code 写代码活动通过 baseline 监听精准捕捉 |
| 📱 手机副屏 | 手机扫码配对后变成状态屏：像素小人 + 实时事件时间线，支持 OLED 纯黑常驻展示 |
| 📨 消息推送 | 任务完成 / 失败 / 等待授权时，推送到微信（Server酱 / PushPlus）或邮箱，人不在电脑前也能及时知道 |
| 🔊 语音播报 | 可自定义哪些状态要播报；同一状态只报一次不刷屏；本地神经网络音色优先（可靠、重启不丢失），可按软件单独配音色音量；另有「在线 HD」开关 |
| 📌 托盘常驻 | 后台托盘图标（橙色圆角方块 + 心跳波形），右键「打开软件页面」/「退出软件」；干净退出不留残留进程 |
| 🔧 Hook 引导 | 面板内置「监控增强」：一键安装 / 检测 Claude Code、Codex 的 CLI Hook |
| 🔒 纯本地 | 所有数据只在你的电脑和局域网内流转，配对 token 鉴权 + 设备管理 + 隐私模式（隐藏路径与代码细节） |

## 🚀 快速开始（普通用户）

1. 到 [Releases](../../releases) 下载：
   - **电脑端**：`coding-kk-windows.zip` → 解压 → 双击 `CodeStatus-Monitor.exe`（免装 Node，自动打开浏览器面板，右下角出现托盘图标）
   - **安卓端**（可选）：`coding-kk-android.apk` → 传到手机安装；也可以不装 App，直接用手机浏览器扫码
2. 手机和电脑连**同一个 Wi-Fi**，用系统相机扫电脑面板上「局域网配对」的二维码（微信扫码打不开是正常的，请用相机或浏览器扫一扫）
3. 手机连不上时，先双击解压目录里的 `允许防火墙.cmd` 放行端口
4. 想要微信 / 邮件提醒：在电脑面板「手机消息推送」里选渠道、填 key，点「发送测试消息」验证：
   - **Server酱**：打开 [sct.ftqq.com](https://sct.ftqq.com) 微信扫码登录 → 复制 SendKey
   - **PushPlus**：打开 [pushplus.plus](https://www.pushplus.plus) 微信扫码登录 → 复制 Token
   - **邮件**：填 SMTP 服务器和授权码（QQ 邮箱：设置 → 账号 → 开启 SMTP 服务）

监控是自动的：程序启动后即监听 `~/.claude/projects/` 与 `~/.codex/sessions/` 的会话日志，Claude Code / Codex 一干活就能看到状态；同时内嵌采集器自动监控 ZCode / ComfyUI / Ollama / OpenCode / Kimi 桌面版 / PyCharm 等工具。

> 想退出：右键托盘图标 →「退出软件」。想重开页面：右键托盘图标 →「打开软件页面」。

### 语音播报设置

打开面板中的「语音播报」区域，可以：
- **选择播报状态**：勾选哪些状态需要播报（默认只报：开始思考 / 已完成 / 出现问题 / 等待授权 / 等待输入；写代码 / 运行命令等中间过程默认关闭）
- 同一状态只播报一次，状态变化后才再报（不会反复说"正在写代码"）
- 设置会自动保存，关闭重开不丢失

### Hook 安装引导

面板中的「监控增强」区域支持一键安装 Claude Code / Codex 的 CLI Hook，安装后可获得更精准的实时事件（工具调用、权限请求等）。不安装也能通过进程检测监控，Hook 只是锦上添花。

## 🛠️ 开发者

```powershell
npm install
npm run dev          # Web 面板 http://127.0.0.1:5173 · Agent http://127.0.0.1:4317
npm run package:apps # 构建单文件 EXE + 整理 APP/ 成品目录
```

- 技术栈：Node.js（零框架 HTTP/WS 服务）+ React 19 + Vite；EXE 用 Node SEA 单文件打包；安卓端 Expo/React Native
- 目录：`server/` 本地 Agent（事件归一化、日志监听、推送、TTS、Hook 安装）· `src/` Web 面板 · `adapters/` hooks 适配器 + 桌面采集器 · `extensions/vscode/` 编辑器扩展（心跳保活 + AI 写入归因）· `apps/` 移动端
- 第三方状态源接入协议见 [docs/adapter-event-protocol.md](docs/adapter-event-protocol.md)（POST 一个 JSON 即可上报状态）

## 📋 更新日志

### v0.5.0
- ⚡ **监测延迟优化**：进程扫描 4s→2s，新启动软件 2 秒内出现在面板
- 🔌 **插件保活**：VS Code 扩展 15 秒心跳，解决 Agent 后启动时收不到事件
- 🎯 **Kimi Code 精准监控**：通过 baseline 文件变化检测写代码活动
- 🆕 **新增指纹**：Claude Code、Codex、ZCode（共 24+ 工具）
- 🔊 **播报改进**：同一状态只报一次不刷屏；可自定义播报状态
- 🎨 **托盘图标优化**：橙色圆角方块 + 白色心跳波形
- 🔧 **Hook 安装引导**：面板内置一键安装 + 状态检测
- 📱 移动端播报开关持久化

## 📄 License

MIT
