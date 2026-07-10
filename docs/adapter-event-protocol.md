# CodeStatus 适配器事件协议

第三方 code 软件、国产 IDE、编辑器插件都可以向电脑端 Agent 上报：

```http
POST http://127.0.0.1:4317/api/events
Content-Type: application/json
```

推荐 payload：

```json
{
  "source": "vscode",
  "instanceId": "vscode::workspace-id",
  "state": "writing_code",
  "activity": "write",
  "phase": "edit",
  "summary": "VS Code 正在写代码",
  "detail": "保存 src/App.jsx",
  "workspace": "G:/Project/demo",
  "projectName": "demo",
  "sessionId": "optional-session",
  "model": "optional-model"
}
```

`state` 标准枚举：

- `offline`
- `idle`
- `prompt_submitted`
- `thinking`
- `using_tool`
- `writing_code`
- `running_command`
- `running_tests`
- `waiting_permission`
- `waiting_user`
- `completed`
- `failed`
- `paused`

如果适配器不能直接给 `state`，可以给 `activity` 或 `phase`，Agent 会自动映射。

隐私建议：

- `summary` 放可播报短句。
- `detail` 放 UI 可显示细节。
- 不要上传源码内容。
- 文件路径可以只传相对路径或在隐私模式下隐藏。
