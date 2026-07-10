# 原生 APP 局域网与语音实现稿

## 目标

原生手机 APP 只负责展示、播报、唤醒和对话；电脑端 Agent 负责采集 Claude Code / Codex / VS Code / Cursor 等状态。

## 配对流程

1. APP 扫描电脑端二维码。
2. 二维码内容为短期配对码，不直接暴露 token：

```text
http://电脑局域网IP:5173?display=1&pair=短期配对码
```

3. APP 提取：

- `host`
- `pairCode`
- `deviceId`

4. APP 调用：

```http
POST http://电脑局域网IP:4317/api/pairing/claim
Content-Type: application/json

{
  "pairCode": "短期配对码",
  "deviceId": "APP生成的稳定设备ID",
  "name": "用户设置的设备名"
}
```

返回 `deviceSecret` 后，APP 保存到系统安全存储：

- iOS：Keychain
- Android：EncryptedSharedPreferences / Keystore

5. APP 建立实时状态连接：

```text
ws://电脑局域网IP:4317/ws?deviceId=设备ID&deviceSecret=设备密钥
```

如果用户信任自签名证书，可以使用：

```text
wss://电脑局域网IP:4318/ws?deviceId=设备ID&deviceSecret=设备密钥
```

## 自动发现电脑

电脑端已广播：

```text
_codestatus._tcp.local
```

TXT 信息包含：

- `id`
- `name`
- `httpPort`
- `httpsPort`
- `secure`
- `auth`
- `path`
- `fingerprint256`

APP 首次启动可以先 mDNS 搜索 `_codestatus._tcp.local`，找不到时再要求扫码。

## 后台语音播报

Web 页面只能在浏览器允许时播报，不能可靠后台常驻。原生 APP 需要：

- iOS：`AVSpeechSynthesizer` + 后台音频模式。
- Android：`TextToSpeech` + 前台服务通知。
- 状态事件来自 WebSocket `event` payload。
- 播报策略使用本项目已有的队列规则：新事件进入队列，不取消上一条播报。

## 唤醒词

建议实现：

- 桌面端：openWakeWord / Porcupine，唤醒后读取 Agent 快照并播报。
- 手机端：Porcupine Mobile SDK 或系统语音入口。

唤醒词触发后调用：

```http
GET http://电脑局域网IP:4317/api/status
X-CodeStatus-Device-Id: 设备ID
X-CodeStatus-Device-Secret: 设备密钥
```

然后播报当前 `activeInstanceId` 对应工具的：

- `label`
- `state`
- `message`
- `model`
- `updatedAt`

## 断线重连

APP 应显示：

- pair code 过期、设备密钥失效或设备被撤销。
- Agent 不可达。
- WebSocket 断开，正在重连。
- 防火墙或不同 Wi-Fi 可能导致连接失败。

电脑端 `/api/network-diagnostics` 已提供诊断内容，桌面端负责展示给用户。
