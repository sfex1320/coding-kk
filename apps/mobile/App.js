import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import * as Speech from "expo-speech";

const AGENT_PORT = 4317;

// 相机模块懒加载：启动时不初始化相机，避免在不支持相机的系统（如鸿蒙兼容层）上崩溃
function loadCamera() {
  try {
    // eslint-disable-next-line global-require
    const mod = require("expo-camera");
    return mod && mod.CameraView ? mod : null;
  } catch {
    return null;
  }
}

const STATE_LABELS = {
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
  completed: "已完成",
  failed: "出现问题",
  paused: "已暂停"
};

const STATE_TONE = {
  offline: "#68757d",
  idle: "#68757d",
  prompt_submitted: "#3f6ecf",
  thinking: "#3f6ecf",
  using_tool: "#0f8c9a",
  writing_code: "#0f8c9a",
  running_command: "#0f8c9a",
  running_tests: "#0f8c9a",
  waiting_permission: "#c98618",
  waiting_user: "#c98618",
  completed: "#2d9c72",
  failed: "#c84b42",
  paused: "#68757d"
};

// 持久化存储（AsyncStorage 可用则用，否则退回内存）
const storage = (() => {
  try {
    // eslint-disable-next-line global-require
    const mod = require("@react-native-async-storage/async-storage");
    return mod.default || mod;
  } catch {
    const mem = {};
    return {
      getItem: async (k) => (k in mem ? mem[k] : null),
      setItem: async (k, v) => {
        mem[k] = v;
      },
      removeItem: async (k) => {
        delete mem[k];
      }
    };
  }
})();

function randomId() {
  return `rn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function App() {
  const [agent, setAgent] = useState(null); // { host, deviceId, deviceSecret }
  const [status, setStatus] = useState(null);
  const [connected, setConnected] = useState(false);
  const [screen, setScreen] = useState("primary"); // primary | stage
  const [speechEnabled, setSpeechEnabled] = useState(true);
  const [rotationIndex, setRotationIndex] = useState(0);
  const [repeatMinutes, setRepeatMinutes] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const activeToolRef = useRef(null);
  const [pairInput, setPairInput] = useState("");
  const [pairError, setPairError] = useState("");
  const [pairing, setPairing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [cameraMod, setCameraMod] = useState(null);
  const lastSpokenByInstance = useRef(new Map());
  const deviceIdRef = useRef("");

  // 启动时读取已保存的配对信息
  useEffect(() => {
    (async () => {
      let deviceId = await storage.getItem("codestatus-device-id");
      if (!deviceId) {
        deviceId = randomId();
        await storage.setItem("codestatus-device-id", deviceId);
      }
      deviceIdRef.current = deviceId;
      const host = await storage.getItem("codestatus-host");
      const deviceSecret = await storage.getItem("codestatus-device-secret");
      if (host && deviceSecret) setAgent({ host, deviceId, deviceSecret });
      setRepeatMinutes(Number((await storage.getItem("codestatus-repeat")) || 0));
      setSpeechEnabled((await storage.getItem("codestatus-speech")) !== "false");
      setHydrated(true);
    })();
  }, []);

  // 实时连接
  useEffect(() => {
    if (!agent?.host || !agent?.deviceId || !agent?.deviceSecret) return undefined;
    let ws;
    let reconnectTimer;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(
        `ws://${agent.host}:${AGENT_PORT}/ws?deviceId=${encodeURIComponent(agent.deviceId)}&deviceSecret=${encodeURIComponent(agent.deviceSecret)}`
      );
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) reconnectTimer = setTimeout(connect, 1500);
      };
      ws.onerror = () => setConnected(false);
      ws.onmessage = (message) => {
        try {
          const payload = JSON.parse(message.data);
          if (payload.status) setStatus(payload.status);
        } catch {
          // 忽略坏帧
        }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [agent]);

  // 正在运行 / 已连接的工具，按稳定 key 排序，用于轮换
  const rotatingTools = useMemo(() => {
    return (status?.tools || [])
      .filter((tool) => !tool.isPlaceholder && tool.state !== "offline")
      .sort((a, b) => String(a.instanceId).localeCompare(String(b.instanceId)));
  }, [status]);

  // 每 4 秒自动轮换（一级页与常驻页都生效）
  useEffect(() => {
    if (rotatingTools.length <= 1) return undefined;
    const timer = setInterval(() => setRotationIndex((index) => index + 1), 4000);
    return () => clearInterval(timer);
  }, [rotatingTools.length]);

  const activeTool = useMemo(() => {
    if (!rotatingTools.length) return status?.tools?.[0] || null;
    const length = rotatingTools.length;
    const index = ((rotationIndex % length) + length) % length;
    return rotatingTools[index];
  }, [rotatingTools, rotationIndex, status]);

  activeToolRef.current = activeTool;

  // 语音播报新事件：每次状态切换都播报，按「状态+事件ID」去重防重复推送
  useEffect(() => {
    if (!speechEnabled) return;
    const event = status?.recentEvents?.[0];
    if (!event?.eventId) return;
    // 空闲/离线/暂停不播报
    if (event.state === "idle" || event.state === "offline" || event.state === "paused") return;
    const instance = event.instanceId || event.source || "task";
    const dedupKey = `${event.state}::${event.eventId}`;
    if (lastSpokenByInstance.current.get(instance) === dedupKey) return;
    lastSpokenByInstance.current.set(instance, dedupKey);
    Speech.speak(briefSpeech(event), { language: "zh-CN" });
  }, [status, speechEnabled]);

  // 定时自动复播当前状态（关 / 3 / 5 / 10 分钟）
  useEffect(() => {
    if (!speechEnabled || !repeatMinutes) return undefined;
    const timer = setInterval(() => {
      const tool = activeToolRef.current;
      if (tool) Speech.speak(briefSpeech(tool), { language: "zh-CN" });
    }, repeatMinutes * 60000);
    return () => clearInterval(timer);
  }, [speechEnabled, repeatMinutes]);

  function changeRepeat(minutes) {
    setRepeatMinutes(minutes);
    storage.setItem("codestatus-repeat", String(minutes));
  }

  function toggleSpeech() {
    setSpeechEnabled((v) => {
      const next = !v;
      storage.setItem("codestatus-speech", String(next));
      return next;
    });
  }

  function briefSpeech(item) {
    if (!item) return "当前没有连接到电脑端。";
    // 播报始终带软件名称，多软件同时运行时用于区分
    const name = item.sourceLabel || item.label || "任务";
    const project = item.projectName ? `${item.projectName}，` : "";
    return `${name}，${project}${STATE_LABELS[item.state] || item.state}`;
  }

  async function openScanner() {
    setPairError("");
    const mod = loadCamera();
    if (!mod) {
      setPairError("此设备不支持相机扫码（如鸿蒙手机），请用下方“粘贴地址连接”。");
      return;
    }
    try {
      const perm = await mod.requestCameraPermissionsAsync();
      if (!perm?.granted) {
        setPairError("未授予相机权限，请改用下方“粘贴地址连接”。");
        return;
      }
    } catch {
      setPairError("相机不可用，请改用下方“粘贴地址连接”。");
      return;
    }
    setCameraMod(mod);
    setScanning(true);
  }

  function onScan(event) {
    if (!scanning) return;
    setScanning(false);
    const data = event?.data || "";
    setPairInput(data);
    claimPairing(data);
  }

  async function claimPairing(raw) {
    setPairError("");
    const parsed = parseConnect(raw ?? pairInput);
    if (!parsed.host || !parsed.pairCode) {
      setPairError("无法识别地址，请粘贴电脑端「局域网配对」里的连接地址");
      return;
    }
    setPairing(true);
    try {
      const response = await fetch(`http://${parsed.host}:${AGENT_PORT}/api/pairing/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairCode: parsed.pairCode, deviceId: deviceIdRef.current, name: "Android 状态屏" })
      });
      if (!response.ok) {
        setPairError(response.status === 401 ? "配对码已过期，请在电脑端重新生成后再试" : `配对失败（${response.status}）`);
        return;
      }
      const body = await response.json();
      const deviceSecret = body?.device?.deviceSecret;
      if (!deviceSecret) {
        setPairError("电脑端未返回设备密钥，请重试");
        return;
      }
      await storage.setItem("codestatus-host", parsed.host);
      await storage.setItem("codestatus-device-secret", deviceSecret);
      setAgent({ host: parsed.host, deviceId: deviceIdRef.current, deviceSecret });
    } catch {
      setPairError("无法连接电脑端，请确认手机与电脑在同一 Wi-Fi");
    } finally {
      setPairing(false);
    }
  }

  async function resetPairing() {
    await storage.removeItem("codestatus-host");
    await storage.removeItem("codestatus-device-secret");
    setAgent(null);
    setStatus(null);
    setConnected(false);
  }

  function stepInstance(direction) {
    if (!rotatingTools.length) return;
    setRotationIndex((index) => index + (direction < 0 ? -1 : 1));
  }

  function focusInstance(instanceId) {
    const index = rotatingTools.findIndex((tool) => tool.instanceId === instanceId);
    if (index >= 0) setRotationIndex(index);
  }

  if (!hydrated) {
    return (
      <SafeAreaView style={[styles.root, styles.center]}>
        <StatusBar hidden />
        <ActivityIndicator color="#ff7a1a" />
      </SafeAreaView>
    );
  }

  // 扫码全屏（仅在相机模块成功加载后才挂载，避免不支持相机的系统崩溃）
  if (!agent && scanning && cameraMod) {
    const CameraView = cameraMod.CameraView;
    return (
      <SafeAreaView style={styles.scanRoot}>
        <StatusBar hidden />
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={onScan}
        />
        <View style={styles.scanFrame} />
        <Text style={styles.scanHint}>对准电脑端页面的二维码</Text>
        <TouchableOpacity style={styles.scanCancel} onPress={() => setScanning(false)}>
          <Text style={styles.scanCancelText}>取消</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // 配对界面：优先“粘贴地址连接”（任何系统都稳）；扫码作为安卓便捷选项
  if (!agent) {
    return (
      <SafeAreaView style={styles.pairRoot}>
        <StatusBar barStyle="light-content" />
        <ScrollView contentContainerStyle={styles.pairContent}>
          <Text style={styles.pairTitle}>连接电脑端</Text>
          <Text style={styles.pairHint}>
            在电脑端页面「局域网配对」复制连接地址（形如 http://192.168.x.x:5173?display=1&pair=XXXXX），粘贴到下面连接。
          </Text>
          <TextInput
            style={styles.pairInput}
            value={pairInput}
            onChangeText={setPairInput}
            placeholder="粘贴连接地址或配对码"
            placeholderTextColor="#8a5138"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {pairError ? <Text style={styles.pairError}>{pairError}</Text> : null}
          <TouchableOpacity style={styles.pairButton} onPress={() => claimPairing()} disabled={pairing}>
            <Text style={styles.pairButtonText}>{pairing ? "连接中…" : "连接"}</Text>
          </TouchableOpacity>
          <Text style={styles.pairOr}>或（安卓手机）用相机扫码</Text>
          <TouchableOpacity style={styles.pairSecondary} onPress={openScanner} disabled={pairing}>
            <Text style={styles.pairSecondaryText}>扫码连接</Text>
          </TouchableOpacity>
          <Text style={styles.pairNote}>鸿蒙手机建议直接用系统浏览器扫二维码打开副屏（零安装、不崩溃）。</Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // 二级界面：黑屏常驻展示
  if (screen === "stage") {
    return (
      <SafeAreaView style={styles.stageRoot}>
        <StatusBar hidden />
        <View style={styles.stageBody}>
          <Pressable style={styles.stagePet} onPress={() => setScreen("primary")}>
            <Pet tool={activeTool} large />
          </Pressable>
          <View style={styles.stageInfo}>
            <Text style={styles.stageLabel}>{activeTool?.label || "等待连接"}</Text>
            <Text style={styles.stageState}>{activeTool ? STATE_LABELS[activeTool.state] || activeTool.state : "未连接"}</Text>
            <Text style={styles.stageMessage}>{activeTool?.message || "电脑端暂无事件"}</Text>
            <View style={styles.stageList}>
              <Text style={styles.stageListTitle}>监听中 · {status?.activeCount || 0} 个活跃实例</Text>
              {(status?.tools || []).slice(0, 6).map((tool) => (
                <View style={styles.stageRow} key={tool.instanceId || tool.source}>
                  <Text style={styles.stageRowName} numberOfLines={1}>
                    {tool.label}
                  </Text>
                  <Text style={[styles.stageRowState, { backgroundColor: STATE_TONE[tool.state] || "#68757d" }]}>
                    {STATE_LABELS[tool.state] || tool.state}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        </View>
        <View style={styles.stageBar}>
          <BarButton label="◀" onPress={() => stepInstance(-1)} />
          <BarButton label={speechEnabled ? "语音开" : "语音关"} onPress={toggleSpeech} />
          <BarButton label="播报" onPress={() => activeTool && Speech.speak(briefSpeech(activeTool), { language: "zh-CN" })} />
          <BarButton label="返回" onPress={() => setScreen("primary")} />
          <BarButton label="▶" onPress={() => stepInstance(1)} />
        </View>
      </SafeAreaView>
    );
  }

  // 一级界面：内容与电脑端一致
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.primaryContent}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>CodeStatus</Text>
            <Text style={[styles.connDot, { color: connected ? "#176d50" : "#90622a" }]}>
              {connected ? "● 实时连接" : "○ 正在重连"}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <SmallButton label={speechEnabled ? "语音开" : "语音关"} onPress={toggleSpeech} />
            <SmallButton label="配对" onPress={resetPairing} />
          </View>
        </View>

        <Pressable style={styles.heroCard} onPress={() => setScreen("stage")}>
          <Pet tool={activeTool} />
          <View style={styles.heroCopy}>
            <Text style={styles.heroState}>{activeTool ? STATE_LABELS[activeTool.state] || activeTool.state : "等待连接"}</Text>
            <Text style={styles.heroMessage} numberOfLines={3}>
              {activeTool?.message || "扫码 / 配对电脑端后显示状态"}
            </Text>
            <Text style={styles.heroTap}>点击进入常驻展示页 →</Text>
          </View>
        </Pressable>

        <View style={styles.repeatRow}>
          <Text style={styles.repeatLabel}>自动复播</Text>
          {[0, 3, 5, 10].map((minutes) => (
            <TouchableOpacity
              key={minutes}
              style={[styles.chip, repeatMinutes === minutes && styles.chipActive]}
              onPress={() => changeRepeat(minutes)}
            >
              <Text style={[styles.chipText, repeatMinutes === minutes && styles.chipTextActive]}>
                {minutes === 0 ? "关" : `${minutes}分钟`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.sectionTitle}>监控源</Text>
        <View style={styles.toolList}>
          {(status?.tools || []).map((tool) => (
            <TouchableOpacity
              key={tool.instanceId || tool.source}
              style={[styles.toolRow, tool.instanceId === activeTool?.instanceId && styles.toolRowActive]}
              onPress={() => focusInstance(tool.instanceId)}
            >
              <View style={[styles.toolDot, { backgroundColor: STATE_TONE[tool.state] || "#68757d" }]} />
              <View style={styles.toolCopy}>
                <Text style={styles.toolName} numberOfLines={1}>
                  {tool.label}
                </Text>
                <Text style={styles.toolMessage} numberOfLines={1}>
                  {tool.message}
                </Text>
              </View>
              <Text style={styles.toolState}>{STATE_LABELS[tool.state] || tool.state}</Text>
            </TouchableOpacity>
          ))}
          {!(status?.tools || []).length ? <Text style={styles.empty}>暂无监控源</Text> : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function parseConnect(input) {
  const text = String(input || "").trim();
  let host = "";
  let pairCode = "";
  const hostMatch = text.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  if (hostMatch) host = hostMatch[1];
  const pairMatch = text.match(/[?&]pair=([^&\s]+)/i);
  if (pairMatch) {
    pairCode = decodeURIComponent(pairMatch[1]);
  } else if (!/[?:/]/.test(text)) {
    // 纯配对码
    pairCode = text;
  }
  return { host, pairCode };
}

function Pet({ tool, large }) {
  const state = tool?.state || "offline";
  const tone = STATE_TONE[state] || "#68757d";
  const size = large ? 1.4 : 1;
  return (
    <View style={[styles.pet, { transform: [{ scale: size }] }]}>
      <View style={styles.petHead}>
        <View style={styles.petEye} />
        <View style={[styles.petEye, { marginLeft: 18 }]} />
      </View>
      <View style={[styles.petBody, { backgroundColor: tone }]} />
      <View style={[styles.petBadge, { backgroundColor: tone }]}>
        <Text style={styles.petBadgeText} numberOfLines={1}>
          {(STATE_LABELS[state] || state).replace("正在", "")}
        </Text>
      </View>
    </View>
  );
}

function SmallButton({ label, onPress }) {
  return (
    <TouchableOpacity style={styles.smallButton} onPress={onPress}>
      <Text style={styles.smallButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

function BarButton({ label, onPress }) {
  return (
    <TouchableOpacity style={styles.barButton} onPress={onPress}>
      <Text style={styles.barButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#eef2f0" },
  center: { alignItems: "center", justifyContent: "center" },

  // 配对
  pairRoot: { flex: 1, backgroundColor: "#1a0f08" },
  pairContent: { padding: 28, paddingTop: 64, gap: 16 },
  pairTitle: { color: "#fff7ee", fontSize: 30, fontWeight: "900" },
  pairHint: { color: "#ffd5b2", fontSize: 14, lineHeight: 22 },
  pairInput: {
    minHeight: 52,
    paddingHorizontal: 14,
    color: "#fff7ee",
    backgroundColor: "#2a1709",
    borderWidth: 1,
    borderColor: "#56331a",
    borderRadius: 12,
    fontSize: 15
  },
  pairError: { color: "#ffae9c", fontSize: 13 },
  pairButton: { marginTop: 8, paddingVertical: 16, alignItems: "center", backgroundColor: "#ffd56a", borderRadius: 12 },
  pairButtonText: { color: "#2a1209", fontSize: 17, fontWeight: "900" },
  pairOr: { color: "#8a5138", fontSize: 13, textAlign: "center", marginTop: 6 },
  pairSecondary: { paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: "#56331a", borderRadius: 12 },
  pairSecondaryText: { color: "#ffb46d", fontSize: 14, fontWeight: "800" },
  pairNote: { color: "#8a5138", fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: 4 },

  // 扫码
  scanRoot: { flex: 1, backgroundColor: "#000000", alignItems: "center", justifyContent: "center" },
  scanFrame: { position: "absolute", width: 240, height: 240, borderWidth: 3, borderColor: "#ffd56a", borderRadius: 18 },
  scanHint: { position: "absolute", bottom: 120, color: "#fff7ee", fontSize: 16, fontWeight: "700" },
  scanCancel: { position: "absolute", bottom: 56, paddingVertical: 12, paddingHorizontal: 30, backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 12, borderWidth: 1, borderColor: "#56331a" },
  scanCancelText: { color: "#ffdcbf", fontSize: 15, fontWeight: "800" },

  // 一级界面
  primaryContent: { padding: 18, gap: 14 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  brand: { color: "#182026", fontSize: 22, fontWeight: "900" },
  connDot: { fontSize: 13, fontWeight: "700", marginTop: 2 },
  headerActions: { flexDirection: "row", gap: 8 },
  smallButton: { paddingVertical: 8, paddingHorizontal: 12, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d7dfdd", borderRadius: 10 },
  smallButtonText: { color: "#4f5b63", fontSize: 13, fontWeight: "700" },

  heroCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
    padding: 20,
    backgroundColor: "#fff0df",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#e6d2bd"
  },
  heroCopy: { flex: 1, gap: 6 },
  heroState: { color: "#241713", fontSize: 30, fontWeight: "900" },
  heroMessage: { color: "#5b3122", fontSize: 14, lineHeight: 21 },
  heroTap: { color: "#b64b1d", fontSize: 12, fontWeight: "800", marginTop: 4 },

  repeatRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  repeatLabel: { color: "#69757f", fontSize: 13, marginRight: 4 },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: "#d7dfdd", backgroundColor: "#ffffff" },
  chipActive: { borderColor: "#1a716c", backgroundColor: "#1c746d" },
  chipText: { color: "#4f5b63", fontSize: 13, fontWeight: "700" },
  chipTextActive: { color: "#ffffff" },

  sectionTitle: { color: "#182026", fontSize: 16, fontWeight: "800", marginTop: 4 },
  toolList: { gap: 10 },
  toolRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    backgroundColor: "#ffffff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#dce4e2"
  },
  toolRowActive: { borderColor: "#1c746d" },
  toolDot: { width: 12, height: 12, borderRadius: 6 },
  toolCopy: { flex: 1, minWidth: 0 },
  toolName: { color: "#182026", fontSize: 14, fontWeight: "700" },
  toolMessage: { color: "#69757f", fontSize: 12, marginTop: 2 },
  toolState: { color: "#4e5961", fontSize: 12, fontWeight: "700" },
  empty: { color: "#69757f", fontSize: 13, textAlign: "center", paddingVertical: 20 },

  // 二级界面
  stageRoot: { flex: 1, backgroundColor: "#000000" },
  stageBody: { flex: 1, flexDirection: "row", alignItems: "center", padding: 24, gap: 24 },
  stagePet: { alignItems: "center", justifyContent: "center" },
  stageInfo: { flex: 1, gap: 10 },
  stageLabel: { color: "#ffb46d", fontSize: 16, fontWeight: "800" },
  stageState: { color: "#fff7ee", fontSize: 48, fontWeight: "900" },
  stageMessage: { color: "#ffd5b2", fontSize: 16, lineHeight: 24 },
  stageList: { marginTop: 10, gap: 8 },
  stageListTitle: { color: "#ffb46d", fontSize: 13, fontWeight: "900" },
  stageRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  stageRowName: { color: "#fff5eb", fontSize: 14, fontWeight: "700", flex: 1 },
  stageRowState: { color: "#0c0c0c", fontSize: 12, fontWeight: "800", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, overflow: "hidden" },
  stageBar: { flexDirection: "row", justifyContent: "center", gap: 10, paddingVertical: 12 },
  barButton: { paddingVertical: 8, paddingHorizontal: 14, backgroundColor: "#2c160c", borderRadius: 10, borderWidth: 1, borderColor: "#56331a" },
  barButtonText: { color: "#ffdcbf", fontSize: 13, fontWeight: "800" },

  // 像素小人
  pet: { width: 92, height: 120, alignItems: "center" },
  petHead: { flexDirection: "row", width: 56, height: 48, backgroundColor: "#ffe4c8", borderWidth: 4, borderColor: "#202a31", alignItems: "center", justifyContent: "center", paddingTop: 14 },
  petEye: { width: 8, height: 12, backgroundColor: "#171f25" },
  petBody: { width: 72, height: 44, borderWidth: 4, borderColor: "#202a31", marginTop: -2 },
  petBadge: { marginTop: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 3, borderColor: "#202a31", maxWidth: 88 },
  petBadgeText: { color: "#0c0c0c", fontSize: 11, fontWeight: "900" }
});
