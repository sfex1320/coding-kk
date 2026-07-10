# coding kk

**AI 编程工具状态监控伴侣** —— 电脑上跑着 Claude Code / Codex 干活，人却不用守在屏幕前：手机、平板变成实时状态副屏，任务完成自动微信 / 邮件推送提醒，还能语音播报。

> 又名 CodeStatus Companion。免安装、纯本地、开源。

## ✨ 能做什么

| 功能 | 说明 |
| --- | --- |
| 🖥️ 实时监控 | 监控 Claude Code、Codex、VS Code / Cursor 及 Cline、Kimi Code 等 AI 编码工具的工作状态（思考中 / 写代码 / 跑命令 / 等待授权 / 完成 / 出错） |
| 📱 手机副屏 | 手机扫码配对后变成状态屏：像素小人 + 实时事件时间线，支持 OLED 纯黑常驻展示 |
| 📨 消息推送 | 任务完成 / 失败 / 等待授权时，推送到微信（Server酱 / PushPlus）或邮箱，人不在电脑前也能及时知道 |
| 🔊 语音播报 | 状态变化用自然人声播报（微软 Edge 神经语音，10 种音色，免密钥），支持语音问答"现在在做什么？" |
| 🔌 双通道监控 | CLI hooks + 本地会话日志监听双通道，**VS Code 插件版的 Claude Code / Codex 也能监控**，无需安装 CLI |
| 🔒 纯本地 | 所有数据只在你的电脑和局域网内流转，配对 token 鉴权 + 设备管理 + 隐私模式（隐藏路径与代码细节） |

## 🚀 快速开始（普通用户）

1. 到 [Releases](../../releases) 下载：
   - **电脑端**：`coding-kk-windows.zip` → 解压 → 双击 `CodeStatus-Monitor.exe`（免装 Node，自动打开浏览器面板）
   - **安卓端**（可选）：`coding-kk-android.apk` → 传到手机安装；也可以不装 App，直接用手机浏览器扫码
2. 手机和电脑连**同一个 Wi-Fi**，用系统相机扫电脑面板上「局域网配对」的二维码（微信扫码打不开是正常的，请用相机或浏览器扫一扫）
3. 手机连不上时，先双击解压目录里的 `允许防火墙.cmd` 放行端口
4. 想要微信 / 邮件提醒：在电脑面板「手机消息推送」里选渠道、填 key，点「发送测试消息」验证：
   - **Server酱**：打开 [sct.ftqq.com](https://sct.ftqq.com) 微信扫码登录 → 复制 SendKey
   - **PushPlus**：打开 [pushplus.plus](https://www.pushplus.plus) 微信扫码登录 → 复制 Token
   - **邮件**：填 SMTP 服务器和授权码（QQ 邮箱：设置 → 账号 → 开启 SMTP 服务）

监控是自动的：程序启动后即监听 `~/.claude/projects/` 与 `~/.codex/sessions/` 的会话日志，Claude Code / Codex 一干活就能看到状态。想要更细的事件，可另外双击 `安装ClaudeCode监控.cmd` / `安装Codex监控.cmd` 安装 hooks，并用 `安装VSCode扩展.cmd` 接入编辑器层监控。

## 🛠️ 开发者

```powershell
npm install
npm run dev          # Web 面板 http://127.0.0.1:5173 · Agent http://127.0.0.1:4317
npm run package:apps # 构建单文件 EXE + 整理 APP/ 成品目录
```

- 技术栈：Node.js（零框架 HTTP/WS 服务）+ React 19 + Vite；EXE 用 Node SEA 单文件打包；安卓端 Expo/React Native
- 目录：`server/` 本地 Agent（事件归一化、日志监听、推送、TTS）· `src/` Web 面板 · `adapters/` hooks 适配器 · `extensions/vscode/` 编辑器扩展 · `apps/` 移动端
- 第三方状态源接入协议见 [docs/adapter-event-protocol.md](docs/adapter-event-protocol.md)（POST 一个 JSON 即可上报状态）

## 📄 License

MIT
