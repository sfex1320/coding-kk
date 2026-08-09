#!/usr/bin/env node
// CodeStatus Companion — 通用桌面采集器
//
// 监控 config/fingerprints.json 里登记的 AI 工具，覆盖三大类：
//   1) 桌面/IDE 应用（OpenCode / Kimi 桌面版 / AutoGLM / PyCharm / Windsurf / …）
//      —— 弱信号：进程在线 / 窗口在前台 / CPU 高=在忙。
//   2) 本地 Web 服务（ComfyUI / SD WebUI）—— 准信号：轮询 HTTP API（/queue 等）。
//   3) 本地推理运行时（Ollama / LM Studio）—— HTTP API（/api/ps）+ runner 进程 CPU 差分判推理。
//
// 仅在状态变化（或同状态定期刷新）时 POST 标准事件到 CodeStatus Agent（默认 4317）。
// 端点带回退：/api/events 失败自动重试 /events。常驻运行。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// 是否以打包版（SEA .exe）运行：可执行文件名不是 node 即视为打包版。
// SEA 下 process.execPath 是 exe 本身，不能再 spawn 它来跑 .mjs 脚本（会重启 server）。
const isSeaBuild = !/^node(\.exe)?$/i.test(path.basename(process.execPath || "node"));
// SEA/CJS 打包时 import.meta.url 不可用（esbuild 警告 "will be empty"），fileURLToPath(undefined) 会抛错。
// 集中在一处 try/catch 回退；__dirname 仅 CLI 缺省指纹路径用，__thisFile 仅 CLI 主入口检测用。
// 内嵌时 server 总会传 fingerprintsPath，且 SEA 下 argv[1] 为空使主入口判断自动跳过——两值都用不到。
let __thisFile = "";
const __dirname = (() => {
  try {
    __thisFile = fileURLToPath(import.meta.url);
    return path.dirname(__thisFile);
  } catch {
    return path.dirname(process.execPath || ".");
  }
})();
const CONFIG_PATH_DEFAULT = path.join(__dirname, "..", "config", "fingerprints.json");
const APPDATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "CodeStatus");
const ID_PATH_DEFAULT = path.join(APPDATA_DIR, "collector-id.json");

// 运行时状态（由 startCollector 初始化；模块级以便各 helper 共享，helper 都在 startCollector 之后才被调用）。
let config = null;
let machineId = null;
let fps = [];
let cpuConf = {};
let poll = {};
let fastPrev = new Map(); // busyOnCpu runner 进程的 CPU 前值（1s 快采样用）
let states = new Map(); // 每个 source 的运行时状态
let dispatchEvent = null; // 上报出口：内嵌时直调 ingest()，CLI 时走 post()

/**
 * 启动采集器。既可被 CodeStatus 主进程内嵌调用（onEvent 直送 ingest，零延迟、免 HTTP），
 * 也可作为独立 CLI 运行（缺省 onEvent 时走 post() → HTTP）。
 * @param {{ fingerprintsPath?: string, machineIdPath?: string, onEvent?: (ev:any)=>void, autoDiscover?: boolean }} opts
 * @returns {{ stop: () => void }}
 */
export function startCollector({ fingerprintsPath, machineIdPath, onEvent, autoDiscover = true } = {}) {
  if (config) return { stop() {} }; // 防止重复启动造成双倍定时器
  config = loadConfig(fingerprintsPath || CONFIG_PATH_DEFAULT); // 失败抛出，交调用方 try/catch
  machineId = loadMachineId(machineIdPath || ID_PATH_DEFAULT);
  fps = config.fingerprints.filter((f) => f.enabled !== false);
  cpuConf = config.cpu;
  poll = config.pollMs;
  fastPrev = new Map();
  states = new Map();
  for (const fp of fps) {
    states.set(fp.source, {
      state: "offline",
      lastReport: 0,
      prevCpu: new Map(),
      busyStreak: 0,
      idleStreak: 0,
      online: false,
      everOnline: false,
      cpuPct: 0,
      httpSeen: false,
    });
  }
  dispatchEvent = typeof onEvent === "function" ? onEvent : post;

  log(`通用采集器启动 (machineId=${machineId})`);
  log(`监控 ${fps.length} 个指纹：${fps.map((f) => f.label).join("、")}`);
  log(typeof onEvent === "function" ? "内嵌模式：事件直送主进程 ingest()" : `上报 -> ${config.agentUrl}（回退 ${config.fallbackUrl}）`);

  const timers = [
    setInterval(tick, poll.process),
    setInterval(httpTick, poll.http),
    setInterval(fastTick, 1000) // 1s 快采样 runner CPU，抓 GPU 推理 prefill 尖峰
  ];
  tick(); // 首次立即采一次
  httpTick();
  fastTick();

  // 自动发现：SEA 下 process.execPath 是 exe，spawn 它跑 .mjs 会重启 server，故仅 CLI/开发态启用。
  if (autoDiscover && !isSeaBuild) {
    try {
      const scanPath = path.join(__dirname, "..", "scripts", "scan-ai-tools.mjs");
      if (fs.existsSync(scanPath)) {
        spawn(process.execPath, [scanPath, "--report"], { stdio: "ignore", windowsHide: true, detached: false });
        log("已触发自动发现（scan-ai-tools --report）");
      }
    } catch {
      /* ignore */
    }
  }

  return {
    stop() {
      for (const t of timers) clearInterval(t);
    }
  };
}

// ---------- 周期：进程 / 窗口 / CPU ----------
async function tick() {
  let snap;
  try {
    snap = await collectAll();
  } catch (e) {
    log("采集失败：" + e.message);
    return;
  }
  const procs = snap.processes || [];
  const cpuMap = new Map((snap.cpu || []).map((c) => [c.pid, c.cpu]));
  const fg = snap.fg || {};

  // 进程 -> source（每个进程只归一个 source）
  const sourcePids = new Map();
  for (const p of procs) {
    for (const fp of fps) {
      if (matchFp(fp, p)) {
        if (!sourcePids.has(fp.source)) sourcePids.set(fp.source, []);
        sourcePids.get(fp.source).push(p);
        break;
      }
    }
  }

  // CPU 差分（.CPU 是累计秒，两次采样求差得单核百分比）
  for (const [source, arr] of sourcePids) {
    const st = states.get(source);
    if (!st) continue;
    let total = 0;
    const cur = new Map();
    for (const p of arr) {
      const c = cpuMap.get(p.pid);
      if (typeof c !== "number") continue;
      cur.set(p.pid, c);
      const prev = st.prevCpu.get(p.pid);
      if (typeof prev === "number") {
        const dt = (c - prev) / (poll.process / 1000);
        if (dt > 0) total += dt;
      }
    }
    st.prevCpu = cur;
    st.cpuPct = total;
  }
  for (const fp of fps) {
    if (!sourcePids.has(fp.source)) {
      const st = states.get(fp.source);
      if (st) {
        st.prevCpu = new Map();
        st.cpuPct = 0;
      }
    }
  }

  // busyOnCpu 类（Ollama 等 GPU 推理）：CPU 尖峰锁存——单次采到高 CPU 就保持「推理中」一段时间。
  // GPU 推理时 runner（llama-server.exe）CPU 是突发性的（prefill/batch 尖峰），4s 采样窗口容易漏，
  // 锁存 12s 可覆盖一次生成的主体阶段。
  for (const fp of fps) {
    if (!fp.busyOnCpu) continue;
    const st = states.get(fp.source);
    if (!st) continue;
    const thr = fp.cpuBusyPct || cpuConf.busyPct;
    if (st.cpuPct > thr) st.inferringUntil = Date.now() + (cpuConf.inferringLatchMs || 12000);
  }

  // 前台窗口归属
  let fgSource = null;
  if (fg.pid) {
    for (const [source, arr] of sourcePids) {
      if (arr.some((p) => p.pid === fg.pid)) {
        fgSource = source;
        break;
      }
    }
  }
  if (!fgSource && fg.title) {
    for (const fp of fps) {
      if (kwMatch(fp.windowKeywords, fg.title)) {
        fgSource = fp.source;
        break;
      }
    }
  }

  // 评估非 httpProbe 指纹；httpProbe 指纹只更新 online/cpuPct（在 httpTick 里评估）
  for (const fp of fps) {
    const st = states.get(fp.source);
    st.online = sourcePids.has(fp.source);
    if (st.online) st.everOnline = true;
    if (fp.httpProbe) continue;
    if (!st.everOnline) continue; // 从未在本机检测到，不报 offline，避免占满监控面板
    if (fp.enhanced && st.online) {
      // 增强采集：进程树工作子进程检测（OpenCode 等 Electron AI IDE 跑命令挂在 sidecar 子进程树下）
      evalEnhanced(fp, procs, fg, st);
    } else {
      evalDesktop(fp, { online: st.online, cpuPct: st.cpuPct, foreground: fgSource === fp.source }, st);
    }
  }
}

// 增强采集：监测 AI IDE 进程树里的「工作子进程」（git/cmd/node/npm/test 等，排除常驻 MCP server）。
// 这对「等 LLM API 的 AI agent」最准——CPU 常驻 0% 但跑命令时会出现短命子进程。
function evalEnhanced(fp, procs, fg, st) {
  // 建立以指纹命中的进程为根的进程树（含子孙，靠 ppid 上溯）。
  // 浏览器（chrome/edge/firefox…）作为边界：不纳入树、不向下展开——
  // 否则用户在 OpenCode 里点开的浏览器整棵 tab/extension 子树会被误算成「OpenCode 在跑命令」。
  const BROWSER = /^(chrome|msedge|firefox|brave|vivaldi|opera|arc|software_reporter_tool)\.exe$/i;
  const rootPids = new Set();
  for (const p of procs) if (matchFp(fp, p)) rootPids.add(p.pid);
  const tree = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of procs) {
      if (tree.has(p.pid) || BROWSER.test(p.name)) continue;
      if (p.ppid && tree.has(p.ppid)) {
        tree.add(p.pid);
        changed = true;
      }
    }
  }
  // MCP server 及其整条子链（cmd→npx→node→server）都算「常驻 MCP」，忽略。
  const MCP = /mcp|modelcontextprotocol|@playwright|playwright|browser.?tools/i;
  const WORK = /^(git|cmd|bash|sh|node|python|pythonw|powershell|pwsh|npx|npm|yarn|pnpm|cargo|go|make|gcc|g\+\+|cl|dotnet|ruby|java|rustc|tsc|eslint|prettier|jest|vitest|pytest)\.?(exe)?$/i;
  const mcpPids = new Set();
  for (const p of procs) if (tree.has(p.pid) && MCP.test(p.cmd || "")) mcpPids.add(p.pid);
  let ch2 = true;
  while (ch2) {
    ch2 = false;
    for (const p of procs) {
      if (!tree.has(p.pid) || mcpPids.has(p.pid)) continue;
      if (p.ppid && mcpPids.has(p.ppid)) {
        mcpPids.add(p.pid);
        ch2 = true;
      }
    }
  }
  let child = null;
  for (const p of procs) {
    if (tree.has(p.pid) && !rootPids.has(p.pid) && !mcpPids.has(p.pid) && WORK.test(p.name)) {
      child = p;
      break;
    }
  }
  let target;
  if (child) {
    target = {
      state: "running_command",
      summary: `${fp.label} 正在运行命令`,
      confidence: 0.8,
      detail: `${child.name} ${shortCmd(child.cmd)}`.trim(),
      raw: { child: child.name, child_cmd: shortCmd(child.cmd) },
    };
  } else if (st.cpuPct > (cpuConf.genPct || 15)) {
    // 无工作子进程但 sidecar CPU 持续偏高 → 正在生成（等 LLM API 的间歇性 CPU）
    target = {
      state: "using_tool",
      summary: `${fp.label} 正在生成`,
      confidence: 0.65,
      detail: `CPU ${Math.round(st.cpuPct)}%`,
      raw: { cpu_pct: Math.round(st.cpuPct) },
    };
  } else if (fg.pid && tree.has(fg.pid)) {
    target = { state: "using_tool", summary: `${fp.label} 在前台`, confidence: 0.6, detail: "窗口处于前台" };
  } else {
    target = { state: "idle", summary: `${fp.label} 在线`, confidence: 0.5, detail: "后台运行" };
  }
  apply(fp, target, st);
}

// 从命令行提取「在跑什么」（cmd /c "npm test" → npm）
function shortCmd(cmd) {
  const s = String(cmd || "").trim();
  if (!s) return "";
  const m = s.match(/\/c\s+"([^"]+)"/);
  if (m) return (m[1].split(/\s+/)[0] || "").replace(/^["']|["']$/g, "");
  return (s.split(/\s+/)[0] || "").replace(/^["']|["']$/g, "");
}

function evalDesktop(fp, sig, st) {
  let target;
  if (!sig.online) {
    target = { state: "offline", summary: `${fp.label} 未运行`, confidence: 0.9, detail: "进程不存在" };
    st.busyStreak = 0;
    st.idleStreak = 0;
  } else if (sig.cpuPct > cpuConf.busyPct) {
    st.busyStreak += 1;
    st.idleStreak = 0;
    if (st.busyStreak >= cpuConf.busyCycles) {
      target = { state: "running_command", summary: `${fp.label} 正在忙`, confidence: 0.55, detail: `CPU ${Math.round(sig.cpuPct)}%`, raw: { cpu_pct: Math.round(sig.cpuPct) } };
    }
  } else {
    st.idleStreak += 1;
    st.busyStreak = 0;
    if (sig.foreground) {
      target = { state: "using_tool", summary: `${fp.label} 在前台`, confidence: 0.6, detail: "窗口处于前台" };
    } else if (st.state === "running_command" && st.idleStreak < cpuConf.idleCycles) {
      target = null; // 忙->闲需确认，保持
    } else {
      target = { state: "idle", summary: `${fp.label} 在线`, confidence: 0.5, detail: "后台运行" };
    }
  }
  apply(fp, target, st);
}

// ---------- 周期：HTTP 探测（ComfyUI / Ollama / LM Studio / SD WebUI） ----------
async function httpTick() {
  for (const fp of fps) {
    if (!fp.httpProbe) continue;
    const st = states.get(fp.source);
    let reachable = false;
    let data = null;
    try {
      const r = await fetch(fp.httpProbe.baseUrl + fp.httpProbe.healthPath, { signal: AbortSignal.timeout(2500) });
      reachable = r.ok;
    } catch {
      reachable = false;
    }
    if (reachable) {
      try {
        const r2 = await fetch(fp.httpProbe.baseUrl + fp.httpProbe.dataPath, { signal: AbortSignal.timeout(2500) });
        if (r2.ok) data = await r2.json().catch(() => null);
      } catch {
        /* ignore */
      }
    }
    st.httpSeen = true;
    if (reachable || st.online) st.everOnline = true;
    if (!st.everOnline) continue; // 从未在本机检测到，不报 offline
    evalHttp(fp, { online: st.online, reachable, data, cpuPct: st.cpuPct }, st);
  }
}

function evalHttp(fp, sig, st) {
  const kind = fp.httpProbe.kind;
  let target;

  if (!sig.reachable && !sig.online) {
    target = { state: "offline", summary: `${fp.label} 未运行`, confidence: 0.9, detail: "服务与进程均不可见" };
  } else if (kind === "comfyui") {
    const running = sig.data?.queue_running?.length || 0;
    const pending = sig.data?.queue_pending?.length || 0;
    if (!sig.reachable) {
      target = { state: "idle", summary: `${fp.label} 在线（进程）`, confidence: 0.5, detail: "HTTP 未就绪但进程在" };
    } else if (running > 0) {
      target = { state: "running_command", summary: `${fp.label} 正在出图${pending ? `，队列剩 ${pending}` : ""}`, confidence: 0.9, detail: `运行 ${running} / 排队 ${pending}`, raw: { running, pending } };
    } else {
      target = { state: "idle", summary: `${fp.label} 空闲`, confidence: 0.85, detail: pending ? `队列待 ${pending}` : "队列空", raw: { pending } };
    }
  } else if (kind === "ollama") {
    if (!sig.reachable) {
      target = { state: "idle", summary: `${fp.label} 在线（进程）`, confidence: 0.5, detail: "HTTP 未就绪但进程在" };
    } else {
      const models = sig.data?.models || [];
      const name = models[0]?.name || models[0]?.model || "";
      if (models.length === 0) {
        target = { state: "idle", summary: `${fp.label} 空闲`, confidence: 0.8, detail: "无加载模型" };
      } else if (fp.busyOnCpu && Date.now() < (st.inferringUntil || 0)) {
        // CPU 尖峰锁存期内 → 正在推理（GPU 推理 runner CPU 突发，靠 tick 里的尖峰锁存判定）
        target = { state: "using_tool", summary: `${fp.label} 正在推理${name ? `（${name}）` : ""}`, confidence: 0.7, detail: `模型 ${name}`, raw: { model: name } };
      } else {
        target = { state: "idle", summary: `${fp.label} 已加载${name ? ` ${name}` : ""}`, confidence: 0.6, detail: `${models.length} 个模型热加载`, raw: { models: models.map((m) => m.name || m.model) } };
      }
    }
  } else {
    // generic / sdwebui
    if (!sig.reachable) {
      target = { state: "idle", summary: `${fp.label} 在线（进程）`, confidence: 0.5 };
    } else if (fp.busyOnCpu && sig.cpuPct > cpuConf.busyPct) {
      target = { state: "running_command", summary: `${fp.label} 正在忙`, confidence: 0.6, detail: `CPU ${Math.round(sig.cpuPct)}%` };
    } else {
      target = { state: "idle", summary: `${fp.label} 在线`, confidence: 0.7 };
    }
  }
  apply(fp, target, st);
}

// ---------- 周期：1s 快采样 runner CPU（抓 Ollama 等 GPU 推理的 prefill 尖峰）----------
// GPU 推理时 runner（llama-server.exe）CPU 是突发性的，4s 采样窗口会把 ~1s 的 prefill 尖峰
// 均摊掉而漏检。这里每 1s 只采 busyOnCpu 工具的 runner 进程 CPU，命中即锁存「推理中」。
const FAST_PS = `$ErrorActionPreference='SilentlyContinue'; Get-Process | Where-Object { $_.ProcessName -match 'ollama|llama-server' } | Select-Object Id,CPU | ConvertTo-Json -Compress`;

async function fastTick() {
  if (!fps.some((f) => f.busyOnCpu)) return; // 没有 busyOnCpu 工具就跳过，省一次 PowerShell
  let arr;
  try {
    const out = await new Promise((resolve, reject) =>
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", FAST_PS], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 8000 }, (e, s) => (e ? reject(e) : resolve(s)))
    );
    arr = JSON.parse(out.trim() || "[]");
    if (!Array.isArray(arr)) arr = [arr];
  } catch {
    return;
  }
  const cur = new Map();
  let total = 0;
  for (const p of arr) {
    const cpu = Number(p.CPU);
    if (!Number.isFinite(cpu)) continue;
    cur.set(p.Id, cpu);
    const prev = fastPrev.get(p.Id);
    if (Number.isFinite(prev)) {
      const dt = (cpu - prev) * 100; // 1s 间隔 ×100 = 单核 %
      if (dt > 0) total += dt;
    }
  }
  fastPrev.clear();
  for (const [k, v] of cur) fastPrev.set(k, v);
  if (total > cpuConf.busyPct) {
    const until = Date.now() + (cpuConf.inferringLatchMs || 12000);
    for (const fp of fps) {
      if (!fp.busyOnCpu) continue;
      const st = states.get(fp.source);
      if (st) st.inferringUntil = until;
    }
  }
}

// ---------- 状态机：变化或定期刷新才上报 ----------
function apply(fp, target, st) {
  if (!target) return;
  const now = Date.now();
  // 从离线恢复到在线：立即上报，不受任何节流限制（解决"软件启动后延迟显示"问题）
  const comingOnline = st.state === "offline" && target.state !== "offline";
  if (target.state === st.state) {
    if (target.state === "running_command") {
      // 运行中：定期刷新进度
      if (now - st.lastReport < config.throttleMs * 3) return;
    } else {
      // 空闲/前台/完成/下线等：低频心跳保活，不刷屏
      if (now - st.lastReport < 30000) return;
    }
  }
  // 状态变化立即上报（comingOnline 优先跳过所有节流）
  st.state = target.state;
  st.lastReport = now;
  report(fp, target);
}

async function report(fp, t) {
  log(`[${fp.label}] -> ${t.state} | ${t.summary}`);
  const ev = {
    source: fp.source,
    instanceId: `${fp.source}::${machineId}`,
    sourceLabel: fp.label,
    label: fp.label,
    state: t.state,
    workspace: "",
    projectName: "",
    confidence: t.confidence ?? 0.5,
    summary: t.summary || fp.label,
    detail: t.detail || "",
    severity: t.severity || "info",
    raw: t.raw || {},
  };
  try {
    await dispatchEvent(ev);
  } catch {
    /* 单条上报失败不影响采集 */
  }
}

async function post(ev) {
  for (const url of [config.agentUrl, config.fallbackUrl]) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ev),
        signal: AbortSignal.timeout(2500),
      });
      if (r.status < 500) return; // 2xx/4xx 都视为端点存在（4xx 不回退）
    } catch {
      /* 试下一个端点 */
    }
  }
  // 两个端点都不通：静默（采集器不依赖 server 在线，server 起来后自然恢复）
}

// ---------- 采集（一次 PowerShell：进程 + CPU + 前台窗口） ----------
function collectAll() {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PS_COLLECT],
      { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 20000 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const obj = JSON.parse(stdout.trim() || "{}");
          resolve({ processes: norm(obj.processes), cpu: norm(obj.cpu), fg: obj.fg && typeof obj.fg === "object" ? obj.fg : {} });
        } catch (e) {
          reject(new Error("解析采集输出失败：" + e.message));
        }
      }
    );
  });
}

const PS_COLLECT = `$ErrorActionPreference='SilentlyContinue'
$procs = Get-CimInstance Win32_Process -Property Name,ProcessId,ParentProcessId,ExecutablePath,CommandLine | Where-Object { $_.ExecutablePath -or $_.CommandLine } | ForEach-Object { [PSCustomObject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; path=$_.ExecutablePath; cmd=$_.CommandLine } }
$cpu = Get-Process | Where-Object { $_.CPU } | ForEach-Object { [PSCustomObject]@{ pid=$_.Id; cpu=$_.CPU } }
$sig='[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);'
Add-Type -MemberDefinition $sig -Name FG -Namespace CS -ErrorAction SilentlyContinue
$fg=[PSCustomObject]@{ title=''; pid=0 }
try {
  $h=[CS.FG]::GetForegroundWindow()
  if ($h -ne [IntPtr]::Zero) {
    $sb=New-Object System.Text.StringBuilder 512
    [void][CS.FG]::GetWindowText($h,$sb,512)
    $fgpid=0; [void][CS.FG]::GetWindowThreadProcessId($h,[ref]$fgpid)
    $fg=[PSCustomObject]@{ title=$sb.ToString(); pid=$fgpid }
  }
} catch {}
[PSCustomObject]@{ processes=$procs; cpu=$cpu; fg=$fg } | ConvertTo-Json -Compress -Depth 5`;

// 作为独立 CLI 运行（node adapters/desktop-collector.mjs）：走 HTTP 上报。
// SEA / 被主进程 import 时不触发（process.argv[1] 为空或指向 exe），避免双启。
const __isCollectorMain = __thisFile && process.argv[1] && path.resolve(process.argv[1]) === __thisFile;
if (__isCollectorMain) {
  startCollector({ autoDiscover: true });
}

// ---------- 指纹匹配 ----------
function matchFp(fp, p) {
  const name = String(p.name || "").toLowerCase();
  const full = (String(p.path || "") + " " + String(p.cmd || "")).toLowerCase();
  const cmd = String(p.cmd || "");

  const nameHit = (fp.processNames || []).some((n) => name === String(n).toLowerCase());
  let pathHit = (fp.pathKeywords || []).some((k) => full.includes(String(k).toLowerCase()));
  if (!pathHit && fp.runnerKeywords) pathHit = fp.runnerKeywords.some((k) => full.includes(String(k).toLowerCase()));
  let cmdHit = false;
  for (const pat of fp.commandPatterns || []) {
    try {
      if (new RegExp(pat, "i").test(cmd)) {
        cmdHit = true;
        break;
      }
    } catch {
      /* 坏正则忽略 */
    }
  }

  const hasCmd = (fp.commandPatterns || []).length > 0;
  const hasName = (fp.processNames || []).length > 0;
  // python 类（配了 commandPatterns）：必须命令行命中，且进程名对得上（若有）
  if (hasCmd) return cmdHit && (!hasName || nameHit);
  // 普通桌面应用：进程名命中即归属；无进程名则退回路径关键词
  if (hasName) return nameHit;
  return pathHit;
}

function kwMatch(keywords, text) {
  const t = String(text || "").toLowerCase();
  return (keywords || []).some((k) => t.includes(String(k).toLowerCase()));
}

// ---------- utils ----------
function norm(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function loadConfig(cfgPath) {
  try {
    return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (e) {
    // 抛出而非 process.exit：内嵌进主进程时退出会拖死整个 server，交调用方 try/catch。
    throw new Error("无法读取指纹库 " + cfgPath + "：" + e.message);
  }
}

function loadMachineId(idPath) {
  try {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    if (fs.existsSync(idPath)) return JSON.parse(fs.readFileSync(idPath, "utf8")).id;
  } catch {
    /* ignore */
  }
  const id = crypto.randomUUID();
  try {
    fs.writeFileSync(idPath, JSON.stringify({ id }, null, 2));
  } catch {
    /* ignore */
  }
  return id;
}

function log(msg) {
  console.log(`[CodeStatus ${new Date().toLocaleTimeString()}] ${msg}`);
}
