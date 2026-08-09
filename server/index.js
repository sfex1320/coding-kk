import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { URL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { Bonjour } from "bonjour-service";
import selfsigned from "selfsigned";
import { startTranscriptWatchers } from "./transcript-watcher.js";
import { startCollector } from "../adapters/desktop-collector.mjs";
import { maybeNotify, dispatch, mergeNotifySettings, DEFAULT_NOTIFY_SETTINGS } from "./notifier.js";
// 是否以单文件可执行(打包成的 .exe)方式运行：可执行文件名不是 node 即视为打包版
const isSeaBuild = !/^node(\.exe)?$/i.test(path.basename(process.execPath || "node"));

// 打包成 exe 时网页资源直接内嵌在 exe 里（SEA assets）
const seaApi = (() => {
  if (!isSeaBuild) return null;
  try {
    // 在 SEA 运行时 require 由 Node 提供；普通 ESM 运行不会走到这里
    return require("node:sea");
  } catch {
    return null;
  }
})();

// 打包成 exe 时，可写资源(data)放在 exe 同目录；普通 node 运行时放在工作目录
const BASE_DIR = isSeaBuild ? path.dirname(process.execPath) : process.cwd();

const PORT = Number(process.env.CODESTATUS_PORT || 4317);
const HTTPS_PORT = Number(process.env.CODESTATUS_HTTPS_PORT || 4318);
const FRONTEND_PORT = Number(process.env.CODESTATUS_FRONTEND_PORT || 5173);
const SERVE_FRONTEND = process.env.CODESTATUS_SERVE_FRONTEND === "1" || isSeaBuild;
const MAX_EVENTS = 200;
const DATA_DIR = path.join(BASE_DIR, "data");
const DATA_FILE = path.join(DATA_DIR, "status-agent.json");
const CERT_FILE = path.join(DATA_DIR, "https-cert.json");
const DIST_DIR = path.join(BASE_DIR, "dist");

// ---- 云端自然语音（微软 Edge 在线神经语音，免密钥）----
const TTS_TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
// 微软对该端点校验 Sec-MS-GEC-Version，需与较新的 Edge 版本一致；过期会 403。
const TTS_GEC_VERSION = "1-143.0.3650.75";
const TTS_WSS_BASE = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TTS_TRUSTED_TOKEN}`;
const TTS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const TTS_VOICES = [
  { id: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 温柔女声（默认）" },
  { id: "zh-CN-XiaoyiNeural", label: "晓伊 · 活泼女声" },
  { id: "zh-CN-YunxiNeural", label: "云希 · 阳光男声" },
  { id: "zh-CN-YunyangNeural", label: "云扬 · 专业男声" },
  { id: "zh-CN-YunjianNeural", label: "云健 · 浑厚男声" },
  { id: "zh-CN-XiaomengNeural", label: "晓梦 · 甜美女声" },
  { id: "zh-CN-YunxiaNeural", label: "云夏 · 少年音" },
  { id: "zh-CN-liaoning-XiaobeiNeural", label: "晓北 · 东北女声" },
  { id: "zh-HK-HiuMaanNeural", label: "曉曼 · 粤语女声" },
  { id: "zh-TW-HsiaoChenNeural", label: "曉臻 · 台湾女声" }
];
const TTS_DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";
const TTS_VOICE_IDS = new Set(TTS_VOICES.map((voice) => voice.id));
const ttsCache = new Map();

const toolLabels = {
  "claude-code": "Claude Code",
  "claude-dev": "Claude Dev",
  codex: "Codex",
  vscode: "VS Code",
  cursor: "Cursor",
  generic: "通用监控",
  // 采集器监控的常用 AI 工具（作为离线占位卡；运行后由采集器事件替换为实时状态）
  "opencode-desktop": "OpenCode",
  "kimi-desktop": "Kimi 桌面版",
  comfyui: "ComfyUI",
  ollama: "Ollama",
  pycharm: "PyCharm",
  autoglm: "AutoGLM"
};

const initialTools = Object.keys(toolLabels).reduce((acc, source) => {
  const instanceId = `${source}::placeholder`;
  acc[instanceId] = {
    instanceId,
    source,
    sourceLabel: toolLabels[source],
    label: toolLabels[source],
    state: "offline",
    severity: "info",
    title: `${toolLabels[source]} 未连接`,
    message: "等待适配器上报状态",
    workspace: "",
    projectName: "",
    sessionId: "",
    confidence: 0,
    updatedAt: null,
    isPlaceholder: true
  };
  return acc;
}, {});

const store = {
  tools: initialTools,
  events: [],
  settings: loadSettings()
};

const requestHandler = async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    return send(res, 204);
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    if (!authorize(req, url)) return sendJson(res, { error: "Pairing token required" }, 401);
    touchDevice(req, url);
    return sendJson(res, snapshot());
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    if (!authorize(req, url)) return sendJson(res, { error: "Pairing token required" }, 401);
    touchDevice(req, url);
    return sendJson(res, store.events);
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    if (!isLoopback(req)) return sendJson(res, { error: "Desktop access required" }, 403);
    return sendJson(res, store.settings);
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    if (!isLoopback(req)) return sendJson(res, { error: "Desktop access required" }, 403);
    const body = await readJson(req);
    const notify = body.notify ? mergeNotifySettings(store.settings.notify, body.notify) : store.settings.notify;
    store.settings = { ...store.settings, ...body, notify };
    saveSettings();
    broadcast({ type: "settings", settings: publicSettings(), status: snapshot() });
    return sendJson(res, store.settings);
  }

  if (req.method === "GET" && url.pathname === "/api/pairing") {
    const pairCode = createPairingCode();
    const connectUrl = `http://${localAddress(req)}:${FRONTEND_PORT}?display=1&pair=${pairCode}`;
    return sendJson(res, {
      lanEnabled: store.settings.lanEnabled,
      authEnabled: store.settings.authEnabled,
      privacyMode: Boolean(store.settings.privacyMode),
      pairCode: isLoopback(req) ? pairCode : undefined,
      pairingToken: isLoopback(req) ? store.settings.pairingToken : undefined,
      connectUrl: isLoopback(req) ? connectUrl : undefined,
      frontendPort: FRONTEND_PORT,
      addresses: isLoopback(req) ? lanAddresses(false).map((a) => a.address) : undefined,
      allAddresses: isLoopback(req) ? lanAddresses(true).map((a) => ({ name: a.name, address: a.address })) : undefined,
      secureAgentUrl: isLoopback(req) ? secureAgentUrl(req) : undefined,
      certificateFingerprint: isLoopback(req) ? certificateInfo?.fingerprint256 : undefined,
      devices: isLoopback(req) ? store.settings.devices.map(publicDevice) : undefined,
      revokedDevices: isLoopback(req) ? (store.settings.revokedDevices || []) : undefined
    });
  }

  if (req.method === "POST" && url.pathname === "/api/pairing/claim") {
    const body = await readJson(req);
    const session = pairingSessions.get(String(body.pairCode || ""));
    if (!session || session.expiresAt < Date.now()) return sendJson(res, { error: "Pairing code expired" }, 401);
    pairingSessions.delete(String(body.pairCode || ""));
    const device = registerDevice(req, {
      deviceId: body.deviceId,
      name: body.name || "Mobile Status Screen",
      issueDeviceSecret: true
    });
    if (!device) return sendJson(res, { error: "Device revoked" }, 403);
    return sendJson(res, { ok: true, device, agent: discoveryInfo(req) });
  }

  if (req.method === "POST" && url.pathname === "/api/pairing/rotate") {
    if (!isLoopback(req)) return sendJson(res, { error: "Desktop access required" }, 403);
    store.settings.pairingToken = crypto.randomBytes(18).toString("base64url");
    store.settings.devices = [];
    saveSettings();
    broadcast({ type: "settings", settings: publicSettings(), status: snapshot() });
    return sendJson(res, { ok: true, pairingToken: store.settings.pairingToken });
  }

  if (req.method === "POST" && url.pathname === "/api/devices/register") {
    if (!authorize(req, url)) return sendJson(res, { error: "Pairing token required" }, 401);
    const body = await readJson(req);
    const device = registerDevice(req, body);
    if (!device) return sendJson(res, { error: "Device revoked" }, 403);
    return sendJson(res, { ok: true, device });
  }

  if (req.method === "DELETE" && url.pathname === "/api/devices") {
    if (!isLoopback(req)) return sendJson(res, { error: "Desktop access required" }, 403);
    const body = await readJson(req);
    const revoked = store.settings.devices.find((device) => device.id === body.deviceId);
    store.settings.devices = store.settings.devices.filter((device) => device.id !== body.deviceId);
    store.settings.revokedDevices = [
      {
        id: body.deviceId,
        name: revoked?.name || body.deviceId,
        ip: revoked?.ip || "",
        revokedAt: new Date().toISOString()
      },
      ...(store.settings.revokedDevices || []).filter((device) => device.id !== body.deviceId)
    ].slice(0, 100);
    saveSettings();
    broadcast({ type: "settings", settings: publicSettings(), status: snapshot() });
    return sendJson(res, {
      ok: true,
      devices: store.settings.devices.map(publicDevice),
      revokedDevices: store.settings.revokedDevices
    });
  }

  if (req.method === "GET" && url.pathname === "/api/discovery") {
    return sendJson(res, discoveryInfo(req));
  }

  if (req.method === "GET" && url.pathname === "/api/network-diagnostics") {
    if (!isLoopback(req)) return sendJson(res, { error: "Desktop access required" }, 403);
    return sendJson(res, await networkDiagnostics(req));
  }

  if (req.method === "POST" && (url.pathname === "/events" || url.pathname === "/api/events")) {
    if (!isLoopback(req) && !authorize(req, url)) return sendJson(res, { error: "Pairing token required" }, 401);
    const body = await readJson(req);
    const event = ingest(body);
    return sendJson(res, { ok: true, event, status: snapshot() });
  }

  if (req.method === "POST" && url.pathname === "/api/simulate") {
    if (!isLoopback(req)) return sendJson(res, { error: "Desktop access required" }, 403);
    const body = await readJson(req);
    const event = ingest({
      source: body.source || "claude-code",
      state: body.state || "thinking",
      severity: body.severity || "info",
      title: body.title,
      message: body.message,
      workspace: body.workspace || "G:/Project/demo",
      model: body.model
    });
    return sendJson(res, { ok: true, event, status: snapshot() });
  }

  if (req.method === "POST" && url.pathname === "/api/notify/test") {
    if (!isLoopback(req)) return sendJson(res, { error: "Desktop access required" }, 403);
    const body = await readJson(req);
    const notify = mergeNotifySettings(store.settings.notify, body.notify || {});
    const results = await dispatch(
      notify,
      "CodeStatus 测试推送",
      `这是一条来自 CodeStatus 的测试消息。\n时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`
    );
    return sendJson(res, { ok: results.every((item) => item.ok), results });
  }

  if (req.method === "GET" && url.pathname === "/api/tts/voices") {
    if (!authorize(req, url)) return sendJson(res, { error: "Pairing token required" }, 401);
    return sendJson(res, { voices: TTS_VOICES, defaultVoice: TTS_DEFAULT_VOICE });
  }

  if (req.method === "POST" && url.pathname === "/api/tts") {
    if (!authorize(req, url)) return sendJson(res, { error: "Pairing token required" }, 401);
    const body = await readJson(req);
    const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (!text) return sendJson(res, { error: "缺少文本" }, 400);
    const voice = TTS_VOICE_IDS.has(body.voice) ? body.voice : TTS_DEFAULT_VOICE;
    let rate = Number(body.rate);
    if (!Number.isFinite(rate)) rate = 0;
    rate = Math.max(-50, Math.min(100, Math.round(rate)));
    let volume = Number(body.volume);
    if (!Number.isFinite(volume)) volume = 1;
    volume = Math.max(0, Math.min(1, volume));

    const cacheKey = `${voice}|${rate}|${volume}|${text}`;
    let audio = ttsCache.get(cacheKey);
    if (!audio) {
      try {
        audio = await synthesizeWithRetry(text, voice, rate, volume);
      } catch (error) {
        return sendJson(res, { error: `TTS 失败：${error.message}` }, 502);
      }
      if (audio?.length) {
        ttsCache.set(cacheKey, audio);
        if (ttsCache.size > 60) ttsCache.delete(ttsCache.keys().next().value);
      }
    }
    if (!audio?.length) return sendJson(res, { error: "TTS 无音频" }, 502);
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Content-Length": audio.length,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    return res.end(audio);
  }

  if (req.method === "POST" && url.pathname === "/api/open") {
    if (!isLoopback(req)) return sendJson(res, { error: "Desktop access required" }, 403);
    openBrowser(`http://127.0.0.1:${FRONTEND_PORT}`);
    return sendJson(res, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/shutdown") {
    if (!isLoopback(req)) return sendJson(res, { error: "Desktop access required" }, 403);
    sendJson(res, { ok: true });
    setImmediate(gracefulShutdown);
    return;
  }

  return sendJson(res, { error: "Not found" }, 404);
};

// 计算微软要求的 Sec-MS-GEC 令牌：5 分钟取整的 Windows 文件时间 + TrustedToken 的 SHA256
function ttsGenerateSecMsGec() {
  let ticks = Date.now() / 1000;
  ticks += 11644473600; // Unix 纪元 -> Windows 纪元(1601)
  ticks -= ticks % 300; // 向下取整到 5 分钟
  ticks *= 10000000; // 秒 -> 100 纳秒单位
  return crypto.createHash("sha256").update(`${Math.floor(ticks)}${TTS_TRUSTED_TOKEN}`).digest("hex").toUpperCase();
}

function ttsBuildSsml(text, voice, ratePercent, volume = 1) {
  const safe = String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const lang = voice.split("-").slice(0, 2).join("-");
  const rate = `${ratePercent >= 0 ? "+" : ""}${ratePercent}%`;
  const vol = `${Math.round(Math.max(0, Math.min(1, volume)) * 100)}`;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${voice}"><prosody rate="${rate}" volume="${vol}">${safe}</prosody></voice></speak>`;
}

// 网络偶发抖动（TLS 断开等）时重试一次，提升手机端播报成功率
async function synthesizeWithRetry(text, voice, rate, volume, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const audio = await synthesizeEdgeTts(text, voice, rate, volume);
      if (audio?.length) return audio;
      lastError = new Error("空音频");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("TTS 失败");
}

function synthesizeEdgeTts(text, voice, ratePercent = 0, volume = 1) {
  return new Promise((resolve, reject) => {
    const connectionId = crypto.randomUUID().replace(/-/g, "");
    const wsUrl = `${TTS_WSS_BASE}&Sec-MS-GEC=${ttsGenerateSecMsGec()}&Sec-MS-GEC-Version=${TTS_GEC_VERSION}&ConnectionId=${connectionId}`;
    const ws = new WebSocket(wsUrl, {
      headers: {
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": TTS_USER_AGENT
      }
    });

    const chunks = [];
    let settled = false;
    let timer = null;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      fn();
    };
    timer = setTimeout(() => finish(() => reject(new Error("Edge TTS 超时"))), 5000);

    ws.on("open", () => {
      ws.send(
        `X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
                  outputFormat: "audio-24khz-48kbitrate-mono-mp3"
                }
              }
            }
          })
      );
      const requestId = crypto.randomUUID().replace(/-/g, "");
      ws.send(
        `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toISOString()}\r\nPath:ssml\r\n\r\n${ttsBuildSsml(text, voice, ratePercent, volume)}`
      );
    });

    // 不依赖 isBinary（SEA 打包环境下该标志不可靠）：按帧内容区分音频帧与控制帧
    ws.on("message", (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length >= 2) {
        const headerLen = buf.readUInt16BE(0);
        // 二进制音频帧：前 2 字节是头部长度，头部含 "Path:audio"，其后才是 mp3 数据
        if (headerLen > 0 && headerLen + 2 <= buf.length) {
          const header = buf.subarray(2, 2 + headerLen).toString("utf8");
          if (header.includes("Path:audio")) {
            const audio = buf.subarray(2 + headerLen);
            if (audio.length) chunks.push(audio);
            return;
          }
        }
      }
      if (buf.toString("utf8").includes("Path:turn.end")) {
        finish(() => resolve(Buffer.concat(chunks)));
      }
    });

    ws.on("error", (error) => finish(() => reject(error)));
    ws.on("close", () =>
      finish(() => (chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error("Edge TTS 连接关闭"))))
    );
  });
}

const server = http.createServer(requestHandler);

const websocketServers = [];
let certificateInfo = null;
let httpsServer = null;
const pairingSessions = new Map();
// 后台常驻相关：托盘子进程（PowerShell NotifyIcon）与采集器停止函数，退出时统一回收。
let trayChild = null;
let collectorStop = null;

// 启动流程（包装为函数，避免顶层 await，以便打包成单文件 exe）
async function bootstrap() {
  setupWebSocket(server);

  // 便携版：尽早启动托盘并隐藏控制台（后台常驻），日志落盘 data/server.log 便于排查。
  if (isSeaBuild) {
    if (process.env.CODESTATUS_LOG_FILE !== "0") redirectLogs();
    trayChild = startSystemTray();
  }

  httpsServer = await createHttpsServer();
  if (httpsServer) setupWebSocket(httpsServer);

  // 端口被占用时不崩溃：多半是已经有一个实例在运行，直接打开浏览器看那个
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`端口 ${PORT} 已被占用：CodeStatus 可能已经在运行。正在打开浏览器…`);
      openBrowser(`http://127.0.0.1:${FRONTEND_PORT}`);
      setTimeout(() => process.exit(0), 2500);
    } else {
      console.error(`Agent 启动失败：${err.message}`);
      setTimeout(() => process.exit(1), 2500);
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`CodeStatus Agent listening on http://127.0.0.1:${PORT}`);
    publishDiscovery();
    // 日志文件监听：不依赖 CLI hooks，VS Code 插件版的 Claude Code / Codex 也能被监控
    if (process.env.CODESTATUS_DISABLE_WATCHER !== "1") {
      try {
        startTranscriptWatchers((event) => ingest(event));
      } catch (error) {
        console.warn(`[watcher] 日志监听启动失败：${error.message}`);
      }
    }
    // 内嵌采集器：监控 ComfyUI / Ollama / OpenCode / Kimi / PyCharm 等 AI 工具，事件直送 ingest（免 HTTP）。
    // 便携版读取 exe 同级 config/fingerprints.json；自动发现在 SEA 下关闭（见 desktop-collector.mjs）。
    if (process.env.CODESTATUS_DISABLE_COLLECTOR !== "1") {
      try {
        collectorStop = startCollector({
          fingerprintsPath: path.join(BASE_DIR, "config", "fingerprints.json"),
          onEvent: (event) => ingest(event),
          autoDiscover: !isSeaBuild
        });
      } catch (error) {
        console.warn(`[collector] 采集器启动失败：${error.message}`);
      }
    }
    // 主服务起来后即可打开浏览器（前端可能由本进程或 vite 提供）
    if (isSeaBuild) {
      openBrowser(`http://127.0.0.1:${FRONTEND_PORT}`);
      // 便携版首次运行：在桌面放一个快捷方式（幂等，已存在则跳过）
      ensureDesktopShortcut();
    }
  });

  if (httpsServer) {
    httpsServer.on("error", () => {});
    httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
      console.log(`CodeStatus Agent secure channel listening on https://127.0.0.1:${HTTPS_PORT}`);
    });
  }

  if (SERVE_FRONTEND) {
    const frontendServer = http.createServer(staticFrontendHandler);
    frontendServer.on("error", () => {});
    frontendServer.listen(FRONTEND_PORT, "0.0.0.0", () => {
      console.log(`CodeStatus frontend listening on http://127.0.0.1:${FRONTEND_PORT}`);
    });
  }
}

// 干净退出：托盘子进程 -> 采集器 -> mDNS -> WebSocket/HTTP，最后 process.exit。
// 由托盘「退出软件」(POST /api/shutdown) 或 SIGINT/SIGTERM 触发。
function gracefulShutdown() {
  console.log("[shutdown] 收到退出请求，正在关闭…");
  try {
    trayChild?.kill();
  } catch {
    // best-effort
  }
  try {
    collectorStop?.();
  } catch {
    // best-effort
  }
  try {
    publishedService?.stop?.();
    publishedService = null;
  } catch {
    // best-effort
  }
  for (const wss of websocketServers) {
    try {
      wss.close();
    } catch {
      // best-effort
    }
  }
  try {
    server.close();
  } catch {
    // best-effort
  }
  try {
    httpsServer?.close();
  } catch {
    // best-effort
  }
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", () => gracefulShutdown());
process.on("SIGTERM", () => gracefulShutdown());

function openBrowser(target) {
  try {
    if (process.platform === "win32") execFile("cmd.exe", ["/c", "start", "", target], { windowsHide: true });
    else if (process.platform === "darwin") execFile("open", [target]);
    else execFile("xdg-open", [target]);
  } catch {
    // 打开浏览器是尽力而为
  }
}

// 便携版首次运行：在桌面放一个快捷方式（已存在则跳过，幂等）。
// 开发模式（node server）不创建，避免污染开发者桌面。
function ensureDesktopShortcut() {
  if (process.platform !== "win32" || !isSeaBuild) return;
  const LNK = "CodeStatus 监控.lnk";
  const exe = process.execPath;
  const workDir = BASE_DIR;
  // 便宜的本地存在性检查，避免每次启动都拉起 PowerShell（OneDrive 重定向也覆盖）
  const home = os.homedir();
  if (
    fs.existsSync(path.join(home, "Desktop", LNK)) ||
    fs.existsSync(path.join(home, "OneDrive", "Desktop", LNK))
  ) {
    return;
  }
  // 交给 PowerShell：用真实桌面路径（兼容 OneDrive 重定向 / 显示名本地化），自带 Test-Path 幂等。
  // 用 -EncodedCommand（UTF-16LE base64）传中文，规避控制台代码页乱码。
  const q = (s) => String(s).replace(/'/g, "''");
  const ps = [
    "$d=[Environment]::GetFolderPath('Desktop')",
    "if(-not $d){exit 1}",
    `$lnk=Join-Path $d '${q(LNK)}'`,
    "if(Test-Path -LiteralPath $lnk){exit 0}",
    "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($lnk)",
    `$s.TargetPath='${q(exe)}'`,
    `$s.WorkingDirectory='${q(workDir)}'`,
    `$s.IconLocation='${q(exe)},0'`,
    "$s.Description='CodeStatus 电脑端监控'",
    "$s.Save()"
  ].join(";");
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { windowsHide: true, timeout: 8000 },
    (err) => {
      if (err) console.log(`[快捷方式] 创建跳过/失败：${err.message || err.code}`);
    }
  );
}

// 任务栏托盘 PowerShell 脚本（便携版后台常驻）：
//  1) 隐藏父进程(exe)的控制台窗口（PS 子进程继承同一控制台，GetConsoleWindow 返回的即 exe 的控制台）；
//  2) NotifyIcon + 右键菜单「打开软件页面 / 退出软件」，菜单动作回打本机 HTTP 端点；
//  3) 父进程看门狗：exe 一旦消失（崩溃/被杀/端口占用自退），托盘自动消失，避免残留图标。
// 用 -EncodedCommand（UTF-16LE base64）传递，规避控制台代码页对中文的乱码。
const TRAY_PS_SCRIPT = `
$ErrorActionPreference='Continue'
Add-Type -Namespace CStat -Name Win -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int n);'
if($env:CODESTATUS_NO_HIDE -ne '1'){
  $h=[CStat.Win]::GetConsoleWindow()
  if($h -ne [System.IntPtr]::Zero){ [void][CStat.Win]::ShowWindow($h,0) }
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$exePid=$env:CODESTATUS_EXE_PID
$base='http://127.0.0.1:4317'
$icon=New-Object System.Windows.Forms.NotifyIcon
try{ $icon.Icon=[System.Drawing.Icon]::ExtractAssociatedIcon($env:CODESTATUS_EXE) }catch{ try{ $icon.Icon=[System.Drawing.SystemIcons]::Application }catch{} }
$icon.Text='CodeStatus 监控'
$icon.Visible=$true
$menu=New-Object System.Windows.Forms.ContextMenuStrip
$open=$menu.Items.Add('打开软件页面')
$quit=$menu.Items.Add('退出软件')
$open.Add_Click({ try{ Invoke-WebRequest -UseBasicParsing -Method POST -Uri ($base+'/api/open') -TimeoutSec 3 }catch{} })
$quit.Add_Click({ try{ Invoke-WebRequest -UseBasicParsing -Method POST -Uri ($base+'/api/shutdown') -TimeoutSec 3 }catch{}; $icon.Visible=$false; Start-Sleep -Milliseconds 600; try{ Stop-Process -Id $exePid -Force -ErrorAction SilentlyContinue }catch{}; [System.Windows.Forms.Application]::Exit() })
$icon.ContextMenuStrip=$menu
$watch=New-Object System.Windows.Forms.Timer
$watch.Interval=2000
$watch.Add_Tick({ try{ $null=Get-Process -Id $exePid -ErrorAction Stop }catch{ $icon.Visible=$false; $watch.Stop(); [System.Windows.Forms.Application]::Exit() } })
$watch.Start()
[System.Windows.Forms.Application]::Run()
`;

// 启动托盘（仅便携版）。返回 PS 子进程，退出时由 gracefulShutdown 回收。
function startSystemTray() {
  if (process.platform !== "win32" || !isSeaBuild) return null;
  const encoded = Buffer.from(TRAY_PS_SCRIPT, "utf16le").toString("base64");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      windowsHide: true,
      env: { ...process.env, CODESTATUS_EXE: process.execPath, CODESTATUS_EXE_PID: String(process.pid) }
    }
  );
  child.on("error", (err) => console.warn(`[tray] 托盘启动失败：${err.message}`));
  return child;
}

// 控制台被托盘隐藏后，把 stdout/stderr 落盘到 data/server.log，便于排查启动问题。
function redirectLogs() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const stream = fs.createWriteStream(path.join(DATA_DIR, "server.log"), { flags: "a" });
    process.stdout.write = (chunk, ...rest) => stream.write(chunk, ...rest);
    process.stderr.write = (chunk, ...rest) => stream.write(chunk, ...rest);
    stream.write(`\n===== CodeStatus 启动 ${new Date().toISOString()} =====\n`);
  } catch {
    // 日志重定向失败不影响运行
  }
}

bootstrap();

function setupWebSocket(targetServer) {
  const wss = new WebSocketServer({ server: targetServer, path: "/ws" });
  websocketServers.push(wss);
  // ws 会把 http server 的 error 转发到这里，必须有 handler，否则端口占用时进程崩溃
  wss.on("error", () => {});
  wss.on("connection", (socket, req) => {
    const url = new URL(req.url || "/ws", `http://${req.headers.host}`);
    if (!authorize(req, url)) {
      socket.close(1008, "Pairing token required");
      return;
    }
    touchDevice(req, url);
    socket.send(JSON.stringify({ type: "snapshot", status: snapshot(), settings: publicSettings() }));
  });
  return wss;
}

async function createHttpsServer() {
  if (process.env.CODESTATUS_DISABLE_HTTPS === "1") return null;
  try {
    const cert = await loadOrCreateCertificate();
    certificateInfo = {
      fingerprint256: certificateFingerprint(cert.cert),
      createdAt: cert.createdAt,
      expiresAt: cert.expiresAt
    };
    return https.createServer({ key: cert.private, cert: cert.cert }, requestHandler);
  } catch (error) {
    console.warn(`HTTPS channel disabled: ${error.message}`);
    return null;
  }
}

async function loadOrCreateCertificate() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(CERT_FILE)) {
    try {
      const cert = JSON.parse(fs.readFileSync(CERT_FILE, "utf8"));
      if (cert.private && cert.cert) return cert;
    } catch {
      // Regenerate below when the persisted certificate is unreadable.
    }
  }

  const generated = await selfsigned.generate(
    [
      { name: "commonName", value: "CodeStatus Companion Local Agent" },
      { name: "organizationName", value: "CodeStatus Companion" }
    ],
    {
      days: 365,
      keySize: 2048,
      algorithm: "sha256",
      extensions: [
        {
          name: "subjectAltName",
          altNames: [
            { type: 2, value: "localhost" },
            { type: 7, ip: "127.0.0.1" },
            { type: 7, ip: firstLanAddress() }
          ]
        }
      ]
    }
  );
  const cert = {
    private: generated.private,
    cert: generated.cert,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
  };
  fs.writeFileSync(CERT_FILE, JSON.stringify(cert, null, 2), "utf8");
  return cert;
}

function certificateFingerprint(certPem) {
  const body = String(certPem)
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  return crypto.createHash("sha256").update(Buffer.from(body, "base64")).digest("hex").match(/.{2}/g).join(":").toUpperCase();
}

let bonjour;
let publishedService;

function publishDiscovery() {
  if (process.env.CODESTATUS_DISABLE_MDNS === "1") return;
  try {
    bonjour = new Bonjour();
    publishedService = bonjour.publish({
      name: "CodeStatus Companion",
      type: "codestatus",
      protocol: "tcp",
      port: httpsServer ? HTTPS_PORT : PORT,
      txt: {
        id: store.settings.agentId,
        name: store.settings.agentName,
        httpPort: String(PORT),
        httpsPort: httpsServer ? String(HTTPS_PORT) : "",
        secure: httpsServer ? "1" : "0",
        auth: store.settings.authEnabled ? "1" : "0",
        path: "/api/status",
        fingerprint256: certificateInfo?.fingerprint256 || ""
      }
    });
  } catch (error) {
    console.warn(`mDNS discovery disabled: ${error.message}`);
  }
}

function createPairingCode() {
  const code = crypto.randomBytes(5).toString("base64url").toUpperCase();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  pairingSessions.set(code, { expiresAt });
  for (const [key, value] of pairingSessions.entries()) {
    if (value.expiresAt < Date.now()) pairingSessions.delete(key);
  }
  return code;
}

// 「完成」需要静默确认：真正结束前，子轮 / 子代理会不断触发 end_turn / SubagentStop，
// 直接播报会“早鸣”。收到 completed 后先静默一小段时间，其间只要有新活动就撤销，
// 只有确实安静下来才判定为整体完成——避免“一个小轮结束就播报已完成，但整体还在跑”。
const pendingCompletions = new Map(); // instanceId -> { event, timer }

function completedSettleMs() {
  const raw = Number(store.settings?.notify?.completedGraceSeconds);
  const seconds = Number.isFinite(raw) ? raw : 10;
  return Math.min(120, Math.max(0, seconds)) * 1000;
}

function ingest(input) {
  const event = normalizeEvent(input);
  const instanceId = event.instanceId;
  const pending = pendingCompletions.get(instanceId);

  if (event.state === "completed") {
    // 收到完成：暂缓提交，进入静默确认期（连续多个 end_turn 只保留最后一个）
    if (pending) clearTimeout(pending.timer);
    const settleMs = completedSettleMs();
    if (settleMs <= 0) {
      pendingCompletions.delete(instanceId);
      return commit(event);
    }
    const record = { event, timer: null };
    record.timer = setTimeout(() => {
      pendingCompletions.delete(instanceId);
      commit(record.event);
    }, settleMs);
    pendingCompletions.set(instanceId, record);
    return event; // 静默期确认后再广播 / 推送
  }

  if (pending) {
    clearTimeout(pending.timer);
    pendingCompletions.delete(instanceId);
    // 明确空闲 / 离线：确认之前那次完成后再处理本事件；
    // 其它状态说明任务其实还在跑，直接丢弃这次“完成”。
    if (event.state === "idle" || event.state === "offline") {
      commit(pending.event);
    }
  }

  return commit(event);
}

// 真正落库 + 广播 + 推送（前态从 store 现值读取，即“本事件之前的状态”）
function commit(event) {
  const instanceId = event.instanceId;
  const prevState = store.tools[instanceId]?.state;
  store.tools[instanceId] = {
    ...(store.tools[instanceId] || {
      instanceId,
      source: event.source
    }),
    sourceLabel: event.sourceLabel,
    label: event.label,
    state: event.state,
    severity: event.severity,
    title: event.title,
    message: event.message,
    workspace: event.workspace,
    projectName: event.projectName,
    sessionId: event.sessionId,
    confidence: event.confidence,
    model: event.model,
    hookEvent: event.hookEvent,
    toolName: event.toolName,
    command: event.command,
    updatedAt: event.createdAt,
    isPlaceholder: false
  };

  store.events.unshift(event);
  store.events = store.events.slice(0, MAX_EVENTS);

  const status = snapshot();
  broadcast({ type: "event", event, status });
  try {
    maybeNotify(event, prevState, store.settings);
  } catch (error) {
    console.warn(`[notify] 推送异常：${error.message}`);
  }
  return event;
}

function normalizeEvent(input = {}) {
  const raw = input.raw || input;
  const source = input.source || inferSource(raw);
  const hookEvent = input.hookEventName || input.hook_event_name || raw.hookEventName || raw.hook_event_name || raw.event;
  const toolName = input.toolName || input.tool_name || raw.tool_name;
  const command = raw.tool_input?.command || input.command || "";
  const workspace = input.workspace || raw.cwd || raw.workspace || raw.transcript_path || "";
  const sessionId = input.sessionId || input.session_id || raw.session_id || "";
  const projectName = input.projectName || raw.project_name || projectNameFromWorkspace(workspace);
  const instanceId = input.instanceId || makeInstanceId(source, sessionId, workspace, projectName);
  const model = input.model || inferModel(raw);
  const mapped = input.state || input.status || mapActivityToState(input.activity || input.phase || raw.activity || raw.phase) || mapHookToState(hookEvent, toolName, command, raw);
  const state = mapped || "thinking";
  const severity = input.severity || stateSeverity(state, hookEvent);
  const sourceLabel = input.sourceLabel || toolLabels[source] || source;
  const label = input.label || (projectName ? `${sourceLabel} · ${projectName}` : sourceLabel);

  return {
    eventId: input.eventId || crypto.randomUUID(),
    instanceId,
    source,
    sourceLabel,
    label,
    workspace,
    projectName,
    sessionId,
    hookEvent,
    toolName,
    command,
    model,
    state,
    confidence: Number(input.confidence ?? (source === "generic" ? 0.55 : 0.9)),
    title: input.title || input.summary || defaultTitle(source, state),
    message: input.summary || input.message || input.detail || defaultMessage(hookEvent, toolName, command, state, raw),
    severity,
    createdAt: input.createdAt || new Date().toISOString(),
    raw: sanitizeRaw(raw)
  };
}

function sanitizeRaw(raw = {}) {
  const sanitized = {
    hook_event_name: raw.hook_event_name || raw.hookEventName || raw.event,
    session_id: raw.session_id,
    cwd: raw.cwd,
    transcript_path: raw.transcript_path,
    permission_mode: raw.permission_mode,
    model: inferModel(raw),
    notification_type: raw.notification_type,
    message: raw.message || raw.notification || raw.notification_message,
    prompt: raw.prompt ? trimText(raw.prompt, 160) : undefined,
    tool_name: raw.tool_name,
    tool_input: summarizeToolInput(raw.tool_input),
    tool_use_id: raw.tool_use_id,
    duration_ms: raw.duration_ms,
    stop_hook_active: raw.stop_hook_active,
    tool_calls: Array.isArray(raw.tool_calls)
      ? raw.tool_calls.slice(0, 12).map((call) => ({
          tool_name: call.tool_name,
          tool_input: summarizeToolInput(call.tool_input),
          tool_use_id: call.tool_use_id
        }))
      : undefined
  };

  return Object.fromEntries(Object.entries(sanitized).filter(([, value]) => value !== undefined));
}

function summarizeToolInput(input) {
  if (!input) return undefined;
  if (typeof input === "string") return trimText(input, 220);

  const allowed = {};
  for (const key of ["file_path", "notebook_path", "path", "command", "pattern", "url", "description", "prompt"]) {
    if (input[key] !== undefined) allowed[key] = typeof input[key] === "string" ? trimText(input[key], 220) : input[key];
  }
  return Object.keys(allowed).length ? allowed : "[redacted]";
}

function inferSource(raw) {
  if (raw?.hook_event_name || raw?.hookEventName || raw?.session_id || raw?.transcript_path) {
    return "claude-code";
  }
  return "generic";
}

function inferModel(raw = {}) {
  return (
    raw.model ||
    raw.model_id ||
    raw.modelId ||
    raw.actual_model ||
    raw.actualModel ||
    raw.effective_model ||
    raw.effectiveModel ||
    raw.config?.model ||
    raw.request?.model ||
    raw.metadata?.model ||
    raw.conversation?.model ||
    ""
  );
}

function makeInstanceId(source, sessionId, workspace, projectName) {
  const key = sessionId || workspace || projectName || "default";
  return `${source}::${hashKey(key)}`;
}

function hashKey(value) {
  return crypto.createHash("sha1").update(String(value || "default")).digest("hex").slice(0, 12);
}

function projectNameFromWorkspace(workspace) {
  if (!workspace) return "";
  const normalized = String(workspace).replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  const last = parts.at(-1) || "";
  if (last.endsWith(".jsonl") && parts.length > 1) return parts.at(-2) || last;
  return last;
}

function mapHookToState(hookEvent, toolName, command, raw) {
  const event = String(hookEvent || "").toLowerCase();
  const tool = String(toolName || "").toLowerCase();
  const cmd = String(command || "").toLowerCase();

  if (event === "sessionstart") return "idle";
  if (event === "sessionend") return "offline";
  if (event === "filechanged") return "writing_code";
  if (event === "cwdchanged" || event === "configchange") return "using_tool";
  if (event === "userpromptsubmit") return "prompt_submitted";
  if (event === "notification") {
    const kind = String(raw?.notification_type || raw?.type || raw?.message || "").toLowerCase();
    if (kind.includes("permission")) return "waiting_permission";
    return "waiting_user";
  }
  if (event === "permissionrequest") return "waiting_permission";
  if (event === "posttoolusefailure" || event === "stopfailure" || event === "permissiondenied") return "failed";
  if (event === "stop" || event === "taskcompleted") return "completed";
  // 子代理开始/结束都属于「整体任务进行中」：SubagentStop 只是一个小轮结束，
  // 主代理随后会继续，不能当成整体完成，否则会过早播报“已完成”。
  if (event === "subagentstart" || event === "subagentstop" || event === "taskcreated") return "thinking";

  if (event === "posttoolbatch" && Array.isArray(raw?.tool_calls)) {
    const calls = raw.tool_calls.map((call) => ({
      tool: String(call.tool_name || "").toLowerCase(),
      command: String(call.tool_input?.command || "").toLowerCase()
    }));
    if (calls.some((call) => ["edit", "write", "multiedit", "notebookedit"].some((name) => call.tool.includes(name)))) {
      return "writing_code";
    }
    const shellCall = calls.find((call) => call.tool.includes("bash") || call.tool.includes("powershell"));
    if (shellCall) {
      if (/(test|vitest|jest|pytest|cargo test|go test|npm t|pnpm test|yarn test)/.test(shellCall.command)) return "running_tests";
      return "running_command";
    }
    return "using_tool";
  }

  if (event === "pretooluse" || event === "posttooluse") {
    if (["edit", "write", "multiedit", "notebookedit"].some((name) => tool.includes(name))) return "writing_code";
    if (tool.includes("bash") || tool.includes("powershell")) {
      if (/(test|vitest|jest|pytest|cargo test|go test|npm t|pnpm test|yarn test)/.test(cmd)) return "running_tests";
      return "running_command";
    }
    return "using_tool";
  }

  if (event === "posttooluse" || event === "posttoolbatch") return "using_tool";
  return null;
}

function mapActivityToState(activity) {
  const value = String(activity || "").toLowerCase();
  if (!value) return "";
  if (["idle", "offline", "thinking", "using_tool", "writing_code", "running_command", "running_tests", "waiting_permission", "waiting_user", "completed", "failed", "paused"].includes(value)) return value;
  if (/(think|plan|reason|analy)/.test(value)) return "thinking";
  if (/(write|edit|patch|code|refactor)/.test(value)) return "writing_code";
  if (/(command|shell|terminal|run)/.test(value)) return "running_command";
  if (/(test|check|verify|lint)/.test(value)) return "running_tests";
  if (/(permission|approval|auth)/.test(value)) return "waiting_permission";
  if (/(wait|input|user)/.test(value)) return "waiting_user";
  if (/(done|complete|finish|success)/.test(value)) return "completed";
  if (/(fail|error|exception|crash)/.test(value)) return "failed";
  return "";
}

function stateSeverity(state, hookEvent) {
  if (state === "failed") return "error";
  if (state === "waiting_permission" || state === "waiting_user") return "warning";
  if (String(hookEvent || "").toLowerCase().includes("failure")) return "error";
  return "info";
}

function defaultTitle(source, state) {
  const label = toolLabels[source] || source;
  const stateText = {
    offline: "未连接",
    idle: "空闲",
    prompt_submitted: "已提交任务",
    thinking: "正在思考",
    using_tool: "正在调用工具",
    writing_code: "正在写代码",
    running_command: "正在运行命令",
    running_tests: "正在测试",
    waiting_permission: "等待授权",
    waiting_user: "等待输入",
    completed: "任务完成",
    failed: "出现问题",
    paused: "已暂停"
  }[state] || state;
  return `${label} ${stateText}`;
}

function defaultMessage(hookEvent, toolName, command, state, raw = {}) {
  const filePath =
    raw?.tool_input?.file_path ||
    raw?.tool_input?.notebook_path ||
    raw?.file_path ||
    raw?.path ||
    raw?.file;
  const prompt = raw?.prompt;
  const notification = raw?.message || raw?.notification || raw?.notification_message;
  const batchSummary = summarizeBatch(raw?.tool_calls);

  if (state === "prompt_submitted" && prompt) return trimText(`收到新任务：${prompt}`, 120);
  if (state === "waiting_permission" && notification) return trimText(notification, 120);
  if (state === "waiting_user" && notification) return trimText(notification, 120);
  if (batchSummary) return batchSummary;
  if (filePath && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(String(toolName || ""))) {
    return `正在处理 ${filePath}`;
  }
  if (filePath && state === "writing_code") return `检测到文件变化：${filePath}`;
  if (command) return trimText(`正在执行：${command}`, 140);
  if (toolName) {
    return `${hookEvent || "事件"}: ${toolName}`;
  }
  const messages = {
    offline: "适配器离线或软件未运行",
    idle: "在线，当前没有任务",
    prompt_submitted: "新任务已提交",
    thinking: "正在规划下一步",
    using_tool: "正在读取上下文或调用外部工具",
    writing_code: "检测到文件写入或编辑动作",
    running_command: "正在执行命令",
    running_tests: "正在执行测试任务",
    waiting_permission: "需要你确认权限",
    waiting_user: "需要你回复或处理",
    completed: "本轮任务已经结束",
    failed: "检测到失败事件"
  };
  return messages[state] || "状态已更新";
}

function summarizeBatch(calls) {
  if (!Array.isArray(calls) || !calls.length) return "";
  const names = calls.slice(0, 4).map((call) => call.tool_name).filter(Boolean);
  const firstPath =
    calls.find((call) => call.tool_input?.file_path)?.tool_input?.file_path ||
    calls.find((call) => call.tool_input?.path)?.tool_input?.path;
  const firstCommand = calls.find((call) => call.tool_input?.command)?.tool_input?.command;

  if (firstCommand) return trimText(`批量工具：${names.join("、")}；命令 ${firstCommand}`, 140);
  if (firstPath) return trimText(`批量工具：${names.join("、")}；文件 ${firstPath}`, 140);
  return `批量工具：${names.join("、")}`;
}

function trimText(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function snapshot() {
  const values = Object.values(store.tools);
  const activeSources = new Set(values.filter((tool) => !tool.isPlaceholder).map((tool) => tool.source));
  const tools = values
    .filter((tool) => !(tool.isPlaceholder && activeSources.has(tool.source)))
    .sort((a, b) => {
    const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return bTime - aTime;
  });
  const activeTool = tools.find((tool) => !["offline", "idle"].includes(tool.state)) || tools[0] || null;
  const visibleTools = store.settings.privacyMode ? tools.map(redactTool) : tools;
  const visibleEvents = store.settings.privacyMode ? store.events.slice(0, 12).map(redactEvent) : store.events.slice(0, 12);
  return {
    generatedAt: new Date().toISOString(),
    activeSource: activeTool?.source || null,
    activeInstanceId: activeTool?.instanceId || null,
    activeCount: tools.filter((tool) => !["offline", "idle", "completed"].includes(tool.state)).length,
    tools: visibleTools,
    recentEvents: visibleEvents,
    pairing: publicSettings()
  };
}

function redactTool(tool) {
  return {
    ...tool,
    label: tool.sourceLabel || tool.source || tool.label,
    title: defaultTitle(tool.source, tool.state),
    message: privacyMessage(tool),
    workspace: "",
    projectName: "",
    sessionId: "",
    model: "",
    command: "",
    toolName: "",
    hookEvent: ""
  };
}

function redactEvent(event) {
  return {
    ...redactTool(event),
    eventId: event.eventId,
    createdAt: event.createdAt,
    raw: undefined
  };
}

function privacyMessage(item) {
  const state = {
    offline: "未连接",
    idle: "当前空闲",
    prompt_submitted: "已收到新任务",
    thinking: "正在处理任务",
    using_tool: "正在调用工具",
    writing_code: "正在写代码",
    running_command: "正在运行命令",
    running_tests: "正在测试",
    waiting_permission: "等待授权",
    waiting_user: "等待输入",
    completed: "任务已完成",
    failed: "出现问题",
    paused: "已暂停"
  }[item.state] || "状态已更新";
  return `${item.sourceLabel || item.source || "工具"}：${state}`;
}

function loadSettings() {
  const defaults = {
    agentId: crypto.randomUUID(),
    agentName: os.hostname() || "CodeStatus Desktop",
    ttsEnabled: false,
    lanEnabled: true,
    authEnabled: true,
    pairingToken: crypto.randomBytes(18).toString("base64url"),
    devices: [],
    revokedDevices: [],
    privacyMode: false,
    // 按软件（source）覆盖全局音色/音量/语速；空对象=全部走全局。形如 { "comfyui": { voice, volume, rate } }
    voiceOverrides: {},
    notify: DEFAULT_NOTIFY_SETTINGS
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(defaults, null, 2), "utf8");
      return defaults;
    }
    const settings = { ...defaults, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
    settings.notify = mergeNotifySettings(settings.notify);
    let dirty = false;
    // 一次性迁移：为老配置补上「任务开始」推送（这是新增的推送类型，用户此前无从勾选）。
    // 迁移后打标记，用户之后仍可自行取消，不会被反复加回。
    if (!settings.notifyTaskStartMigrated) {
      if (Array.isArray(settings.notify.states) && !settings.notify.states.includes("prompt_submitted")) {
        settings.notify.states = ["prompt_submitted", ...settings.notify.states];
      }
      settings.notifyTaskStartMigrated = true;
      dirty = true;
    }
    if (!settings.agentId || !settings.agentName || dirty) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(settings, null, 2), "utf8");
    }
    return settings;
  } catch {
    return defaults;
  }
}

function saveSettings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store.settings, null, 2), "utf8");
}

function publicSettings() {
  return {
    lanEnabled: store.settings.lanEnabled,
    authEnabled: store.settings.authEnabled,
    agentId: store.settings.agentId,
    agentName: store.settings.agentName,
    privacyMode: Boolean(store.settings.privacyMode),
    httpPort: PORT,
    httpsPort: httpsServer ? HTTPS_PORT : null,
    discovery: {
      mdnsEnabled: Boolean(publishedService),
      service: "_codestatus._tcp.local"
    },
    secureChannel: {
      enabled: Boolean(httpsServer),
      fingerprint256: certificateInfo?.fingerprint256 || "",
      note: httpsServer ? "使用本机自签名证书，首次访问需要信任证书。" : "HTTPS 通道未启动。"
    },
    voiceOverrides: store.settings.voiceOverrides || {},
    devices: store.settings.devices
      .map(publicDevice),
    revokedDevices: (store.settings.revokedDevices || []).map((device) => ({
      id: device.id,
      name: device.name,
      ip: device.ip,
      revokedAt: device.revokedAt
    }))
  };
}

function discoveryInfo(req) {
  const address = localAddress(req);
  return {
    agentId: store.settings.agentId,
    agentName: store.settings.agentName,
    service: "_codestatus._tcp.local",
    addresses: lanAddresses(),
    http: {
      port: PORT,
      baseUrl: `http://${address}:${PORT}`,
      statusUrl: `http://${address}:${PORT}/api/status`
    },
    https: httpsServer
      ? {
          port: HTTPS_PORT,
          baseUrl: `https://${address}:${HTTPS_PORT}`,
          statusUrl: `https://${address}:${HTTPS_PORT}/api/status`,
          fingerprint256: certificateInfo?.fingerprint256 || ""
        }
      : null,
    authEnabled: store.settings.authEnabled,
    pairingRequired: store.settings.authEnabled,
    certificateFingerprint: certificateInfo?.fingerprint256 || "",
    generatedAt: new Date().toISOString()
  };
}

async function networkDiagnostics(req) {
  const address = localAddress(req);
  const firewall = await windowsFirewallSummary();
  const diagnostics = [
    {
      id: "lan-address",
      label: "局域网地址",
      state: address === "127.0.0.1" ? "warning" : "ok",
      message: address === "127.0.0.1" ? "没有发现可用局域网 IPv4 地址。" : `已发现局域网地址 ${address}。`
    },
    {
      id: "http-port",
      label: "HTTP Agent",
      state: "ok",
      message: `HTTP 端口 ${PORT} 已监听在 0.0.0.0。`
    },
    {
      id: "https-port",
      label: "HTTPS Agent",
      state: httpsServer ? "ok" : "warning",
      message: httpsServer ? `HTTPS 端口 ${HTTPS_PORT} 已启动，自签名证书可用于局域网加密。` : "HTTPS 未启动。"
    },
    {
      id: "mdns",
      label: "自动发现",
      state: publishedService ? "ok" : "warning",
      message: publishedService ? "已广播 _codestatus._tcp.local 服务。" : "mDNS 广播未启动，手机 APP 仍可用二维码配对。"
    },
    {
      id: "firewall",
      label: "Windows 防火墙",
      state: firewall.enabled ? "warning" : "ok",
      message: firewall.message
    }
  ];

  return {
    agentId: store.settings.agentId,
    agentName: store.settings.agentName,
    addresses: lanAddresses(),
    ports: {
      http: PORT,
      https: httpsServer ? HTTPS_PORT : null
    },
    firewall,
    diagnostics,
    guidance: [
      `如果手机无法连接，请允许 Node.js 或端口 ${PORT}${httpsServer ? ` / ${HTTPS_PORT}` : ""} 通过 Windows Defender 防火墙。`,
      "手机和电脑必须在同一个 Wi-Fi 或同一个局域网网段。",
      "公司/校园网络可能隔离设备，二维码正确也可能无法连通。"
    ],
    generatedAt: new Date().toISOString()
  };
}

function authorize(req, url) {
  if (!store.settings.authEnabled) return true;
  const credential = extractDeviceCredential(req, url);
  if (credential.id && isDeviceRevoked(credential.id)) return false;
  if (isLoopback(req)) return true;
  if (verifyDeviceCredential(req, url)) return true;
  const token = extractPairingToken(req, url);
  return token && token === store.settings.pairingToken;
}

function extractPairingToken(req, url) {
  return (
    url.searchParams.get("token") ||
    req.headers["x-codestatus-token"] ||
    String(req.headers.authorization || "").replace(/^Bearer\s+/i, "")
  );
}

function extractDeviceCredential(req, url) {
  return {
    id: url.searchParams.get("deviceId") || req.headers["x-codestatus-device-id"] || "",
    secret: url.searchParams.get("deviceSecret") || req.headers["x-codestatus-device-secret"] || ""
  };
}

function verifyDeviceCredential(req, url) {
  const { id, secret } = extractDeviceCredential(req, url);
  if (!id || !secret || isDeviceRevoked(id)) return false;
  const device = store.settings.devices.find((item) => item.id === id);
  if (!device?.secretHash) return false;
  return device.secretHash === hashSecret(secret);
}

function isDeviceRevoked(id) {
  return Boolean(id && (store.settings.revokedDevices || []).some((device) => device.id === id));
}

function isLoopback(req) {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function localAddress(req) {
  const host = String(req.headers.host || "127.0.0.1").split(":")[0];
  return host === "127.0.0.1" || host === "localhost" ? firstLanAddress() : host;
}

function secureAgentUrl(req) {
  if (!httpsServer) return "";
  return `https://${localAddress(req)}:${HTTPS_PORT}/api/status`;
}

// 虚拟 / 不可达网卡（VMware、VirtualBox、Hyper-V、WSL、代理 TUN 等），手机连不上，需排除
function isVirtualInterface(name, address) {
  if (/vmware|virtualbox|vbox|vethernet|hyper-v|default switch|wsl|loopback|tailscale|zerotier|tap|tun|meta|clash|surge/i.test(name)) return true;
  if (/^198\.18\./.test(address)) return true; // 基准测试段，常被代理工具占用
  if (/^169\.254\./.test(address)) return true; // APIPA 自动私有地址
  if (/^25\./.test(address)) return true; // Hamachi 等
  return false;
}

function lanAddresses(includeVirtual = false) {
  const addresses = [];
  for (const [name, values] of Object.entries(os.networkInterfaces())) {
    for (const address of values || []) {
      if (address.family === "IPv4" && !address.internal) {
        if (!includeVirtual && isVirtualInterface(name, address.address)) continue;
        addresses.push({
          name,
          address: address.address,
          cidr: address.cidr || "",
          mac: address.mac || ""
        });
      }
    }
  }
  return addresses;
}

function firstLanAddress() {
  // 优先真实网卡，其次才考虑虚拟网卡兜底
  const real = lanAddresses(false).map((address) => address.address);
  const all = lanAddresses(true).map((address) => address.address);
  const pick = (list) =>
    list.find((address) => /^192\.168\./.test(address)) ||
    list.find((address) => /^10\./.test(address)) ||
    list.find((address) => /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) ||
    list[0];
  return pick(real) || pick(all) || "127.0.0.1";
}

async function windowsFirewallSummary() {
  if (process.platform !== "win32") {
    return {
      checked: false,
      enabled: null,
      message: "当前不是 Windows，无法读取 Windows Defender 防火墙状态。"
    };
  }
  try {
    const output = await execFileText("netsh", ["advfirewall", "show", "allprofiles", "state"]);
    const enabled = /State\s+ON/i.test(output);
    return {
      checked: true,
      enabled,
      message: enabled
        ? "防火墙处于开启状态；如手机无法访问，请放行 Node.js 或本机 Agent 端口。"
        : "防火墙当前关闭。"
    };
  } catch (error) {
    return {
      checked: false,
      enabled: null,
      message: `无法读取防火墙状态：${error.message}`
    };
  }
}

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 3000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

function registerDevice(req, body = {}) {
  const ip = req.socket.remoteAddress || "";
  const id = body.deviceId || req.headers["x-codestatus-device-id"] || hashKey(`${body.name || "Mobile"}:${ip}`);
  if (isDeviceRevoked(id)) return null;
  const existing = store.settings.devices.find((device) => device.id === id);
  const shouldIssueSecret = body.issueDeviceSecret || !existing?.secretHash;
  const deviceSecret = shouldIssueSecret ? crypto.randomBytes(24).toString("base64url") : "";
  const device = {
    id,
    name: body.name || existing?.name || "Mobile Status Screen",
    ip,
    userAgent: trimText(req.headers["user-agent"] || existing?.userAgent || "", 120),
    secretHash: shouldIssueSecret ? hashSecret(deviceSecret) : existing.secretHash,
    pairedAt: existing?.pairedAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
  store.settings.devices = [device, ...store.settings.devices.filter((item) => item.id !== id)].slice(0, 20);
  saveSettings();
  return {
    ...publicDevice(device),
    deviceSecret: deviceSecret || undefined
  };
}

function touchDevice(req, url) {
  if (isLoopback(req)) return;
  const credential = extractDeviceCredential(req, url);
  if (credential.id && verifyDeviceCredential(req, url)) {
    const device = store.settings.devices.find((item) => item.id === credential.id);
    if (device) {
      device.ip = req.socket.remoteAddress || device.ip;
      device.lastSeenAt = new Date().toISOString();
      saveSettings();
    }
    return;
  }

  const token = extractPairingToken(req, url);
  if (token === store.settings.pairingToken) {
    registerDevice(req, {
      deviceId: req.headers["x-codestatus-device-id"],
      name: req.headers["x-codestatus-device"] || "Mobile Status Screen"
    });
  }
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    ip: device.ip,
    userAgent: device.userAgent || "",
    pairedAt: device.pairedAt || "",
    lastSeenAt: device.lastSeenAt,
    credential: device.secretHash ? "device-secret" : "pairing-token"
  };
}

function hashSecret(secret) {
  return crypto.createHash("sha256").update(String(secret || "")).digest("hex");
}

function broadcast(payload) {
  const text = JSON.stringify(payload);
  for (const wss of websocketServers) {
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(text);
      }
    }
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function sendJson(res, value, status = 200) {
  send(res, status, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
}

function send(res, status = 200, body = "", type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-CodeStatus-Token,X-CodeStatus-Device,X-CodeStatus-Device-Id,X-CodeStatus-Device-Secret"
  });
  res.end(body);
}

function staticFrontendHandler(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const safeRelative = requested.replace(/^\/+/, "");

  // exe 模式：网页资源内嵌在可执行文件里
  if (seaApi) {
    let key = safeRelative;
    let buffer = readSeaAsset(key);
    if (!buffer) {
      key = "index.html"; // SPA 兜底
      buffer = readSeaAsset(key);
    }
    if (!buffer) return send(res, 404, "Frontend asset missing in executable.");
    res.writeHead(200, {
      "Content-Type": mimeType(key),
      "Cache-Control": key.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable"
    });
    return res.end(buffer);
  }

  const candidate = path.resolve(DIST_DIR, safeRelative);
  const root = path.resolve(DIST_DIR);
  const filePath = candidate.startsWith(root) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : path.join(DIST_DIR, "index.html");

  if (!fs.existsSync(filePath)) {
    return send(res, 404, "Frontend build not found. Run npm run build first.");
  }

  res.writeHead(200, {
    "Content-Type": mimeType(filePath),
    "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable"
  });
  fs.createReadStream(filePath).pipe(res);
}

function readSeaAsset(key) {
  try {
    const raw = seaApi.getRawAsset(key.replaceAll("\\", "/"));
    return raw ? Buffer.from(raw) : null;
  } catch {
    return null;
  }
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json; charset=utf-8"
  }[ext] || "application/octet-stream";
}
