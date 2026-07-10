import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 监听 Claude Code / Codex 写在本地的会话日志（JSONL），把新增行翻译成状态事件。
// 这条通道不依赖 CLI hooks，VS Code 插件版也能被监控。

const RESCAN_INTERVAL_MS = 15000;
const DEBOUNCE_MS = 250;
// 助手发起工具调用后长时间没有新日志 → 可能在等授权（也可能是长命令）
const PENDING_TOOL_TIMEOUT_MS = 90000;

export function startTranscriptWatchers(onEvent) {
  const stops = [];
  const claudeRoot = path.join(os.homedir(), ".claude", "projects");
  const codexRoot = path.join(os.homedir(), ".codex", "sessions");

  if (fs.existsSync(claudeRoot)) {
    stops.push(watchJsonlTree(claudeRoot, createClaudeLineHandler(onEvent)));
    console.log(`[watcher] 正在监听 Claude Code 会话日志：${claudeRoot}`);
  }
  if (fs.existsSync(codexRoot)) {
    stops.push(watchJsonlTree(codexRoot, createCodexLineHandler(onEvent)));
    console.log(`[watcher] 正在监听 Codex 会话日志：${codexRoot}`);
  }

  return () => stops.forEach((stop) => stop());
}

// ---- 通用 JSONL 目录尾随 ----

function watchJsonlTree(root, handleLine) {
  // file -> { offset, remainder, timer, ctx }
  const tracked = new Map();
  let alive = true;

  function track(file, stats) {
    if (tracked.has(file)) return tracked.get(file);
    // 启动前就存在的旧文件从末尾开始（不回放历史）；新建的文件从头读
    const isFresh = Date.now() - stats.birthtimeMs < 60000;
    const entry = { offset: isFresh ? 0 : stats.size, remainder: "", timer: null, ctx: {} };
    tracked.set(file, entry);
    return entry;
  }

  function poke(file) {
    if (!alive || !file.endsWith(".jsonl")) return;
    let stats;
    try {
      stats = fs.statSync(file);
    } catch {
      return;
    }
    if (!stats.isFile()) return;
    const entry = track(file, stats);
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      drain(file, entry);
    }, DEBOUNCE_MS);
  }

  function drain(file, entry) {
    let stats;
    try {
      stats = fs.statSync(file);
    } catch {
      return;
    }
    if (stats.size < entry.offset) {
      entry.offset = 0; // 文件被截断重写
      entry.remainder = "";
    }
    if (stats.size === entry.offset) return;

    const stream = fs.createReadStream(file, { start: entry.offset, end: stats.size - 1, encoding: "utf8" });
    let text = entry.remainder;
    stream.on("data", (chunk) => {
      text += chunk;
    });
    stream.on("error", () => {});
    stream.on("end", () => {
      entry.offset = stats.size;
      const lines = text.split("\n");
      entry.remainder = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          handleLine(JSON.parse(trimmed), file, entry.ctx);
        } catch {
          // 单行损坏不影响后续
        }
      }
    });
  }

  function rescan() {
    if (!alive) return;
    for (const file of listJsonlFiles(root)) {
      let stats;
      try {
        stats = fs.statSync(file);
      } catch {
        continue;
      }
      // 只关注最近有动静的文件，避免每轮全量读 stat 之外的开销
      const entry = tracked.get(file);
      if (entry) {
        if (stats.size !== entry.offset) poke(file);
      } else if (Date.now() - stats.mtimeMs < 5 * 60000) {
        track(file, stats);
        poke(file);
      }
    }
  }

  let watcher = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      poke(path.join(root, filename.toString()));
    });
    watcher.on("error", () => {});
  } catch {
    // 某些环境不支持递归 watch，退化为纯轮询
  }

  // 初始扫描：登记现有文件（从末尾开始）
  for (const file of listJsonlFiles(root)) {
    try {
      track(file, fs.statSync(file));
    } catch {
      // ignore
    }
  }
  const timer = setInterval(rescan, RESCAN_INTERVAL_MS);

  return () => {
    alive = false;
    clearInterval(timer);
    watcher?.close();
    for (const entry of tracked.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.ctx?.pendingTimer) clearTimeout(entry.ctx.pendingTimer);
    }
  };
}

function listJsonlFiles(root, depth = 0, out = []) {
  if (depth > 6) return out;
  let dirents;
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of dirents) {
    const full = path.join(root, dirent.name);
    if (dirent.isDirectory()) {
      if (dirent.name === "subagents") continue; // 子代理日志并入主会话，不单独跟踪
      listJsonlFiles(full, depth + 1, out);
    } else if (dirent.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

// ---- Claude Code 日志（~/.claude/projects/<项目>/<会话id>.jsonl）----

function createClaudeLineHandler(onEvent) {
  return (line, file, ctx) => {
    if (file.includes(`${path.sep}subagents${path.sep}`)) return;
    if (line.sessionId) ctx.sessionId = line.sessionId;
    if (line.cwd) ctx.cwd = line.cwd;

    const emit = (state, message, extra = {}) =>
      onEvent({
        source: "claude-code",
        sessionId: ctx.sessionId || path.basename(file, ".jsonl"),
        workspace: ctx.cwd || "",
        model: ctx.model || "",
        confidence: 0.85,
        state,
        message,
        ...extra
      });

    clearPendingTimer(ctx);

    if (line.type === "user" && !line.isMeta) {
      const content = line.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join(" ")
            : "";
      const trimmed = text.trim();
      // 过滤命令包装、工具结果等非人类输入
      if (trimmed && !trimmed.startsWith("<")) {
        emit("prompt_submitted", `收到新任务：${clip(trimmed, 120)}`);
      }
      return;
    }

    if (line.type === "assistant") {
      const message = line.message || {};
      if (message.model) ctx.model = message.model;
      const content = Array.isArray(message.content) ? message.content : [];
      const toolUse = content.find((item) => item.type === "tool_use");
      const textItem = content.find((item) => item.type === "text");

      if (message.stop_reason === "end_turn") {
        emit("completed", textItem?.text ? clip(textItem.text, 140) : "本轮任务已经完成");
        return;
      }
      if (toolUse) {
        const { state, message: detail } = mapClaudeTool(toolUse);
        emit(state, detail);
        armPendingTimer(ctx, () =>
          emit("waiting_permission", "较长时间没有新动作，可能在等待你的授权确认（也可能是长命令执行中）")
        );
        return;
      }
      if (content.some((item) => item.type === "thinking") || textItem) {
        emit("thinking", "正在思考下一步");
      }
      return;
    }

    if (line.type === "system" && (line.level === "error" || line.isApiErrorMessage)) {
      emit("failed", clip(line.content || line.message || "会话出现错误", 140));
    }
  };
}

function mapClaudeTool(toolUse) {
  const name = String(toolUse.name || "");
  const input = toolUse.input || {};
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) {
    return { state: "writing_code", message: input.file_path ? `正在处理 ${input.file_path}` : "正在写代码" };
  }
  if (/bash|powershell/i.test(name)) {
    const command = String(input.command || "");
    if (/(test|vitest|jest|pytest|cargo test|go test|npm t|pnpm test|yarn test)/i.test(command)) {
      return { state: "running_tests", message: clip(`正在测试：${command}`, 140) };
    }
    return { state: "running_command", message: clip(`正在执行：${command}`, 140) };
  }
  return { state: "using_tool", message: `正在调用工具 ${name}` };
}

// ---- Codex 日志（~/.codex/sessions/年/月/日/rollout-*.jsonl）----

function createCodexLineHandler(onEvent) {
  return (line, file, ctx) => {
    const payload = line.payload || {};

    const emit = (state, message, extra = {}) =>
      onEvent({
        source: "codex",
        sessionId: ctx.sessionId || path.basename(file, ".jsonl"),
        workspace: ctx.cwd || "",
        model: ctx.model || "",
        confidence: 0.9,
        state,
        message,
        ...extra
      });

    if (line.type === "session_meta") {
      ctx.sessionId = payload.id || payload.session_id || ctx.sessionId;
      ctx.cwd = payload.cwd || ctx.cwd;
      return;
    }
    if (line.type === "turn_context") {
      ctx.model = payload.model || ctx.model;
      ctx.cwd = payload.cwd || ctx.cwd;
      return;
    }
    if (line.type !== "event_msg") return;

    clearPendingTimer(ctx);

    switch (payload.type) {
      case "task_started":
        emit("thinking", "开始处理任务");
        return;
      case "user_message":
        emit("prompt_submitted", `收到新任务：${clip(String(payload.message || ""), 120)}`);
        return;
      case "agent_message":
        ctx.lastAgentMessage = String(payload.message || "");
        return;
      case "task_complete":
        emit("completed", clip(String(payload.last_agent_message || ctx.lastAgentMessage || "本轮任务已经完成"), 140));
        return;
      case "turn_aborted":
        emit("paused", "任务被中断");
        return;
      case "error":
      case "stream_error":
        emit("failed", clip(String(payload.message || "Codex 会话出错"), 140));
        return;
      case "exec_command_begin":
        emit(
          "running_command",
          clip(`正在执行：${Array.isArray(payload.command) ? payload.command.join(" ") : payload.command || ""}`, 140)
        );
        return;
      case "patch_apply_begin":
      case "patch_apply_end":
        emit("writing_code", "正在修改代码");
        return;
      case "web_search_begin":
      case "web_search_end":
        emit("using_tool", "正在搜索网页");
        return;
      default:
        if (/approval_request/.test(String(payload.type || ""))) {
          emit("waiting_permission", "Codex 在等待你的授权确认");
        }
    }
  };
}

function armPendingTimer(ctx, fire) {
  clearPendingTimer(ctx);
  ctx.pendingTimer = setTimeout(fire, PENDING_TOOL_TIMEOUT_MS);
}

function clearPendingTimer(ctx) {
  if (ctx.pendingTimer) {
    clearTimeout(ctx.pendingTimer);
    ctx.pendingTimer = null;
  }
}

function clip(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
