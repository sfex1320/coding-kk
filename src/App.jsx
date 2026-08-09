import React, { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  Activity,
  AlertTriangle,
  BellRing,
  Bot,
  CheckCircle2,
  Clock3,
  Code2,
  Cpu,
  Loader2,
  Mic2,
  MonitorSmartphone,
  Moon,
  PauseCircle,
  Play,
  Radio,
  RefreshCw,
  Send,
  Settings2,
  ShieldAlert,
  Smartphone,
  TerminalSquare,
  Volume2,
  VolumeX,
  MessageCircle,
  EyeOff,
  KeyRound,
  ShieldCheck,
  Trash2,
  Wifi,
  WifiOff
} from "lucide-react";

const API_PORT = 4317;

const stateMeta = {
  offline: { label: "未连接", tone: "neutral", icon: WifiOff, pet: "sleep" },
  idle: { label: "空闲", tone: "neutral", icon: PauseCircle, pet: "idle" },
  prompt_submitted: { label: "已提交任务", tone: "focus", icon: Send, pet: "listen" },
  thinking: { label: "正在思考", tone: "focus", icon: Loader2, pet: "think" },
  using_tool: { label: "正在调用工具", tone: "work", icon: Cpu, pet: "inspect" },
  writing_code: { label: "正在写代码", tone: "work", icon: Code2, pet: "code" },
  running_command: { label: "正在运行命令", tone: "work", icon: TerminalSquare, pet: "terminal" },
  running_tests: { label: "正在测试", tone: "work", icon: Activity, pet: "test" },
  waiting_permission: { label: "等待授权", tone: "warn", icon: ShieldAlert, pet: "alert" },
  waiting_user: { label: "等待输入", tone: "warn", icon: BellRing, pet: "alert" },
  completed: { label: "已完成", tone: "done", icon: CheckCircle2, pet: "done" },
  failed: { label: "出现问题", tone: "bad", icon: AlertTriangle, pet: "fail" },
  paused: { label: "已暂停", tone: "neutral", icon: PauseCircle, pet: "idle" }
};

// 不播报的状态：空闲/离线/暂停不说话，只在有实际活动（工作/完成/失败/等待）时才报。
const SILENT_STATES = new Set(["idle", "offline", "paused"]);

const simulations = [
  { source: "claude-code", state: "thinking", message: "Claude Code 正在分析项目结构", title: "Claude Code 正在思考" },
  { source: "claude-code", state: "writing_code", message: "正在修改 src/App.jsx", title: "Claude Code 正在写代码" },
  { source: "claude-dev", state: "writing_code", message: "Claude Dev 正在自动修改文件", title: "Claude Dev 正在写代码" },
  { source: "codex", state: "running_command", message: "Codex 正在执行修复命令", title: "Codex 正在运行命令", workspace: "G:/Project/codex-demo" },
  { source: "vscode", state: "running_tests", message: "VS Code 正在执行 npm test", title: "VS Code 正在测试" },
  { source: "cursor", state: "waiting_permission", severity: "warning", message: "Cursor 扩展请求读取工作区状态", title: "Cursor 等待授权" },
  { source: "claude-code", state: "completed", message: "本轮任务已经完成", title: "Claude Code 已完成" },
  { source: "claude-dev", state: "failed", severity: "error", message: "命令退出码为 1，需要查看输出", title: "Claude Dev 出现问题" }
];

export default function App() {
  const [status, setStatus] = useState(null);
  const [connected, setConnected] = useState(false);
  const [connectionDetail, setConnectionDetail] = useState("正在连接 Agent");
  const [retryCount, setRetryCount] = useState(0);
  const [pairing, setPairing] = useState(null);
  const [network, setNetwork] = useState(null);
  const [pairingRequired, setPairingRequired] = useState(false);
  const [pairCode] = useState(() => new URLSearchParams(window.location.search).get("pair") || "");
  const [authToken, setAuthToken] = useState(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (token) window.localStorage.setItem("codestatus-token", token);
    return token || window.localStorage.getItem("codestatus-token") || "";
  });
  const [deviceId] = useState(() => {
    const existing = window.localStorage.getItem("codestatus-device-id");
    if (existing) return existing;
    const id = window.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.localStorage.setItem("codestatus-device-id", id);
    return id;
  });
  const [deviceSecret, setDeviceSecret] = useState(() => window.localStorage.getItem("codestatus-device-secret") || "");
  const [speechEnabled, setSpeechEnabled] = useState(() => window.localStorage.getItem("codestatus-speech") !== "0");
  const [displayMode, setDisplayMode] = useState(() => new URLSearchParams(window.location.search).get("display") === "1");
  const [showStage, setShowStage] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [listening, setListening] = useState(false);
  const [rotationIndex, setRotationIndex] = useState(0);
  const [repeatMinutes, setRepeatMinutes] = useState(() => Number(window.localStorage.getItem("codestatus-repeat") || 0));
  const [query, setQuery] = useState("");
  const [ttsVoice, setTtsVoice] = useState(() => {
    const stored = window.localStorage.getItem("codestatus-tts-voice");
    // 默认 "" = 自动取本机第一个中文音色（离线可靠）；云端音色需手动开「在线 HD」。
    return stored === null ? "" : stored;
  });
  const [ttsRate, setTtsRate] = useState(() => Number(window.localStorage.getItem("codestatus-tts-rate") || 0));
  const [voiceList, setVoiceList] = useState([]);
  const [localVoices, setLocalVoices] = useState([]);
  const [ttsCloudEnabled, setTtsCloudEnabled] = useState(
    () => window.localStorage.getItem("codestatus-tts-cloud") === "1"
  );
  const activeToolRef = useRef(null);
  const lastSpokenByInstance = useRef(new Map());
  const speechQueue = useRef([]);
  const speaking = useRef(false);
  const speechRunId = useRef(0);
  const wakeLock = useRef(null);
  const ttsVoiceRef = useRef(ttsVoice);
  const ttsRateRef = useRef(ttsRate);
  const ttsCloudEnabledRef = useRef(ttsCloudEnabled);
  const localVoicesRef = useRef([]);
  const cloudVoiceIdsRef = useRef(new Set());
  const voiceOverridesRef = useRef({});
  const currentAudio = useRef(null);

  const agentBase = useMemo(() => {
    const host = window.location.hostname || "127.0.0.1";
    return `http://${host}:${API_PORT}`;
  }, []);

  const apiHeaders = useMemo(() => {
    const headers = { "Content-Type": "application/json" };
    if (deviceSecret) {
      headers["X-CodeStatus-Device-Id"] = deviceId;
      headers["X-CodeStatus-Device-Secret"] = deviceSecret;
      headers["X-CodeStatus-Device"] = "Mobile Status Screen";
    } else if (authToken) {
      headers["X-CodeStatus-Token"] = authToken;
      headers["X-CodeStatus-Device"] = "Mobile Status Screen";
      headers["X-CodeStatus-Device-Id"] = deviceId;
    }
    return headers;
  }, [authToken, deviceId, deviceSecret]);

  const wsUrl = useMemo(() => {
    const base = agentBase.replace("http", "ws") + "/ws";
    if (deviceSecret) {
      return `${base}?deviceId=${encodeURIComponent(deviceId)}&deviceSecret=${encodeURIComponent(deviceSecret)}`;
    }
    return authToken ? `${base}?token=${encodeURIComponent(authToken)}` : base;
  }, [agentBase, authToken, deviceId, deviceSecret]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("token") && !params.has("pair")) return;
    params.delete("token");
    params.delete("pair");
    const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
    window.history.replaceState({}, "", next);
  }, []);

  useEffect(() => {
    let socket;
    let reconnectTimer;

    const connect = async () => {
      try {
        const pairingResponse = await fetch(`${agentBase}/api/pairing`, { headers: apiHeaders });
        if (pairingResponse.ok) setPairing(await pairingResponse.json());

        const diagnosticsResponse = await fetch(`${agentBase}/api/network-diagnostics`, { headers: apiHeaders });
        if (diagnosticsResponse.ok) setNetwork(await diagnosticsResponse.json());

        if (pairCode && !deviceSecret) {
          const claimResponse = await fetch(`${agentBase}/api/pairing/claim`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pairCode, deviceId, name: "Mobile Status Screen" })
          }).catch(() => null);
          if (claimResponse?.ok) {
            const body = await claimResponse.json();
            if (body.device?.deviceSecret) {
              window.localStorage.setItem("codestatus-device-secret", body.device.deviceSecret);
              setDeviceSecret(body.device.deviceSecret);
              setPairingRequired(false);
              return;
            }
          } else {
            setPairingRequired(true);
            setConnectionDetail("配对码过期或已使用，请重新扫码");
          }
        } else if (authToken && (!deviceSecret || !window.localStorage.getItem("codestatus-device-secret"))) {
          const registerResponse = await fetch(`${agentBase}/api/devices/register`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CodeStatus-Token": authToken,
              "X-CodeStatus-Device": "Mobile Status Screen",
              "X-CodeStatus-Device-Id": deviceId
            },
            body: JSON.stringify({ deviceId, name: "Mobile Status Screen", issueDeviceSecret: true })
          }).catch(() => null);
          if (registerResponse?.ok) {
            const body = await registerResponse.json();
            if (body.device?.deviceSecret) {
              window.localStorage.setItem("codestatus-device-secret", body.device.deviceSecret);
              setDeviceSecret(body.device.deviceSecret);
              setPairingRequired(false);
              return;
            }
          } else if (registerResponse?.status === 403) {
            setPairingRequired(true);
            setConnectionDetail("这台设备已被撤销，请在电脑端重新生成配对码后重新扫码");
          }
        }

        const response = await fetch(`${agentBase}/api/status`, { headers: apiHeaders });
        if (response.ok) {
          setStatus(await response.json());
          setConnectionDetail("HTTP 状态拉取成功，正在建立实时通道");
        } else if (response.status === 401) {
          setConnected(false);
          setPairingRequired(true);
          setConnectionDetail("token 无效或已被撤销，请重新扫码配对");
        } else if (response.status === 403) {
          setConnected(false);
          setPairingRequired(true);
          setConnectionDetail("设备已被撤销，请重新配对");
        }
      } catch {
        setConnected(false);
        setConnectionDetail("无法访问电脑端 Agent，请检查同一 Wi-Fi、防火墙或端口");
      }

      socket = new WebSocket(wsUrl);
      socket.onopen = () => {
        setConnected(true);
        setRetryCount(0);
        setConnectionDetail("WebSocket 实时通道已连接");
      };
      socket.onclose = () => {
        setConnected(false);
        setRetryCount((count) => {
          const next = count + 1;
          const delay = Math.min(1000 * Math.pow(1.5, Math.min(next, 8)), 15000);
          reconnectTimer = window.setTimeout(connect, delay);
          return next;
        });
        setConnectionDetail("实时通道断开，正在自动重连");
      };
      socket.onerror = () => {
        setConnected(false);
        setConnectionDetail("实时通道连接失败，等待下一次重试");
      };
      socket.onmessage = (message) => {
        const payload = JSON.parse(message.data);
        if (payload.status) setStatus(payload.status);
        if (payload.settings) {
          setPairing((current) => ({ ...(current || {}), ...payload.settings }));
          if (payload.settings.voiceOverrides) voiceOverridesRef.current = payload.settings.voiceOverrides;
        }
      };
    };

    connect();
    return () => {
      window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [agentBase, wsUrl, apiHeaders, authToken, pairCode, deviceId, deviceSecret]);

  useEffect(() => {
    ttsVoiceRef.current = ttsVoice;
  }, [ttsVoice]);

  useEffect(() => {
    ttsRateRef.current = ttsRate;
  }, [ttsRate]);

  useEffect(() => {
    ttsCloudEnabledRef.current = ttsCloudEnabled;
  }, [ttsCloudEnabled]);

  // 拉取电脑端可用的云端音色列表
  useEffect(() => {
    let active = true;
    fetch(`${agentBase}/api/tts/voices`, { headers: apiHeaders })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (active && Array.isArray(data?.voices)) {
          setVoiceList(data.voices);
          cloudVoiceIdsRef.current = new Set(data.voices.map((voice) => voice.id));
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [agentBase, apiHeaders]);

  // 本机离线音色（speechSynthesis）：Win11 自带神经网络音色，境内无需联网即可用，是默认引擎。
  useEffect(() => {
    if (!window.speechSynthesis) return undefined;
    const load = () => {
      const list = window.speechSynthesis.getVoices() || [];
      if (list.length) {
        setLocalVoices(list);
        localVoicesRef.current = list;
      }
    };
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => {
      if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  // 正在运行 / 已连接的工具集合，按稳定 key 排序，用于顶部轮换
  const rotatingTools = useMemo(() => {
    return (status?.tools || [])
      .filter((tool) => !tool.isPlaceholder && tool.state !== "offline")
      .sort((a, b) => String(a.instanceId).localeCompare(String(b.instanceId)));
  }, [status]);

  // 每 4 秒自动轮换到下一个运行中的工具（多个时才轮换）
  useEffect(() => {
    if (rotatingTools.length <= 1) return undefined;
    const timer = window.setInterval(() => setRotationIndex((index) => index + 1), 4000);
    return () => window.clearInterval(timer);
  }, [rotatingTools.length]);

  const activeTool = useMemo(() => {
    if (!rotatingTools.length) return status?.tools?.[0] || null;
    const length = rotatingTools.length;
    const index = ((rotationIndex % length) + length) % length;
    return rotatingTools[index];
  }, [rotatingTools, rotationIndex, status]);

  // 点击 / 滑动时把轮换指针对准指定实例（之后继续自动轮换）
  function focusInstance(instanceId) {
    const index = rotatingTools.findIndex((tool) => tool.instanceId === instanceId);
    if (index >= 0) setRotationIndex(index);
  }

  function stepInstance(direction) {
    if (!rotatingTools.length) return;
    setRotationIndex((index) => index + (direction < 0 ? -1 : 1));
  }

  activeToolRef.current = activeTool;

  function changeRepeat(minutes) {
    setRepeatMinutes(minutes);
    window.localStorage.setItem("codestatus-repeat", String(minutes));
  }

  // 定时自动复播当前状态（关 / 3 / 5 / 10 分钟）
  useEffect(() => {
    if (!speechEnabled || !repeatMinutes) return undefined;
    const timer = window.setInterval(() => {
      const tool = activeToolRef.current;
      if (tool) enqueueSpeak({ text: briefSpeechForStatus(tool), source: tool.source });
    }, repeatMinutes * 60000);
    return () => window.clearInterval(timer);
  }, [speechEnabled, repeatMinutes]);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!displayMode || !showStage) {
      releaseWakeLock();
      return;
    }
    requestWakeLock();
    return () => releaseWakeLock();
  }, [displayMode, showStage]);

  useEffect(() => {
    if (!speechEnabled || !status?.recentEvents?.length || !window.speechSynthesis) return;
    const event = status.recentEvents[0];
    if (!event?.eventId) return;
    if (SILENT_STATES.has(event.state)) return; // 离线不播报
    // 每次状态切换都播报：按「状态+事件ID」去重，同一事件的重复推送不重报，状态变化即报。
    const instance = event.instanceId || event.source || "task";
    const dedupKey = `${event.state}::${event.eventId}`;
    if (lastSpokenByInstance.current.get(instance) === dedupKey) return;
    lastSpokenByInstance.current.set(instance, dedupKey);
    enqueueSpeak({ text: announcementForEvent(event), source: event.source });
  }, [status, speechEnabled]);

  const answer = useMemo(() => makeAnswer(query, activeTool, status), [query, activeTool, status]);
  const voiceAnswer = useMemo(() => makeVoiceAnswer(query, activeTool, status), [query, activeTool, status]);

  async function simulate(event) {
    await fetch(`${agentBase}/api/simulate`, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify(event)
    });
  }

  async function rotatePairingToken() {
    const response = await fetch(`${agentBase}/api/pairing/rotate`, {
      method: "POST",
      headers: apiHeaders
    });
    if (response.ok) {
      const pairingResponse = await fetch(`${agentBase}/api/pairing`, { headers: apiHeaders });
      if (pairingResponse.ok) setPairing(await pairingResponse.json());
      const diagnosticsResponse = await fetch(`${agentBase}/api/network-diagnostics`, { headers: apiHeaders });
      if (diagnosticsResponse.ok) setNetwork(await diagnosticsResponse.json());
    }
  }

  async function togglePrivacyMode() {
    const next = !pairing?.privacyMode;
    const response = await fetch(`${agentBase}/api/settings`, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ privacyMode: next })
    });
    if (response.ok) {
      setPairing((current) => ({ ...(current || {}), privacyMode: next }));
    }
  }

  async function revokeDevice(deviceIdToRevoke) {
    const response = await fetch(`${agentBase}/api/devices`, {
      method: "DELETE",
      headers: apiHeaders,
      body: JSON.stringify({ deviceId: deviceIdToRevoke })
    });
    if (response.ok) {
      const body = await response.json();
      setPairing((current) => ({ ...(current || {}), devices: body.devices || [] }));
    }
  }

  async function refreshNetwork() {
    const response = await fetch(`${agentBase}/api/network-diagnostics`, { headers: apiHeaders });
    if (response.ok) setNetwork(await response.json());
  }

  function resetLocalPairing() {
    window.localStorage.removeItem("codestatus-token");
    window.localStorage.removeItem("codestatus-device-secret");
    setAuthToken("");
    setDeviceSecret("");
    setPairingRequired(true);
    setConnected(false);
    setConnectionDetail("本机配对信息已清除，请重新扫码");
  }

  function toggleSpeechEnabled() {
    setSpeechEnabled((enabled) => {
      const next = !enabled;
      window.localStorage.setItem("codestatus-speech", next ? "1" : "0");
      if (!next) stopSpeech();
      return next;
    });
  }

  function stopSpeech() {
    speechRunId.current += 1;
    speechQueue.current = [];
    speaking.current = false;
    window.speechSynthesis?.cancel();
    if (currentAudio.current) {
      try {
        currentAudio.current.pause();
      } catch {
        // best-effort
      }
      currentAudio.current = null;
    }
  }

  function changeVoice(voice) {
    setTtsVoice(voice);
    window.localStorage.setItem("codestatus-tts-voice", voice);
  }

  function changeRate(rate) {
    setTtsRate(rate);
    window.localStorage.setItem("codestatus-tts-rate", String(rate));
  }

  function enqueueSpeak(input) {
    const isObj = input && typeof input === "object";
    const text = isObj ? input.text : input;
    if (!text) return;
    const source = isObj ? input.source ?? null : null;
    const opts = isObj ? input.opts ?? null : null;
    speechQueue.current.push({ text, source, opts });
    speechQueue.current = speechQueue.current.slice(-8);
    drainSpeechQueue();
  }

  async function drainSpeechQueue() {
    if (speaking.current || !speechQueue.current.length) return;
    const item = speechQueue.current.shift();
    const runId = speechRunId.current;
    speaking.current = true;
    try {
      // 按软件覆盖解析音色/音量/语速：调用方传入 > 该软件覆盖 > 全局
      const vo = (item.source && voiceOverridesRef.current[item.source]) || {};
      const voice = item.opts?.voice ?? vo.voice ?? ttsVoiceRef.current;
      const rate = item.opts?.rate ?? (vo.rate ?? ttsRateRef.current);
      const volume = item.opts?.volume ?? (vo.volume ?? 1);
      const useCloud = cloudVoiceIdsRef.current.has(voice) && ttsCloudEnabledRef.current;
      if (useCloud) {
        // 云端在线 HD：失败（含超时）静默回退本机音色，保证总能发声
        await playViaAgent(item.text, voice, rate, volume, runId).catch(() =>
          playViaSystem(item.text, runId, voice, rate, volume)
        );
      } else {
        await playViaSystem(item.text, runId, voice, rate, volume);
      }
    } catch {
      // 单条失败不阻塞队列
    }
    if (runId !== speechRunId.current) return;
    speaking.current = false;
    drainSpeechQueue();
  }

  function playViaAgent(text, voice, rate, volume, runId) {
    return fetch(`${agentBase}/api/tts`, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ text, voice, rate, volume }),
      signal: AbortSignal.timeout(3500)
    })
      .then((response) => {
        if (!response.ok) throw new Error(`tts ${response.status}`);
        return response.blob();
      })
      .then(
        (blob) =>
          new Promise((resolve, reject) => {
            if (runId !== speechRunId.current) return resolve();
            const objectUrl = URL.createObjectURL(blob);
            const audio = new Audio(objectUrl);
            audio.volume = Math.max(0, Math.min(1, volume ?? 1));
            currentAudio.current = audio;
            const cleanup = () => {
              URL.revokeObjectURL(objectUrl);
              if (currentAudio.current === audio) currentAudio.current = null;
            };
            audio.onended = () => {
              cleanup();
              resolve();
            };
            audio.onerror = () => {
              cleanup();
              reject(new Error("audio error"));
            };
            audio.play().catch((error) => {
              cleanup();
              reject(error);
            });
          })
      );
  }

  function playViaSystem(text, runId, voice, rate, volume) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis || runId !== speechRunId.current) return resolve();
      const utterance = new SpeechSynthesisUtterance(text);
      // 核心修复：按所选音色挑选本机 SpeechSynthesisVoice（"" → 第一个中文音色）。
      // 否则浏览器永远用系统默认机械音——这正是"换音色不生效"的根因。
      const pick =
        (voice && localVoicesRef.current.find((v) => v.voiceURI === voice || v.name === voice)) ||
        localVoicesRef.current.find((v) => /^zh/i.test(v.lang)) ||
        null;
      if (pick) {
        utterance.voice = pick;
        utterance.lang = pick.lang || "zh-CN";
      } else {
        utterance.lang = "zh-CN";
      }
      utterance.rate = Math.max(0.1, Math.min(3, 1 + (Number(rate) || 0) / 100));
      utterance.volume = Math.max(0, Math.min(1, Number(volume) || 1));
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      window.speechSynthesis.speak(utterance);
    });
  }

  function speakCurrent() {
    if (!activeTool) return;
    enqueueSpeak({ text: briefSpeechForStatus(activeTool), source: activeTool?.source });
  }

  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator && !wakeLock.current) {
        wakeLock.current = await navigator.wakeLock.request("screen");
      }
    } catch {
      wakeLock.current = null;
    }
  }

  async function releaseWakeLock() {
    try {
      await wakeLock.current?.release();
    } catch {
      // Wake Lock is best-effort in browsers.
    } finally {
      wakeLock.current = null;
    }
  }

  async function toggleFullscreen() {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen?.();
    } else {
      await document.exitFullscreen?.();
    }
  }

  function startVoiceDialog() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      enqueueSpeak({ text: briefSpeechForStatus(activeTool), source: activeTool?.source });
      return;
    }

    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    setListening(true);
    recognition.onresult = (event) => {
      const text = event.results?.[0]?.[0]?.transcript || "现在在做什么";
      setQuery(text);
      enqueueSpeak({ text: makeVoiceAnswer(text, activeTool, status), source: activeTool?.source });
    };
    recognition.onerror = () => enqueueSpeak({ text: briefSpeechForStatus(activeTool), source: activeTool?.source });
    recognition.onend = () => setListening(false);
    recognition.start();
  }

  const renderDashboard = (tappablePet) => (
    <>
      <section className="hero-row">
        <div className="hero-panel">
          {tappablePet ? (
            <button className="pet-tap" onClick={() => setShowStage(true)} title="点击进入常驻展示页">
              <Pet tool={activeTool} />
            </button>
          ) : (
            <Pet tool={activeTool} />
          )}
          <ActiveStatus tool={activeTool} connected={connected} rotatingCount={rotatingTools.length} />
        </div>
      </section>

      <section className="card-grid">
        <section className="panel">
          <div className="panel-title">
            <Radio size={18} />
            <h2>监控源</h2>
          </div>
          <div className="tool-list">
            {(status?.tools || []).map((tool) => (
              <button
                key={tool.instanceId || tool.source}
                className="tool-row-button"
                onClick={() => focusInstance(tool.instanceId)}
              >
                <ToolRow tool={tool} active={tool.instanceId === activeTool?.instanceId} />
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <Settings2 size={18} />
            <h2>模拟状态</h2>
          </div>
          <div className="simulation-grid">
            {simulations.map((event) => {
              const meta = stateMeta[event.state] || stateMeta.idle;
              const Icon = meta.icon;
              return (
                <button key={`${event.source}-${event.state}`} className={`sim-button ${meta.tone}`} onClick={() => simulate(event)}>
                  <Icon size={17} />
                  <span>{event.title || meta.label}</span>
                </button>
              );
            })}
          </div>
        </section>

        <NotificationPanel agentBase={agentBase} apiHeaders={apiHeaders} />

        <VoiceOverridesPanel
          agentBase={agentBase}
          apiHeaders={apiHeaders}
          status={status}
          sourceLabels={pairing?.sourceLabels}
          localVoices={localVoices}
          cloudVoices={voiceList}
          cloudEnabled={ttsCloudEnabled}
        />

        <PairingPanel
          pairing={pairing}
          network={network}
          rotatePairingToken={rotatePairingToken}
          revokeDevice={revokeDevice}
          refreshNetwork={refreshNetwork}
          togglePrivacyMode={togglePrivacyMode}
        />

        <section className="panel">
          <div className="panel-title">
            <Clock3 size={18} />
            <h2>事件时间线</h2>
          </div>
          <EventTimeline events={status?.recentEvents || []} />
        </section>

        <section className="panel voice-panel">
          <div className="panel-title">
            <Mic2 size={18} />
            <h2>语音播报</h2>
          </div>
          <div className="speech-row">
            <span>播报开关</span>
            <button className={speechEnabled ? "chip active" : "chip"} onClick={toggleSpeechEnabled}>
              {speechEnabled ? "已开启" : "已关闭"}
            </button>
          </div>
          <div className="speech-row">
            <span>自动复播</span>
            <div className="chip-group">
              {[0, 3, 5, 10].map((minutes) => (
                <button
                  key={minutes}
                  className={repeatMinutes === minutes ? "chip active" : "chip"}
                  onClick={() => changeRepeat(minutes)}
                >
                  {minutes === 0 ? "关" : `${minutes} 分钟`}
                </button>
              ))}
            </div>
          </div>
          <div className="speech-row">
            <span>播报音色</span>
            <select className="voice-select" value={ttsVoice} onChange={(event) => changeVoice(event.target.value)}>
              <option value="">本机默认（离线，推荐）</option>
              {localVoices
                .filter((voice) => /^zh/i.test(voice.lang))
                .map((voice) => (
                  <option key={voice.voiceURI} value={voice.voiceURI}>
                    {voice.name}
                  </option>
                ))}
              {ttsCloudEnabled &&
                voiceList.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.label}（在线 HD）
                  </option>
                ))}
            </select>
          </div>
          <div className="speech-row">
            <span>在线 HD 音色</span>
            <button
              className={ttsCloudEnabled ? "chip active" : "chip"}
              onClick={() => {
                const next = !ttsCloudEnabled;
                setTtsCloudEnabled(next);
                window.localStorage.setItem("codestatus-tts-cloud", next ? "1" : "0");
              }}
              title="在线高清音色需联网，境内可能要代理；默认关闭以保证离线可用"
            >
              {ttsCloudEnabled ? "已开启" : "已关闭"}
            </button>
          </div>
          <div className="speech-row">
            <span>语速</span>
            <div className="chip-group">
              {[
                { label: "慢", value: -25 },
                { label: "正常", value: 0 },
                { label: "快", value: 25 },
                { label: "更快", value: 50 }
              ].map((option) => (
                <button
                  key={option.value}
                  className={ttsRate === option.value ? "chip active" : "chip"}
                  onClick={() => changeRate(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="speech-row">
            <span>试听</span>
            <button
              className="chip"
              onClick={() => {
                stopSpeech();
                enqueueSpeak({ text: "你好，我是你的代码状态播报助手，现在正在写代码。" });
              }}
            >
              试听当前音色
            </button>
          </div>
          <div className="query-box">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：Claude 现在在做什么？" />
            <button className="primary-button" onClick={() => enqueueSpeak({ text: voiceAnswer, source: activeTool?.source })}>
              <Volume2 size={17} />
              <span>回答</span>
            </button>
          </div>
          <p className="answer">{answer}</p>
        </section>

        <HookGuidePanel agentBase={agentBase} apiHeaders={apiHeaders} />
      </section>
    </>
  );

  // 手机端二级界面：黑屏常驻展示（左像素小人 / 右当前任务 + 状态列表）
  if (displayMode && showStage) {
    return (
      <main className="display-screen stage-page">
        <div className="display-topline">
          <StatusPill connected={connected} detail={connectionDetail} retryCount={retryCount} />
          <span className="display-mode-label">常驻展示</span>
          <button className="display-exit" onClick={toggleSpeechEnabled}>{speechEnabled ? "语音开" : "语音关"}</button>
          <button className="display-exit" onClick={speakCurrent}>播报</button>
          <button className="display-exit" onClick={startVoiceDialog}>{listening ? "聆听中" : "对话"}</button>
          <button className="display-exit" onClick={toggleFullscreen}>{isFullscreen ? "退出全屏" : "进入全屏"}</button>
          <button className="display-exit" onClick={() => setShowStage(false)}>返回</button>
        </div>
        <ConnectionBanner connected={connected} detail={connectionDetail} retryCount={retryCount} />
        {pairingRequired ? <RepairPanel resetLocalPairing={resetLocalPairing} /> : null}
        <section
          className="display-center"
          onTouchStart={(event) => handleTouchStart(event)}
          onTouchEnd={(event) => handleTouchEnd(event, stepInstance)}
        >
          <button className="pet-focus-button" onClick={() => setShowStage(false)} title="返回一级界面">
            <Pet tool={activeTool} />
          </button>
          <StageStatusPanel tool={activeTool} status={status} />
        </section>
        <DisplayDots tools={status?.tools || []} selectedInstanceId={activeTool?.instanceId} />
      </main>
    );
  }

  // 手机端一级界面：内容与电脑端一致
  if (displayMode) {
    return (
      <main className="app-shell mobile-primary">
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark">
              <Bot size={24} />
            </div>
            <div>
              <h1>CodeStatus</h1>
              <p>手机状态屏</p>
            </div>
          </div>
          <div className="top-actions">
            <StatusPill connected={connected} detail={connectionDetail} retryCount={retryCount} />
            <button className="icon-button" title="语音播报开关" onClick={toggleSpeechEnabled}>
              {speechEnabled ? <Volume2 size={19} /> : <VolumeX size={19} />}
            </button>
            <button className="icon-button" title="播报当前状态" onClick={speakCurrent}>
              <Mic2 size={19} />
            </button>
            <button className="icon-button" title="退出状态屏" onClick={() => setDisplayMode(false)}>
              <MonitorSmartphone size={19} />
            </button>
          </div>
        </header>
        <ConnectionBanner connected={connected} detail={connectionDetail} retryCount={retryCount} />
        {pairingRequired ? <RepairPanel resetLocalPairing={resetLocalPairing} /> : null}
        <p className="mobile-hint">点击上方像素小人进入常驻展示页</p>
        {renderDashboard(true)}
      </main>
    );
  }

  // 电脑端：单页面（顶部小人 + 状态，下方监控 / 模拟 / 配对等卡片）
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Bot size={24} />
          </div>
          <div>
            <h1>CodeStatus Companion</h1>
            <p>多 Coding 工具状态监控</p>
          </div>
        </div>
        <div className="top-actions">
          <StatusPill connected={connected} detail={connectionDetail} retryCount={retryCount} />
          <button className="icon-button" title="全屏状态屏" onClick={() => setDisplayMode(true)}>
            <Moon size={19} />
          </button>
          <button className="icon-button" title="语音播报开关" onClick={toggleSpeechEnabled}>
            {speechEnabled ? <Volume2 size={19} /> : <VolumeX size={19} />}
          </button>
          <button className="icon-button" title="播报当前状态" onClick={speakCurrent}>
            <Mic2 size={19} />
          </button>
        </div>
      </header>

      <ConnectionBanner connected={connected} detail={connectionDetail} retryCount={retryCount} />
      {pairingRequired ? <RepairPanel resetLocalPairing={resetLocalPairing} /> : null}

      {renderDashboard(false)}
    </main>
  );
}

let touchStartX = 0;

function handleTouchStart(event) {
  touchStartX = event.changedTouches?.[0]?.clientX || 0;
}

function handleTouchEnd(event, stepInstance) {
  const endX = event.changedTouches?.[0]?.clientX || 0;
  const delta = endX - touchStartX;
  if (Math.abs(delta) < 42) return;
  stepInstance(delta < 0 ? 1 : -1);
}

function StatusPill({ connected, detail, retryCount }) {
  return (
    <div className={connected ? "status-pill online" : "status-pill offline"} title={detail}>
      {connected ? <Wifi size={16} /> : <WifiOff size={16} />}
      <span>{connected ? "Agent 在线" : retryCount ? `重连中 ${retryCount}` : "Agent 离线"}</span>
    </div>
  );
}

function ConnectionBanner({ connected, detail, retryCount }) {
  return (
    <div className={connected ? "connection-banner online" : "connection-banner offline"}>
      {connected ? <ShieldCheck size={17} /> : <AlertTriangle size={17} />}
      <span>{detail}</span>
      {!connected && retryCount ? <strong>（已重试 {retryCount} 次）</strong> : null}
    </div>
  );
}

function RepairPanel({ resetLocalPairing }) {
  return (
    <section className="repair-panel">
      <div>
        <strong>需要重新配对</strong>
        <span>当前设备密钥失效、token 过期，或这台设备已被电脑端撤销。请在电脑端打开局域网配对二维码重新扫码。</span>
      </div>
      <button className="primary-button" onClick={resetLocalPairing}>
        <KeyRound size={16} />
        <span>清除本机配对</span>
      </button>
    </section>
  );
}

function ActiveStatus({ tool, connected, rotatingCount = 0 }) {
  if (!tool) {
    return (
      <div className="active-copy">
        <p className="eyebrow">等待本地服务</p>
        <h2>还没有状态数据</h2>
        <p>启动 Agent 后，Claude Code、Codex、Cursor 和 VS Code 的状态会显示在这里。</p>
      </div>
    );
  }

  const meta = stateMeta[tool.state] || stateMeta.idle;
  const Icon = meta.icon;
  const eyebrow = rotatingCount > 1 ? `轮换展示 · ${rotatingCount} 个运行中` : connected ? "实时同步中" : "正在重连";

  return (
    <div className="active-copy">
      <p className="eyebrow">{eyebrow}</p>
      <div className="headline-row">
        <Icon className={tool.state === "thinking" ? "spin" : ""} size={30} />
        <h2>{tool.title}</h2>
      </div>
      <p>{tool.message}</p>
      <div className="active-meta">
        <span>{tool.label}</span>
        {tool.projectName ? <span>{tool.projectName}</span> : null}
        <span>{stateMeta[tool.state]?.label || tool.state}</span>
        <span>{modelText(tool)}</span>
        {tool.hookEvent ? <span>{tool.hookEvent}</span> : null}
        <span>{tool.confidence ? `${Math.round(tool.confidence * 100)}% 置信度` : "等待信号"}</span>
        <span>{tool.updatedAt ? `${formatTime(tool.updatedAt)} 更新` : "未更新"}</span>
      </div>
    </div>
  );
}

function DisplayStatus({ tool, status }) {
  if (!tool) {
    return (
      <div className="display-copy">
        <h2>等待连接</h2>
        <p>本地 Agent 暂无状态</p>
      </div>
    );
  }

  const state = stateMeta[tool.state]?.label || tool.state;
  return (
    <div className="display-copy">
      <p>{tool.label}</p>
      <h2>{state}</h2>
      <strong>{tool.message}</strong>
      <span>{modelText(tool)}</span>
      <span>
        {status?.activeCount || 0} 个活跃实例 · {tool.updatedAt ? `${formatTime(tool.updatedAt)} 更新` : "等待事件"}
      </span>
    </div>
  );
}

function StageStatusPanel({ tool, status }) {
  const tools = status?.tools || [];
  if (!tool) {
    return (
      <div className="stage-panel">
        <div className="stage-current">
          <p>等待连接</p>
          <h2>暂无状态</h2>
          <strong>本地 Agent 暂无事件</strong>
        </div>
      </div>
    );
  }

  const state = stateMeta[tool.state]?.label || tool.state;
  return (
    <div className="stage-panel">
      <div className="stage-current">
        <p>{tool.label}</p>
        <h2>{state}</h2>
        <strong>{tool.message}</strong>
        <span>{modelText(tool)}</span>
        <span>{tool.updatedAt ? `${formatTime(tool.updatedAt)} 更新` : "等待事件"}</span>
      </div>

      <div className="stage-mini-list">
        <div className="stage-section-title">监听中 · {status?.activeCount || 0} 个活跃实例</div>
        {tools.slice(0, 5).map((item) => (
          <div className="stage-mini-row" key={item.instanceId || item.source}>
            <span>{item.label}</span>
            <strong>{stateMeta[item.state]?.label || item.state}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

const notifyStateOptions = [
  { value: "prompt_submitted", label: "任务开始" },
  { value: "completed", label: "任务完成" },
  { value: "failed", label: "出现问题" },
  { value: "waiting_permission", label: "等待授权" },
  { value: "waiting_user", label: "等待输入" }
];

const graceSecondsOptions = [0, 5, 10, 20, 30, 60];

// Hook 安装引导（仅电脑端可用：检测 / 安装 Claude Code / Codex 的 CLI hook）
function HookGuidePanel({ agentBase, apiHeaders }) {
  const [hookStatus, setHookStatus] = useState(null);
  const [installing, setInstalling] = useState("");
  const [message, setMessage] = useState("");

  const refresh = () => {
    fetch(`${agentBase}/api/hooks/status`, { headers: apiHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setHookStatus(data))
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
  }, [agentBase, apiHeaders]);

  if (!hookStatus) return null;

  const tools = [
    { id: "claude-code", name: "Claude Code", desc: "Anthropic 的 AI 编程 CLI" },
    { id: "codex", name: "Codex", desc: "OpenAI 的 AI 编程 CLI" }
  ];

  async function install(toolId, toolName) {
    setInstalling(toolId);
    setMessage("");
    try {
      const response = await fetch(`${agentBase}/api/hooks/install`, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({ tool: toolId })
      });
      const data = await response.json();
      if (response.ok && data.ok) {
        setMessage(`${toolName} Hook 安装成功`);
        if (data.status) setHookStatus(data.status);
      } else {
        setMessage(`${toolName} 安装失败：${data.error || "未知错误"}`);
      }
    } catch (error) {
      setMessage(`${toolName} 安装失败：${error.message}`);
    } finally {
      setInstalling("");
    }
  }

  return (
    <section className="panel notify-panel">
      <div className="panel-title">
        <ShieldCheck size={18} />
        <h2>监控增强</h2>
      </div>
      <p className="notify-hint" style={{ marginBottom: 12 }}>
        安装 CLI Hook 后可获得更精准的实时状态监控。进程检测（指纹库）无需安装即可工作，但 Hook 能提供更丰富的实时事件（工具调用、权限请求等）。
      </p>
      {tools.map((tool) => {
        const installed = hookStatus[tool.id];
        return (
          <div key={tool.id} className="speech-row" style={{ alignItems: "center" }}>
            <span>
              <strong>{tool.name}</strong>
              <br />
              <small className="notify-hint">{tool.desc}</small>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {installed ? (
                <>
                  <CheckCircle2 size={16} style={{ color: "var(--done, #2d9c72)" }} />
                  <span style={{ fontSize: 13, color: "var(--done, #2d9c72)" }}>已安装</span>
                </>
              ) : (
                <button
                  className="chip active"
                  disabled={installing === tool.id}
                  onClick={() => install(tool.id, tool.name)}
                  style={{ opacity: installing === tool.id ? 0.6 : 1 }}
                >
                  {installing === tool.id ? "安装中…" : "一键安装"}
                </button>
              )}
            </span>
          </div>
        );
      })}
      {message && <p className="notify-hint" style={{ marginTop: 8 }}>{message}</p>}
    </section>
  );
}

// 消息推送设置（仅电脑端可用：/api/settings 只允许本机访问，手机端拿不到就不渲染）
function NotificationPanel({ agentBase, apiHeaders }) {
  const [notify, setNotify] = useState(null);
  const [saveState, setSaveState] = useState("");
  const [testResults, setTestResults] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`${agentBase}/api/settings`, { headers: apiHeaders })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (active && data?.notify) setNotify(data.notify);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [agentBase, apiHeaders]);

  if (!notify) return null;

  const patch = (updates) => {
    setNotify((current) => ({ ...current, ...updates }));
    setSaveState("");
  };
  const patchChannel = (channel, updates) => {
    setNotify((current) => ({ ...current, [channel]: { ...current[channel], ...updates } }));
    setSaveState("");
  };
  const toggleState = (value) => {
    patch({
      states: notify.states.includes(value)
        ? notify.states.filter((item) => item !== value)
        : [...notify.states, value]
    });
  };

  async function save() {
    try {
      const response = await fetch(`${agentBase}/api/settings`, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({ notify })
      });
      setSaveState(response.ok ? "已保存" : "保存失败");
    } catch {
      setSaveState("保存失败");
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestResults(null);
    try {
      await fetch(`${agentBase}/api/settings`, { method: "POST", headers: apiHeaders, body: JSON.stringify({ notify }) });
      const response = await fetch(`${agentBase}/api/notify/test`, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({})
      });
      const data = await response.json();
      setTestResults(data.results || []);
    } catch {
      setTestResults([{ channel: "network", ok: false, error: "无法访问本地 Agent" }]);
    } finally {
      setTesting(false);
    }
  }

  const channelNames = { serverchan: "Server酱", pushplus: "PushPlus", email: "邮件", none: "渠道", network: "网络" };

  return (
    <section className="panel notify-panel">
      <div className="panel-title">
        <BellRing size={18} />
        <h2>手机消息推送</h2>
      </div>
      <div className="speech-row">
        <span>推送开关</span>
        <button className={notify.enabled ? "chip active" : "chip"} onClick={() => patch({ enabled: !notify.enabled })}>
          {notify.enabled ? "已开启" : "已关闭"}
        </button>
      </div>
      <div className="speech-row">
        <span>推送时机</span>
        <div className="chip-group">
          {notifyStateOptions.map((option) => (
            <button
              key={option.value}
              className={notify.states.includes(option.value) ? "chip active" : "chip"}
              onClick={() => toggleState(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="speech-row">
        <span>完成确认延时</span>
        <div className="chip-group">
          {graceSecondsOptions.map((sec) => (
            <button
              key={sec}
              className={Number(notify.completedGraceSeconds ?? 10) === sec ? "chip active" : "chip"}
              onClick={() => patch({ completedGraceSeconds: sec })}
            >
              {sec === 0 ? "即时" : `${sec}秒`}
            </button>
          ))}
        </div>
      </div>
      <p className="notify-hint">
        任务结束后静默这么久没有新动作，才判定为「整体完成」并播报 / 推送——避免子任务、单轮结束时误报「已完成」。选「即时」恢复旧行为；改完记得点下方「保存设置」。
      </p>

      <div className="notify-channel">
        <div className="speech-row">
          <span>微信 · Server酱</span>
          <button
            className={notify.serverchan.enabled ? "chip active" : "chip"}
            onClick={() => patchChannel("serverchan", { enabled: !notify.serverchan.enabled })}
          >
            {notify.serverchan.enabled ? "已启用" : "未启用"}
          </button>
        </div>
        {notify.serverchan.enabled ? (
          <>
            <input
              className="notify-input"
              type="password"
              placeholder="SendKey（sct.ftqq.com 微信扫码登录后复制）"
              value={notify.serverchan.sendKey}
              onChange={(event) => patchChannel("serverchan", { sendKey: event.target.value.trim() })}
            />
            <p className="notify-hint">打开 sct.ftqq.com → 微信扫码登录 → 复制 SendKey 粘贴到上面，消息会推到微信「方糖」服务号。</p>
          </>
        ) : null}
      </div>

      <div className="notify-channel">
        <div className="speech-row">
          <span>微信 · PushPlus</span>
          <button
            className={notify.pushplus.enabled ? "chip active" : "chip"}
            onClick={() => patchChannel("pushplus", { enabled: !notify.pushplus.enabled })}
          >
            {notify.pushplus.enabled ? "已启用" : "未启用"}
          </button>
        </div>
        {notify.pushplus.enabled ? (
          <>
            <input
              className="notify-input"
              type="password"
              placeholder="Token（pushplus.plus 微信扫码登录后复制）"
              value={notify.pushplus.token}
              onChange={(event) => patchChannel("pushplus", { token: event.target.value.trim() })}
            />
            <p className="notify-hint">打开 pushplus.plus → 微信扫码登录 → 复制一对一推送 Token，消息推到微信「pushplus」公众号。</p>
          </>
        ) : null}
      </div>

      <div className="notify-channel">
        <div className="speech-row">
          <span>邮件推送</span>
          <button
            className={notify.email.enabled ? "chip active" : "chip"}
            onClick={() => patchChannel("email", { enabled: !notify.email.enabled })}
          >
            {notify.email.enabled ? "已启用" : "未启用"}
          </button>
        </div>
        {notify.email.enabled ? (
          <>
            <div className="notify-input-row">
              <input
                className="notify-input"
                placeholder="SMTP 服务器（如 smtp.qq.com）"
                value={notify.email.host}
                onChange={(event) => patchChannel("email", { host: event.target.value.trim() })}
              />
              <input
                className="notify-input port"
                placeholder="端口"
                value={notify.email.port}
                onChange={(event) => patchChannel("email", { port: Number(event.target.value) || 465 })}
              />
            </div>
            <input
              className="notify-input"
              placeholder="发件邮箱（如 xxx@qq.com）"
              value={notify.email.user}
              onChange={(event) => patchChannel("email", { user: event.target.value.trim() })}
            />
            <input
              className="notify-input"
              type="password"
              placeholder="SMTP 授权码（不是邮箱密码）"
              value={notify.email.pass}
              onChange={(event) => patchChannel("email", { pass: event.target.value.trim() })}
            />
            <input
              className="notify-input"
              placeholder="收件邮箱（默认发给自己，多个用逗号分隔）"
              value={notify.email.to}
              onChange={(event) => patchChannel("email", { to: event.target.value.trim() })}
            />
            <p className="notify-hint">QQ 邮箱：设置 → 账号 → 开启 SMTP 服务并生成授权码。手机 / 平板装邮箱 App 即可实时收信。</p>
          </>
        ) : null}
      </div>

      <div className="notify-actions">
        <button className="primary-button" onClick={save}>
          <CheckCircle2 size={16} />
          <span>保存设置</span>
        </button>
        <button className="secondary-button" onClick={sendTest} disabled={testing}>
          <Send size={16} />
          <span>{testing ? "发送中…" : "发送测试消息"}</span>
        </button>
        {saveState ? <em className="notify-save-state">{saveState}</em> : null}
      </div>
      {testResults ? (
        <div className="notify-test-results">
          {testResults.map((result) => (
            <span key={result.channel} className={result.ok ? "ok" : "bad"}>
              {channelNames[result.channel] || result.channel}：{result.ok ? "发送成功 ✓" : `失败（${result.error}）`}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// 按软件（source）设置独立音色/音量/语速，避免多软件播报串台、听不清。
// 持久化到 settings.voiceOverrides = { "comfyui": { voice, volume, rate } }；留空=跟随全局。
function VoiceOverridesPanel({ agentBase, apiHeaders, status, sourceLabels, localVoices, cloudVoices, cloudEnabled }) {
  const [overrides, setOverrides] = useState(null);
  const [saveState, setSaveState] = useState("");

  useEffect(() => {
    let active = true;
    fetch(`${agentBase}/api/settings`, { headers: apiHeaders })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (active) setOverrides(data?.voiceOverrides || {});
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [agentBase, apiHeaders]);

  const sources = useMemo(() => {
    const seen = new Map();
    for (const tool of status?.tools || []) {
      if (tool.isPlaceholder) continue;
      const key = tool.source || "generic";
      if (key === "generic" || key.startsWith("_")) continue;
      if (!seen.has(key)) seen.set(key, tool.sourceLabel || tool.label || key);
    }
    return Array.from(seen, ([source, label]) => ({ source, label }));
  }, [status]);

  if (overrides === null) return null;

  const get = (source) => overrides[source] || {};
  const setField = (source, field, value) => {
    setOverrides((current) => ({
      ...current,
      [source]: { ...(current[source] || {}), [field]: value }
    }));
    setSaveState("");
  };

  async function save() {
    try {
      const response = await fetch(`${agentBase}/api/settings`, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({ voiceOverrides: overrides })
      });
      setSaveState(response.ok ? "已保存" : "保存失败");
    } catch {
      setSaveState("保存失败");
    }
  }

  return (
    <section className="panel notify-panel">
      <div className="panel-title">
        <Mic2 size={18} />
        <h2>按软件播报设置</h2>
      </div>
      <p className="answer">为每个软件单独设置音色/音量/语速；留空则跟随全局，未列出的软件走全局设置。</p>
      {sources.map(({ source, label }) => {
        const cur = get(source);
        return (
          <div key={source} className="voice-override-row">
            <div className="speech-row">
              <span>{label}</span>
              <select
                className="voice-select"
                value={cur.voice ?? ""}
                onChange={(event) => setField(source, "voice", event.target.value)}
              >
                <option value="">跟随全局</option>
                {localVoices
                  .filter((voice) => /^zh/i.test(voice.lang))
                  .map((voice) => (
                    <option key={voice.voiceURI} value={voice.voiceURI}>
                      {voice.name}
                    </option>
                  ))}
                {cloudEnabled &&
                  (cloudVoices || []).map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.label}（在线 HD）
                    </option>
                  ))}
              </select>
            </div>
            <div className="speech-row">
              <span>音量</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={cur.volume ?? 1}
                onChange={(event) => setField(source, "volume", Number(event.target.value))}
              />
              <span>{Math.round((cur.volume ?? 1) * 100)}%</span>
            </div>
            <div className="speech-row">
              <span>语速</span>
              <div className="chip-group">
                {[
                  { label: "慢", value: -25 },
                  { label: "正常", value: 0 },
                  { label: "快", value: 25 },
                  { label: "更快", value: 50 }
                ].map((option) => (
                  <button
                    key={option.value}
                    className={(cur.rate ?? 0) === option.value ? "chip active" : "chip"}
                    onClick={() => setField(source, "rate", option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })}
      <div className="speech-row">
        <button className="primary-button" onClick={save}>
          保存
        </button>
        {saveState && <span className="answer">{saveState}</span>}
      </div>
    </section>
  );
}

function PairingPanel({ pairing, network, rotatePairingToken, revokeDevice, refreshNetwork, togglePrivacyMode }) {
  // 为每个网卡 IP 各拼一条连接地址（真实局域网优先，虚拟网卡兜底排后面）
  const candidates = useMemo(() => buildPairingCandidates(pairing), [pairing]);
  const [qrMap, setQrMap] = useState({});
  const [activeIndex, setActiveIndex] = useState(0);
  const [autoRotate, setAutoRotate] = useState(true);

  // 一次性为所有候选 IP 预生成二维码（URL 集合变化才重算）
  useEffect(() => {
    let active = true;
    Promise.all(
      candidates.map((candidate) =>
        QRCode.toDataURL(candidate.url, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 220,
          color: { dark: "#182026", light: "#ffffff" }
        })
          .then((data) => [candidate.url, data])
          .catch(() => [candidate.url, ""])
      )
    ).then((entries) => {
      if (active) setQrMap(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
  }, [candidates]);

  // 候选超过 1 个时，大图每 6 秒自动轮换到下一个（暂停时不动，留足扫码时间）
  useEffect(() => {
    if (!autoRotate || candidates.length <= 1) return undefined;
    const timer = window.setInterval(() => {
      setActiveIndex((index) => (index + 1) % candidates.length);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [autoRotate, candidates.length]);

  const total = candidates.length;
  const safeIndex = total ? ((activeIndex % total) + total) % total : 0;
  const current = total ? candidates[safeIndex] : null;
  const currentQr = current ? qrMap[current.url] : "";

  function focusCandidate(index) {
    setAutoRotate(false);
    setActiveIndex(index);
  }

  function step(direction) {
    if (!total) return;
    setAutoRotate(false);
    setActiveIndex((index) => (index + direction + total) % total);
  }

  return (
    <section className="panel pairing-panel">
      <div className="panel-title">
        <MonitorSmartphone size={18} />
        <h2>局域网配对</h2>
      </div>
      {current ? (
        <div className="qr-rotator">
          <div className="qr-rotator-main">
            {currentQr ? (
              <img src={currentQr} alt={`配对二维码 ${current.address}`} />
            ) : (
              <div className="qr-placeholder">生成二维码…</div>
            )}
            <div className="qr-current-label">
              <strong>{current.address}</strong>
              <span>{current.reachable ? "推荐 · 真实局域网网段" : "兜底 · 虚拟网卡，多半连不上"}</span>
              {total > 1 ? <em>第 {safeIndex + 1} / {total} 个 · 扫不开就点「下一个」换一张</em> : null}
            </div>
            {total > 1 ? (
              <div className="qr-controls">
                <button className="mini-button" onClick={() => step(-1)} title="上一个二维码">‹ 上一个</button>
                <button className="mini-button" onClick={() => setAutoRotate((value) => !value)}>
                  {autoRotate ? <PauseCircle size={14} /> : <Play size={14} />}
                  {autoRotate ? "自动轮换中" : "已暂停"}
                </button>
                <button className="mini-button" onClick={() => step(1)} title="下一个二维码">下一个 ›</button>
              </div>
            ) : null}
          </div>
          {total > 1 ? (
            <div className="qr-thumb-grid">
              {candidates.map((candidate, index) => (
                <button
                  key={candidate.address}
                  className={index === safeIndex ? "qr-thumb active" : "qr-thumb"}
                  onClick={() => focusCandidate(index)}
                  title={candidate.url}
                >
                  {qrMap[candidate.url] ? (
                    <img src={qrMap[candidate.url]} alt={candidate.address} />
                  ) : (
                    <div className="qr-placeholder small">…</div>
                  )}
                  <span>{candidate.address}</span>
                  <em>{candidate.reachable ? "推荐" : "虚拟网卡"}</em>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="empty small">等待 Agent 返回配对地址…</div>
      )}
      <div className="pairing-copy">
        <strong>{current?.url || pairing?.connectUrl || "等待 Agent 返回配对地址"}</strong>
        <span>手机和电脑要连同一个 Wi-Fi。⚠️ 微信扫码打不开 IP 网址是正常的，请用「系统相机 / 浏览器扫一扫」，或在 App 里用「扫码连接」。扫不开时点「下一个」换一张逐个试，能连上的那张就是对的；也可以直接在手机浏览器打开上面这条地址。</span>
      </div>
      {pairing?.secureAgentUrl ? (
        <div className="secure-channel">
          <ShieldCheck size={16} />
          <div>
            <strong>HTTPS Agent 通道</strong>
            <span>{pairing.secureAgentUrl}</span>
            {pairing?.certificateFingerprint ? <code>{pairing.certificateFingerprint}</code> : null}
          </div>
        </div>
      ) : null}
      {pairing?.pairingToken ? (
        <div className="pairing-token">
          <span>Token</span>
          <code>{pairing.pairingToken}</code>
        </div>
      ) : null}
      {network ? <NetworkDiagnostics network={network} refreshNetwork={refreshNetwork} /> : null}
      <div className="device-list">
        {(pairing?.devices || []).length ? (
          pairing.devices.map((device) => (
            <div className="device-row" key={device.id}>
              <div>
                <strong>{device.name}</strong>
                <span>{device.ip} · {formatTime(device.lastSeenAt)} · {device.credential === "device-secret" ? "设备密钥" : "配对 token"}</span>
              </div>
              <button className="danger-icon-button" title="撤销设备" onClick={() => revokeDevice(device.id)}>
                <Trash2 size={15} />
              </button>
            </div>
          ))
        ) : (
          <div className="empty small">暂无已配对设备</div>
        )}
      </div>
      <button className="primary-button pairing-button" onClick={rotatePairingToken}>
        <RefreshCw size={16} />
        <span>重新生成</span>
      </button>
      <button className="secondary-button pairing-button" onClick={togglePrivacyMode}>
        <EyeOff size={16} />
        <span>{pairing?.privacyMode ? "关闭隐私模式" : "开启隐私模式"}</span>
      </button>
    </section>
  );
}

// 真实可路由的私有局域网网段（手机大概率能连上）；其余视为虚拟/代理网卡兜底
function isLikelyReachable(address) {
  return (
    /^192\.168\./.test(address) ||
    /^10\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)
  );
}

// 把电脑所有网卡 IP 各拼成一条配对地址，真实局域网排前、虚拟网卡兜底排后
function buildPairingCandidates(pairing) {
  if (!pairing) return [];
  const frontendPort = pairing.frontendPort || 5173;
  const pairCode = pairing.pairCode;
  const query = pairCode ? `?display=1&pair=${pairCode}` : "?display=1";
  // allAddresses 含全部网卡(含虚拟)，addresses 是服务端已过滤的真实网卡白名单
  const raw =
    pairing.allAddresses && pairing.allAddresses.length
      ? pairing.allAddresses
      : (pairing.addresses || []).map((address) => ({ address, name: "" }));
  const realSet = new Set(pairing.addresses || []);
  const defaultIp = (String(pairing.connectUrl || "").match(/\/\/([^:/?]+)/) || [])[1] || "";

  const seen = new Set();
  const list = [];
  for (const item of raw) {
    const address = typeof item === "string" ? item : item?.address;
    if (!address || seen.has(address)) continue;
    seen.add(address);
    list.push({
      address,
      name: typeof item === "string" ? "" : item?.name || "",
      url: `http://${address}:${frontendPort}${query}`,
      // 服务端真实网卡白名单 + 私有网段双重判断，避免把 VMware/WSL 误标成推荐
      reachable: realSet.has(address) && isLikelyReachable(address)
    });
  }

  // 服务端默认推荐的那个 IP 绝对排第一，其余按「真实网段优先」排序
  list.sort((a, b) => {
    if (a.address === defaultIp) return -1;
    if (b.address === defaultIp) return 1;
    return Number(b.reachable) - Number(a.reachable);
  });
  return list;
}

function NetworkDiagnostics({ network, refreshNetwork }) {
  return (
    <div className="network-diagnostics">
      <div className="network-head">
        <div>
          <strong>{network.agentName || "CodeStatus Desktop"}</strong>
          <span>{network.addresses?.map((item) => item.address).join(" / ") || "未发现局域网地址"}</span>
        </div>
        <button className="mini-button" onClick={refreshNetwork}>
          <RefreshCw size={14} />
          检测
        </button>
      </div>
      <div className="diagnostic-list">
        {(network.diagnostics || []).map((item) => (
          <div className={`diagnostic-row ${item.state}`} key={item.id}>
            <strong>{item.label}</strong>
            <span>{item.message}</span>
          </div>
        ))}
      </div>
      <div className="network-guidance">
        {(network.guidance || []).slice(0, 2).map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
    </div>
  );
}

function DisplayDots({ tools, selectedInstanceId }) {
  if (!tools.length) return null;
  return (
    <div className="display-dots">
      {tools.slice(0, 8).map((tool) => (
        <span key={tool.instanceId || tool.source} className={tool.instanceId === selectedInstanceId ? "active" : ""} />
      ))}
    </div>
  );
}

function Pet({ tool }) {
  const state = tool?.state || "offline";
  const meta = stateMeta[state] || stateMeta.idle;
  return (
    <div className={`pet-stage ${meta.tone}`}>
      <div className={`pet ${meta.pet}`}>
        <div className="pixel-shadow" />
        <div className="pixel-head">
          <div className="pixel-hair one" />
          <div className="pixel-hair two" />
          <div className="pixel-eye left" />
          <div className="pixel-eye right" />
          <div className="pixel-mouth" />
        </div>
        <div className="pixel-neck" />
        <div className="pixel-hoodie">
          <div className="pixel-arm left" />
          <div className="pixel-arm right" />
        </div>
        <div className="pixel-terminal">
          <span>{shortStateLabel(state)}</span>
        </div>
      </div>
      <div className="signal-ring one" />
      <div className="signal-ring two" />
    </div>
  );
}

function ToolRow({ tool, active }) {
  const meta = stateMeta[tool.state] || stateMeta.idle;
  const Icon = meta.icon;
  return (
    <div className={`tool-row ${meta.tone}${active ? " active" : ""}`}>
      <div className="tool-icon">
        <Icon size={18} />
      </div>
      <div className="tool-copy">
        <strong>{tool.label}</strong>
        <span>{tool.message}</span>
        <em>{modelText(tool)}</em>
        {tool.workspace ? <em>{tool.workspace}</em> : null}
      </div>
      <div className="tool-state">{meta.label}</div>
    </div>
  );
}

function EventTimeline({ events }) {
  if (!events.length) {
    return <div className="empty">暂无事件</div>;
  }

  return (
    <div className="timeline">
      {events.map((event) => {
        const meta = stateMeta[event.state] || stateMeta.idle;
        const Icon = meta.icon;
        return (
          <div className="timeline-row" key={event.eventId}>
            <div className={`timeline-icon ${meta.tone}`}>
              <Icon size={16} />
            </div>
            <div>
              <strong>{event.title}</strong>
              <span>{event.message}</span>
              {event.model ? <em>{modelText(event)}</em> : null}
              {event.workspace ? <em>{event.workspace}</em> : null}
            </div>
            <time>{formatTime(event.createdAt)}</time>
          </div>
        );
      })}
    </div>
  );
}

function makeAnswer(query, tool, status) {
  if (!tool) return "当前还没有连接到本地状态服务。";
  const q = query.trim();
  const state = stateMeta[tool.state]?.label || tool.state;
  const recentProblem = status?.recentEvents?.find((event) => event.severity === "error" || event.severity === "warning");

  if (q.includes("问题") || q.includes("错误") || q.includes("卡")) {
    if (!recentProblem) return "最近没有检测到明显问题。";
    return `最近需要关注的是：${recentProblem.title}。${recentProblem.message}`;
  }

  return `${tool.label} 现在是「${state}」。${tool.message || "没有更多细节。"}${tool.model ? ` 使用模型 ${tool.model}。` : ""}${tool.workspace ? ` 工作区是 ${tool.workspace}。` : ""}`;
}

function makeVoiceAnswer(query, tool, status) {
  if (!tool) return "当前还没有连接到本地状态服务。";
  const q = query.trim();
  if (q.includes("问题") || q.includes("错误") || q.includes("卡")) {
    return makeAnswer(query, tool, status);
  }
  return briefSpeechForStatus(tool);
}

function briefSpeechForStatus(item) {
  if (!item) return "当前还没有连接到本地状态服务。";
  const state = stateMeta[item.state]?.label || item.state;
  // 播报始终带上软件名称（多软件同时运行时用于区分）
  const name = item.sourceLabel || item.label || item.source || "任务";
  const project = item.projectName ? `${item.projectName}，` : "";
  return `${name}，${project}${state}`;
}

function announcementForEvent(event) {
  return briefSpeechForStatus(event);
}

function shortStateLabel(state) {
  const label = stateMeta[state]?.label || state;
  return label.replace("正在", "").replace("等待", "等");
}

function formatTime(value) {
  if (!value) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function modelText(item) {
  return item?.model ? `模型 ${item.model}` : "模型未知";
}
