# CodeStatus Companion 原型快速启动

## 1. 启动

```powershell
npm install
npm run dev
```

默认端口：

- Web 面板：`http://127.0.0.1:5173`
- 本地 Agent：`http://127.0.0.1:4317`
- WebSocket：`ws://127.0.0.1:4317/ws`

全屏状态屏：

```text
http://127.0.0.1:5173?display=1
```

这个入口先进入浅色 APP 基础页。点击像素小人后进入常驻展示第二页面：纯黑背景、放大像素小人、实时状态日志，并可进入浏览器全屏。

手机在同一局域网时，可以打开 Vite 输出里的 `Network` 地址，例如：

```text
http://192.168.x.x:5173
```

## 2. 接入 Claude Code

安装全局 Claude Code hooks：

```powershell
npm run install:claude-hooks
```

这个命令会合并写入：

```text
%USERPROFILE%\.claude\settings.json
```

并自动备份原文件。安装后，Claude Code 的所有项目都会把状态事件转发到本地 Agent。

建议在 Claude Code 里验证：

```text
/hooks
```

确认 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`Notification`、`Stop` 等事件有 hook。也可以用：

```text
/status
```

确认 User settings 被读取。

如果 Claude Code 已经在运行，官方说明 hooks/settings 通常会自动 reload；如果你没有看到状态变化，重启当前 Claude Code 会话再试一次。

## 3. 模拟事件

页面右侧“模拟状态”按钮会向 Agent 发送事件。

也可以用 PowerShell 直接 POST：

```powershell
Invoke-RestMethod `
  -Uri http://127.0.0.1:4317/events `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"source":"claude-code","state":"writing_code","title":"Claude Code 正在写代码","message":"正在修改 src/App.jsx","workspace":"G:/Project/demo"}'
```

查看当前状态：

```powershell
Invoke-RestMethod http://127.0.0.1:4317/api/status
```

## 4. Claude Code Hook 转发脚本

本仓库提供了一个 hook 转发脚本：

```text
adapters/claude-code-hook.mjs
```

它会读取 Claude Code 传入的 hook JSON，并转发到：

```text
http://127.0.0.1:4317/events
```

如果需要改 Agent 地址：

```powershell
$env:CODESTATUS_AGENT_URL="http://127.0.0.1:4317/events"
```

Claude Code hook command 示例：

```powershell
node "G:\Project\coding KK\adapters\claude-code-hook.mjs"
```

建议先绑定这些事件：

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`
- `Notification`
- `Stop`
- `StopFailure`
- `SessionEnd`

Agent 已经内置了 Claude Code 事件到标准状态的基础映射。通常直接运行 `npm run install:claude-hooks` 即可，不需要手动编辑。

## 5. 当前能力

- 多工具状态快照：Claude Code、Codex、VS Code、Cursor、通用监控。
- 多实例监控：同一种工具的多个项目/会话会显示成多条状态。
- `/events` 统一事件入口。
- `/api/status` 当前状态。
- `/api/events` 最近事件。
- `/ws` 实时推送。
- Web 面板实时展示。
- 桌宠式状态视觉。
- 浏览器 TTS 播报关键状态。
- 手机浏览器可作为局域网状态屏使用。

## 6. 下一步

建议接着做：

1. VS Code / Cursor 扩展，上报文件、任务、终端和诊断状态。
2. Windows 桌面壳，加入置顶透明桌宠窗口。
3. 语音唤醒，把“现在在做什么”接到系统语音识别。
4. 局域网配对 token，避免任意设备读取状态。
