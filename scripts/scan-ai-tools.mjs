#!/usr/bin/env node
// CodeStatus — AI 工具自动发现
//
// 四源扫描本机已安装的 AI 工具：注册表 / 编辑器扩展目录 / 开始菜单·桌面快捷方式 / 监听端口。
// 对照指纹库(config/fingerprints.json)分成三类：
//   ① 已纳入监控（命中指纹库）② 已由其他 adapter 覆盖（VSCode/Cursor/Claude Code/Codex）
//   ③ 未纳入（指纹库没有，建议确认是否要加一条指纹）。
//
// 用法：
//   node scan-ai-tools.mjs            仅打印报告
//   node scan-ai-tools.mjs --report   打印 + 上报发现汇总到 CodeStatus Agent
// 采集器启动时会自动以 --report 跑一次。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "config", "fingerprints.json");
const APPDATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "CodeStatus");
const ID_PATH = path.join(APPDATA_DIR, "collector-id.json");

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const fps = config.fingerprints.filter((f) => f.enabled !== false);

// 已由其他 adapter（VSCode 扩展 / Claude Code / Codex hook）覆盖，发现到不重复纳入
const COVERED = [
  { label: "VS Code / 其内 AI 扩展（已有扩展采集）", kw: ["visual studio code", "vscode"] },
  { label: "Cursor（复用 VSCode 扩展）", kw: ["cursor"] },
  { label: "Claude Code（已有 hook）", kw: ["claude"] },
  { label: "Codex / ChatGPT（已有 hook）", kw: ["codex", "chatgpt"] },
];

const AI_KW = "Cursor|Windsurf|Codeium|Trae|Zed|Void|PearAI|Pear|JetBrains|PyCharm|WebStorm|IntelliJ|GoLand|RustRover|CLion|PhpStorm|OpenCode|Kimi|AutoGLM|Claude|Codex|Copilot|Cline|Roo|Aider|Continue|CodeGeeX|GLM|MiniMax|ComfyUI|Comfy|Ollama|LM Studio|Stable Diffusion|Automatic1111|A1111|Forge|Pieces|Zhipu|Moonshot|Anthropic";
const EXT_KW = "claude-dev|cline|roo-cline|continue|copilot|kimi|moonshot|minimax|glm|zhipu|codegeex|aider|pearai|windsurf";
const PORTS = "11434,8188,8909,7860,1234,3000,8080,9999,5380";

const PS_SCAN = `$ErrorActionPreference='SilentlyContinue'
$kw='${AI_KW}'
$reg=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -match $kw } | Select-Object -ExpandProperty DisplayName
$ext=@()
foreach($b in @("$env:USERPROFILE\\.vscode\\extensions","$env:USERPROFILE\\.cursor\\extensions","$env:USERPROFILE\\.windsurf\\extensions","$env:USERPROFILE\\.trae\\extensions")){ if(Test-Path $b){ $ext += @((Get-ChildItem $b -Directory | Where-Object { $_.Name -match '${EXT_KW}' } | Select-Object -ExpandProperty Name)) } }
$lnk=Get-ChildItem "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs","$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs","$env:USERPROFILE\\Desktop","$env:PUBLIC\\Desktop" -Recurse -Filter *.lnk | Where-Object { $_.BaseName -match $kw } | Select-Object -ExpandProperty BaseName
$ports=Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in ${PORTS} } | Select-Object -ExpandProperty LocalPort -Unique
[PSCustomObject]@{ registry=$reg; extensions=$ext; shortcuts=$lnk; ports=$ports } | ConvertTo-Json -Compress -Depth 5`;

function runScan() {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PS_SCAN],
      { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30000 },
      (err, out) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(out.trim() || "{}"));
        } catch (e) {
          reject(new Error("解析扫描输出失败：" + e.message));
        }
      }
    );
  });
}

function norm(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

export async function discover() {
  const raw = await runScan();
  const names = new Set();
  [...norm(raw.registry), ...norm(raw.shortcuts), ...norm(raw.extensions)].forEach((n) => {
    const s = String(n).trim();
    if (s) names.add(s);
  });
  const foundPorts = norm(raw.ports).map((p) => Number(p));

  const matched = [];
  for (const fp of fps) {
    const hay = [fp.label, fp.source, ...(fp.windowKeywords || []), ...(fp.pathKeywords || [])]
      .map((s) => String(s || "").toLowerCase())
      .filter(Boolean);
    const ev = [];
    for (const n of names) {
      const nl = n.toLowerCase();
      if (hay.some((h) => nl.includes(h) || h.includes(nl))) ev.push(n);
    }
    if (fp.httpProbe) {
      const port = Number(new URL(fp.httpProbe.baseUrl).port);
      if (foundPorts.includes(port)) ev.push(`监听端口 ${port}`);
    }
    if (ev.length) matched.push({ source: fp.source, label: fp.label, evidence: [...new Set(ev)].slice(0, 4) });
  }

  const matchedNames = new Set(
    matched.flatMap((m) => m.evidence.map((e) => e.toLowerCase()))
  );
  const covered = [];
  const unmatched = [];
  for (const n of names) {
    const nl = n.toLowerCase();
    if (matchedNames.has(nl)) continue;
    const cov = COVERED.find((c) => c.kw.some((k) => nl.includes(k)));
    if (cov) covered.push({ name: n, by: cov.label });
    else unmatched.push({ name: n });
  }
  return { matched, covered, unmatched, ports: foundPorts };
}

function machineId() {
  try {
    if (fs.existsSync(ID_PATH)) return JSON.parse(fs.readFileSync(ID_PATH, "utf8")).id;
  } catch {
    /* ignore */
  }
  return crypto.randomUUID();
}

export async function reportDiscovery(r) {
  const mid = machineId();
  const post = (ev) =>
    fetch(config.agentUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(2500),
    }).catch(() => {});

  for (const m of r.matched) {
    await post({
      source: m.source,
      instanceId: `${m.source}::${mid}`,
      sourceLabel: m.label,
      label: m.label,
      state: "idle",
      confidence: 0.4,
      summary: `已发现 ${m.label}`,
      detail: `证据：${m.evidence.join("；")}`,
      severity: "info",
      raw: { discovered: true, evidence: m.evidence },
    });
  }

  const names = r.matched.map((m) => m.label);
  await post({
    source: "_discovery",
    instanceId: `_discovery::${mid}`,
    sourceLabel: "发现",
    label: "新工具发现",
    state: "idle",
    confidence: 0.5,
    summary: `发现 ${r.matched.length} 个已纳入监控${r.unmatched.length ? `，另 ${r.unmatched.length} 个待确认` : ""}`,
    detail: [...names, ...r.unmatched.map((u) => `未纳入：${u.name}`)].join("、") || "无",
    severity: "info",
    raw: { matched: names, unmatched: r.unmatched.map((u) => u.name) },
  });
}

function printReport(r) {
  console.log("\n=== CodeStatus AI 工具扫描 ===");
  console.log(`\n✅ 已纳入监控（${r.matched.length}）：`);
  r.matched.forEach((m) => console.log(`   • ${m.label.padEnd(16)} 证据：${m.evidence.join("；")}`));
  if (r.covered.length) {
    console.log(`\n✔️  已由其他 adapter 覆盖（${r.covered.length}）：`);
    r.covered.forEach((c) => console.log(`   • ${c.name}  →  ${c.by}`));
  }
  if (r.unmatched.length) {
    console.log(`\n❓ 未纳入（${r.unmatched.length}，可在 config/fingerprints.json 加一条指纹）：`);
    r.unmatched.forEach((u) => console.log(`   • ${u.name}`));
  }
  if (r.ports.length) console.log(`\n🔌 监听端口：${r.ports.join(", ")}`);
  console.log("");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  (async () => {
    console.log("扫描本机已安装的 AI 工具…");
    const r = await discover();
    printReport(r);
    if (process.argv.includes("--report")) {
      try {
        await reportDiscovery(r);
        console.log("已上报发现汇总到 CodeStatus Agent。");
      } catch (e) {
        console.log("上报失败（Agent 未运行？）：" + e.message);
      }
    }
  })().catch((e) => {
    console.error("扫描出错：" + e.message);
    process.exit(1);
  });
}
