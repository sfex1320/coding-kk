# CodeStatus Companion 原型最终验收稿

## 1. 当前可验收范围

本阶段交付的是“电脑端状态采集 Agent + Web 桌面控制台 + 手机/副屏 Web APP 原型”。

已完成：

- 电脑端本地 Agent。
- Claude Code hooks 接入。
- Codex hooks 安装脚本。
- 多软件、多项目、多会话状态模型。
- 模型信息字段采集与展示。
- 手机/副屏浅色基础页。
- 点击像素小人进入常驻展示第二页面。
- 常驻展示页纯黑背景，无光效。
- 常驻展示页左侧放大像素小人，右侧当前状态和监听列表。
- 语音事件队列播报。
- 按钮播报当前状态。
- Web 一次性语音问答。
- 局域网短期 pair code 配对。
- 电脑端局域网配对二维码。
- 设备独立密钥 `deviceSecret`。
- 撤销设备黑名单。
- URL token 清理。
- HTTPS 证书 SHA-256 指纹。
- 已配对设备记录。
- 一键撤销已配对设备。
- HTTPS Agent 加密通道。
- mDNS 自动发现广播。
- 防火墙/网络诊断面板。
- 离线重连状态细节提示。
- 隐私模式。
- VS Code / Cursor 扩展骨架。
- Expo / React Native 手机 APP 骨架。
- 国产 IDE 通用适配协议。
- 配对 token 重新生成。

## 2. 电脑端能力

入口：

```text
http://127.0.0.1:5173
```

能力：

- 查看所有监听实例。
- 查看当前状态、项目、工作区、模型、更新时间。
- 查看事件时间线。
- 查看局域网配对地址、短期 pair code 和证书指纹。
- 扫码打开手机/副屏页面。
- 查看 HTTPS Agent 地址。
- 查看自动发现和防火墙诊断。
- 查看已配对设备。
- 一键撤销已配对设备。
- 开启/关闭隐私模式。
- 重新生成配对 token。
- 调试模拟状态。

## 3. 手机/副屏 APP 原型

入口：

```text
http://电脑局域网IP:5173?display=1&pair=短期配对码
```

电脑端会在“局域网配对”面板生成连接地址和二维码。

手机端能力：

- URL 中不再携带长期 token。
- 保存本机设备 ID。
- 通过 pair code 换取设备独立密钥。
- 后续通过 `deviceId + deviceSecret` 鉴权。
- 通过局域网 WebSocket 接收状态。
- 断线后自动重连并显示具体连接原因。
- 浅色基础页。
- 点击像素小人进入常驻展示页。
- 常驻展示页支持进入浏览器全屏。
- 常驻展示页尝试使用 Wake Lock 保持屏幕常亮。
- 左右滑动切换查看的监听实例。
- 全局语音播报所有监听工具的新事件。
- token / pair code 失效时显示重新扫码配对页。

## 4. 模型信息采集

事件协议支持以下字段：

```json
{
  "source": "claude-code",
  "model": "claude-sonnet-4.5",
  "state": "writing_code"
}
```

后端也会尝试从原始 hook payload 中读取：

- `model`
- `model_id`
- `modelId`
- `actual_model`
- `effective_model`
- `config.model`
- `request.model`
- `metadata.model`

如果工具本身没有在 hook 中暴露模型，则 UI 显示“模型未知”。

## 5. 语音能力

当前 Web 原型支持：

- 语音播报开关。
- 状态事件队列播报。
- 播报当前状态。
- 点击“对话”进行一次性语音识别。

正式 APP 需要补：

- 常驻唤醒词 `Hello Code`。
- 后台语音权限。
- 锁屏/后台策略。
- 麦克风权限引导。
- 播报全部工具 / 当前工具切换。

说明：这些属于 iOS/Android 原生权限能力，当前 Web 副屏已经提供状态流、设备 ID、设备密钥、HTTPS Agent 地址和事件播报队列；原生 APP 需要复用这些协议后接入系统 TTS、麦克风和后台任务。

本仓库已新增 Expo/React Native APP 骨架：

```text
apps/mobile
```

## 6. 安全与局域网

当前已完成：

- 短期 pair code 配对。
- 手机通过 `deviceId + deviceSecret` 访问 `/api/status` 和 `/ws`。
- 电脑端二维码配对入口。
- 设备登记和 last seen。
- 设备列表。
- 设备一键撤销。
- 撤销设备黑名单：相同 deviceId 被撤销后不能重新接入。
- URL 不再暴露长期 token。
- HTTPS 证书 SHA-256 指纹，可用于原生 APP certificate pinning。
- mDNS `_codestatus._tcp.local` 自动发现广播。
- `/api/discovery` 自动发现元数据。
- `/api/network-diagnostics` 防火墙/端口/局域网诊断。
- HTTPS Agent：`https://电脑局域网IP:4318`。
- 重新生成 token 会清空设备列表。
- 本机访问免 token，方便电脑端配置；非本机读状态需要设备密钥或短期配对流程。

## 7. 仍需下一阶段完成

这些已经有工程骨架或协议，但还需要进入打包/发布阶段：

- VS Code / Cursor 扩展：`extensions/vscode`。
- 国产 code 软件自动扫描和适配器市场：协议见 `docs/adapter-event-protocol.md`。
- 系统级桌面悬浮像素小人。
- 原生手机 APP：`apps/mobile`。
- 真正常驻唤醒词：需要接 Porcupine/openWakeWord 或系统语音入口。
- 后台/锁屏语音播报：需要 iOS/Android 原生权限和前台/后台服务。

建议下一阶段顺序：

1. 打包 VS Code/Cursor 扩展。
2. Tauri 桌面端和悬浮小人。
3. 打包 React Native/Expo 手机 APP。
4. 唤醒词服务。

## 8. 验收步骤

启动：

```powershell
npm run dev
```

电脑端：

```text
http://127.0.0.1:5173
```

手机端：

```text
http://电脑局域网IP:5173?display=1&pair=短期配对码
```

Claude Code：

```text
/hooks
```

确认 CodeStatus hook 已启用。

Codex：

```text
/hooks
```

信任 CodeStatus hook。

验收点：

- 任务开始后状态进入“已提交任务/正在思考”。
- 写文件时进入“正在写代码”。
- 跑命令时进入“正在运行命令/正在测试”。
- 完成时进入“已完成”。
- 手机端同步状态。
- 常驻展示页是纯黑背景。
- 模型字段有值时显示模型；无值时显示模型未知。
- 语音开关打开后，新事件会播报。
- 扫码 URL 不包含长期 token。
- 设备 claim 后拿到 deviceSecret。
- 撤销设备后，同一 deviceId 再访问返回 401/403。
- 隐私模式开启后隐藏路径、项目名、模型和细节。
