const vscode = require("vscode");

// CodeStatus Companion — VS Code / Cursor 采集适配器
//
// 监控两类对象：
//   1) 编辑器自身（vscode / cursor）：保存、任务、调试、终端命令、诊断、空闲。
//   2) 在 VS Code 里运行的 AI 编码工具（Cline / Kimi Code / MiniMax Code / GLM Code …）。
//      这些工具大多没有官方事件接口，用「可配置注册表 + 弱信号」识别：
//        - 终端里运行的命令命中某个工具的 commandPatterns（如 `kimi`、`glm`）；
//        - 安装了某个工具的 VS Code 扩展（extensionIds）；
//        - 该工具活跃期间的文件写入。
//      要新增一个工具，无需改代码 —— 在设置 `codestatus.agents` 里加一条即可。

// 默认内置的 AI 工具注册表（可被设置覆盖 / 追加）
const DEFAULT_AGENTS = [
  { source: "claude-dev", label: "Cline", extensionIds: ["saoudrizwan.claude-dev", "anysphere.cline"], commandPatterns: ["\\bcline\\b"], terminalPatterns: ["cline", "claude dev"] },
  { source: "kimi-code", label: "Kimi Code", extensionIds: ["moonshot-ai.kimi-code", "moonshot", "kimi"], commandPatterns: ["\\bkimi(-code)?\\b"], terminalPatterns: ["kimi", "kimi-code"] },
  { source: "zcode", label: "ZCode", extensionIds: ["zcode", "z.ai", "zai"], commandPatterns: ["\\bzcode\\b", "\\bz\\.ai\\b"], terminalPatterns: ["zcode", "z.ai"] },
  { source: "minimax-code", label: "MiniMax Code", extensionIds: ["minimax"], commandPatterns: ["\\bminimax\\b", "\\bmmx\\b"], terminalPatterns: ["minimax"] },
  { source: "glm-code", label: "GLM Code", extensionIds: ["zhipu", "glm", "codegeex"], commandPatterns: ["\\bglm(-code)?\\b", "codegeex"], terminalPatterns: ["glm", "codegeex"] },
  { source: "roo", label: "Roo Code", extensionIds: ["rooveterinaryinc.roo-cline", "roo-cline", "roo"], commandPatterns: ["\\broo(-cline)?\\b"], terminalPatterns: ["roo"] },
  { source: "continue", label: "Continue", extensionIds: ["continue.continue"], commandPatterns: ["\\bcontinue\\b"], terminalPatterns: ["continue"] },
  { source: "aider", label: "Aider", extensionIds: [], commandPatterns: ["\\baider\\b"], terminalPatterns: ["aider"] },
  { source: "claude-code", label: "Claude Code", extensionIds: [], commandPatterns: ["\\bclaude\\b"], terminalPatterns: ["claude"] },
  { source: "codex", label: "Codex", extensionIds: [], commandPatterns: ["\\bcodex\\b"], terminalPatterns: ["codex"] }
];

const IGNORE_PATH = /(^|[\\/])(node_modules|\.git|dist|out|build|\.next|target|\.venv|coverage)([\\/]|$)/i;
const EDITOR_IDLE_AFTER_MS = 15000;
const AGENT_IDLE_AFTER_MS = 15000;
const AGENT_ACTIVE_WINDOW_MS = 45000; // 终端命令命中后，多久内的文件写入仍归因给该工具
const USER_INPUT_WINDOW_MS = 1500;
const REPORT_THROTTLE_MS = 2500; // 同一来源 writing_code 的最小上报间隔

function activate(context) {
  const machineId = safe(() => vscode.env.machineId) || "vscode";
  const appName = safe(() => vscode.env.appName) || "VS Code";
  const isCursor = appName.toLowerCase().includes("cursor");
  const editorSource = isCursor ? "cursor" : "vscode";
  const editorLabel = isCursor ? "Cursor" : "VS Code";
  const editorInstanceId = `${editorSource}::${machineId}`;

  const agents = loadAgents();
  const installedAgents = agents.filter((agent) => agentInstalled(agent));

  let activeAgent = null; // 当前活跃的 AI 工具
  let activeAgentAt = 0;
  const terminalAgentMap = new Map(); // 终端 -> agent，便于后续命令归因
  let lastUserInputAt = 0;
  const lastReportAt = new Map(); // source -> 上次 writing_code 上报时间
  let editorIdleTimer = null;
  let agentIdleTimer = null;
  let editorState = "idle";

  const post = (event) => sendEvent(event).catch(() => {});

  function report(source, label, state, payload = {}) {
    post({
      source,
      instanceId: `${source}::${machineId}`,
      sourceLabel: label,
      label,
      state,
      workspace: workspacePath(),
      projectName: projectName(),
      ...payload
    });
  }

  function reportEditor(state, payload = {}) {
    editorState = state;
    report(editorSource, editorLabel, state, payload);
    scheduleEditorIdle();
  }

  function reportAgent(agent, state, payload = {}) {
    report(agent.source, agent.label, state, { confidence: 0.55, ...payload });
    activeAgent = agent;
    activeAgentAt = Date.now();
    if (state !== "idle" && state !== "completed") scheduleAgentIdle();
  }

  function throttled(source) {
    const now = Date.now();
    if (now - (lastReportAt.get(source) || 0) < REPORT_THROTTLE_MS) return false;
    lastReportAt.set(source, now);
    return true;
  }

  function currentAgent() {
    if (activeAgent && Date.now() - activeAgentAt < AGENT_ACTIVE_WINDOW_MS) return activeAgent;
    // 没有近期终端活动时：若只装了一个 AI 扩展，把程序化写入归因给它
    if (installedAgents.length === 1) return installedAgents[0];
    return null;
  }

  function scheduleEditorIdle() {
    if (editorIdleTimer) clearTimeout(editorIdleTimer);
    editorIdleTimer = setTimeout(() => {
      if (["writing_code", "running_command", "running_tests", "using_tool"].includes(editorState)) {
        reportEditor("idle", { summary: `${editorLabel} 空闲`, detail: "编辑器一段时间无活动" });
      }
    }, EDITOR_IDLE_AFTER_MS);
  }

  function scheduleAgentIdle() {
    if (agentIdleTimer) clearTimeout(agentIdleTimer);
    const agent = activeAgent;
    agentIdleTimer = setTimeout(() => {
      if (agent) report(agent.source, agent.label, "idle", { confidence: 0.5, summary: `${agent.label} 暂时空闲`, detail: "未检测到新的活动" });
    }, AGENT_IDLE_AFTER_MS);
  }

  // 上线：编辑器 + 已安装的 AI 工具各开一条通道
  reportEditor("idle", { summary: `${editorLabel} 已连接`, detail: "适配器已激活" });
  for (const agent of installedAgents) {
    report(agent.source, agent.label, "idle", { confidence: 0.5, summary: `${agent.label} 已就绪`, detail: "已检测到对应扩展" });
  }

  // 心跳保活：每 15 秒重发当前状态，确保 Agent 能感知到插件在线。
  // 解决插件激活时 Agent 未运行导致的首个事件丢失后无法重连的问题。
  const heartbeatTimer = setInterval(() => {
    reportEditor(editorState, { summary: `${editorLabel} ${editorState === "idle" ? "在线" : "活动中"}`, detail: "心跳" });
    for (const agent of installedAgents) {
      report(agent.source, agent.label, "idle", { confidence: 0.5, summary: `${agent.label} 已就绪`, detail: "心跳" });
    }
  }, 15000);
  context.subscriptions.push({ dispose: () => clearInterval(heartbeatTimer) });

  // 人工输入信号
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.kind === vscode.TextEditorSelectionChangeKind.Keyboard) lastUserInputAt = Date.now();
    })
  );

  // 文档变更：区分人工输入与程序化（AI 工具）写入
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const doc = event.document;
      if (doc.uri.scheme !== "file" || !event.contentChanges.length || IGNORE_PATH.test(doc.uri.fsPath)) return;
      const now = Date.now();
      const activeDoc = vscode.window.activeTextEditor?.document;
      const isProgrammatic = now - lastUserInputAt > USER_INPUT_WINDOW_MS || doc !== activeDoc;
      const agent = isProgrammatic ? currentAgent() : null;

      if (agent) {
        activeAgentAt = now;
        if (throttled(agent.source)) {
          reportAgent(agent, "writing_code", { summary: `${agent.label} 正在写代码`, detail: `自动修改 ${shortPath(doc.uri.fsPath)}`, raw: { file_path: doc.uri.fsPath } });
        }
      } else if (!isProgrammatic && throttled(editorSource)) {
        reportEditor("writing_code", { summary: `${editorLabel} 正在编辑`, detail: `编辑 ${shortPath(doc.uri.fsPath)}`, confidence: 0.7, raw: { file_path: doc.uri.fsPath } });
      }
    })
  );

  // 工作区文件写入（CLI 类 AI 工具改盘上文件时，可能不触发文档变更，用文件监视兜底）
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const onFsChange = (uri) => {
    if (uri.scheme !== "file" || IGNORE_PATH.test(uri.fsPath)) return;
    const agent = currentAgent();
    if (!agent) return;
    activeAgentAt = Date.now();
    if (throttled(`fs:${agent.source}`)) {
      reportAgent(agent, "writing_code", { summary: `${agent.label} 正在写代码`, detail: `写入 ${shortPath(uri.fsPath)}`, raw: { file_path: uri.fsPath } });
    }
  };
  watcher.onDidChange(onFsChange);
  watcher.onDidCreate(onFsChange);
  context.subscriptions.push(watcher);

  // 保存
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (IGNORE_PATH.test(document.uri.fsPath)) return;
      reportEditor("writing_code", { summary: `${editorLabel} 已保存文件`, detail: `保存 ${shortPath(document.uri.fsPath)}`, confidence: 0.85, raw: { file_path: document.uri.fsPath } });
    })
  );

  // 任务
  context.subscriptions.push(
    vscode.tasks.onDidStartTask((event) => {
      const name = event.execution.task.name || "";
      const state = isTestLike(name) ? "running_tests" : "running_command";
      reportEditor(state, { summary: `${editorLabel} ${state === "running_tests" ? "正在测试" : "正在运行任务"}`, detail: name, confidence: 0.9, raw: { command: name } });
    })
  );
  context.subscriptions.push(
    vscode.tasks.onDidEndTask((event) => {
      reportEditor("completed", { summary: `${editorLabel} 任务结束`, detail: event.execution.task.name || "任务完成", confidence: 0.85 });
    })
  );

  // 调试
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      reportEditor("running_command", { summary: `${editorLabel} 正在调试`, detail: session.name || "调试会话已开始", confidence: 0.85 });
    })
  );
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession((session) => {
      reportEditor("completed", { summary: `${editorLabel} 调试结束`, detail: session.name || "调试会话已结束", confidence: 0.8 });
    })
  );

  // 终端命令：识别 AI 工具 CLI，并归因后续活动
  if (typeof vscode.window.onDidStartTerminalShellExecution === "function") {
    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution((event) => {
        const command = event.execution?.commandLine?.value || "";
        const terminalName = event.terminal?.name || "";
        const matched = matchAgent(agents, command, terminalName) || terminalAgentMap.get(event.terminal);
        if (matched) {
          terminalAgentMap.set(event.terminal, matched);
          const state = isTestLike(command) ? "running_tests" : "using_tool";
          reportAgent(matched, state, { summary: `${matched.label} ${state === "running_tests" ? "正在测试" : "正在运行"}`, detail: command || matched.label, raw: { command } });
        } else {
          const state = isTestLike(command) ? "running_tests" : "running_command";
          reportEditor(state, { summary: `${editorLabel} ${state === "running_tests" ? "正在测试" : "正在运行命令"}`, detail: command, confidence: 0.85, raw: { command } });
        }
      })
    );
    if (typeof vscode.window.onDidEndTerminalShellExecution === "function") {
      context.subscriptions.push(
        vscode.window.onDidEndTerminalShellExecution((event) => {
          const agent = terminalAgentMap.get(event.terminal);
          if (!agent) return;
          const failed = typeof event.exitCode === "number" && event.exitCode !== 0;
          report(agent.source, agent.label, failed ? "failed" : "completed", {
            confidence: 0.55,
            severity: failed ? "error" : "info",
            summary: `${agent.label} ${failed ? "出现问题" : "本轮结束"}`,
            detail: failed ? `退出码 ${event.exitCode}` : "命令执行完成"
          });
        })
      );
    }
  } else {
    context.subscriptions.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        const matched = matchAgent(agents, "", terminal.name || "");
        if (matched) {
          terminalAgentMap.set(terminal, matched);
          reportAgent(matched, "using_tool", { summary: `${matched.label} 已启动`, detail: terminal.name });
        }
      })
    );
  }
  context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => terminalAgentMap.delete(terminal)));

  // 诊断报错
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(() => {
      const errors = countDiagnostics(vscode.DiagnosticSeverity.Error);
      if (errors > 0 && throttled(`diag:${editorSource}`)) {
        reportEditor("failed", { summary: `${editorLabel} 检测到 ${errors} 个错误`, detail: `工作区当前有 ${errors} 个诊断错误`, severity: "error", confidence: 0.7, raw: { error_count: errors } });
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      reportEditor("idle", { summary: `${editorLabel} 工作区已切换`, detail: projectName() || "工作区已更新" });
    })
  );

  context.subscriptions.push({
    dispose() {
      if (editorIdleTimer) clearTimeout(editorIdleTimer);
      if (agentIdleTimer) clearTimeout(agentIdleTimer);
    }
  });
}

function deactivate() {}

function loadAgents() {
  const config = vscode.workspace.getConfiguration("codestatus");
  const custom = config.get("agents");
  const list = Array.isArray(custom) && custom.length ? custom : DEFAULT_AGENTS;
  return list
    .filter((agent) => agent && agent.source)
    .map((agent) => ({
      source: agent.source,
      label: agent.label || agent.source,
      extensionIds: agent.extensionIds || [],
      commandRe: compilePatterns(agent.commandPatterns),
      terminalRe: compilePatterns(agent.terminalPatterns)
    }));
}

function compilePatterns(patterns) {
  if (!Array.isArray(patterns) || !patterns.length) return null;
  try {
    return new RegExp(patterns.join("|"), "i");
  } catch {
    return null;
  }
}

function agentInstalled(agent) {
  // 精确匹配优先
  for (const id of agent.extensionIds || []) {
    if (safe(() => vscode.extensions.getExtension(id))) return true;
  }
  // 子串匹配退回：要求扩展 ID 包含关键词，且 publisher 部分或扩展名部分匹配
  // 避免短关键词（如 "kimi"）误匹配不相关扩展（如 "kimi-lm-provider" 不等于 "kimi-code"）
  const all = safe(() => vscode.extensions.all) || [];
  return all.some((ext) => {
    const extId = ext.id.toLowerCase();
    return (agent.extensionIds || []).some((id) => {
      const kw = String(id).toLowerCase();
      // 精确 ID 直接匹配
      if (extId === kw) return true;
      // publisher.name 格式的关键词匹配 publisher 或 name 部分
      const parts = extId.split(".");
      return parts.some((part) => part === kw || (part.length > 2 && part.includes(kw)));
    });
  });
}

function matchAgent(agents, command, terminalName) {
  for (const agent of agents) {
    if (agent.commandRe && command && agent.commandRe.test(command)) return agent;
    if (agent.terminalRe && terminalName && agent.terminalRe.test(terminalName)) return agent;
  }
  return null;
}

async function sendEvent(event) {
  const config = vscode.workspace.getConfiguration("codestatus");
  const agentUrl = config.get("agentUrl") || "http://127.0.0.1:4317/api/events";
  await fetch(agentUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout?.(2500)
  });
}

function countDiagnostics(severity) {
  let count = 0;
  for (const [, diagnostics] of vscode.languages.getDiagnostics()) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === severity) count += 1;
    }
  }
  return count;
}

function isTestLike(text) {
  return /(test|vitest|jest|pytest|cargo test|go test|npm t\b|pnpm test|yarn test|spec)/i.test(String(text || ""));
}

function workspacePath() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
}

function projectName() {
  return vscode.workspace.workspaceFolders?.[0]?.name || "";
}

function shortPath(fsPath) {
  const parts = String(fsPath || "").split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || fsPath;
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

module.exports = { activate, deactivate };
