#!/usr/bin/env node
// 一次性诊断：验证 OpenCode 进程树「工作子进程」检测机制
// 运行：node scripts/diag-opencode.mjs
import { execFile } from "node:child_process";

const PS = `$ErrorActionPreference='SilentlyContinue'
$procs = Get-CimInstance Win32_Process -Property Name,ProcessId,ParentProcessId,ExecutablePath,CommandLine | Where-Object { $_.ExecutablePath -or $_.CommandLine } | ForEach-Object { [PSCustomObject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; path=$_.ExecutablePath; cmd=$_.CommandLine } }
$procs | ConvertTo-Json -Compress -Depth 3`;

const out = await new Promise((res, rej) =>
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 20000 }, (e, s) => (e ? rej(e) : res(s)))
);
const procs = JSON.parse(out.trim() || "[]");
const arr = Array.isArray(procs) ? procs : [procs];

const oc = arr.filter((p) => p.name === "OpenCode.exe");
console.log(`OpenCode.exe 进程数：${oc.length}`);
if (oc.length === 0) { console.log("OpenCode 未运行，无法诊断。"); process.exit(0); }

oc.forEach((p) => {
  const cmd = String(p.cmd || "").slice(0, 70);
  const tag = /node\.mojom\.NodeService/.test(p.cmd || "") ? "  <== NodeService(sidecar)" : /--type=renderer/.test(p.cmd || "") ? "  <== renderer" : /--type=gpu/.test(p.cmd || "") ? "  <== gpu" : "";
  console.log(`  pid=${p.pid} ppid=${p.ppid} ${cmd}${tag}`);
});

// 建树（浏览器作边界，不纳入、不展开）
const BROWSER = /^(chrome|msedge|firefox|brave|vivaldi|opera|arc|software_reporter_tool)\.exe$/i;
const roots = new Set(oc.map((p) => p.pid));
const tree = new Set(roots);
let ch = true;
while (ch) {
  ch = false;
  for (const p of arr) {
    if (tree.has(p.pid) || BROWSER.test(p.name)) continue;
    if (p.ppid && tree.has(p.ppid)) { tree.add(p.pid); ch = true; }
  }
}
console.log(`\nOpenCode 进程树总进程数（含子孙，已剪除浏览器）：${tree.size}`);
console.log("子孙进程（非 OpenCode.exe 自身）：");
let any = false;
for (const p of arr) {
  if (tree.has(p.pid) && !roots.has(p.pid)) {
    any = true;
    const cmd = String(p.cmd || "").slice(0, 80);
    console.log(`  pid=${p.pid} ppid=${p.ppid} name=${p.name}  ${cmd}`);
  }
}
if (!any) console.log("  （当前无子进程——OpenCode 静止，没跑命令）");

// MCP 子链标记（向下传染）
const MCP = /mcp|mcp-server|@playwright|playwright|browser.?tools/i;
const WORK = /^(git|cmd|bash|sh|node|python|pythonw|powershell|pwsh|npx|npm|yarn|pnpm|cargo|go|make|gcc|g\+\+|cl|dotnet|ruby|java|rustc|tsc|eslint|prettier|jest|vitest|pytest)\.?(exe)?$/i;
const mcpPids = new Set();
for (const p of arr) if (tree.has(p.pid) && MCP.test(p.cmd || "")) mcpPids.add(p.pid);
let ch2 = true;
while (ch2) {
  ch2 = false;
  for (const p of arr) {
    if (!tree.has(p.pid) || mcpPids.has(p.pid)) continue;
    if (p.ppid && mcpPids.has(p.ppid)) { mcpPids.add(p.pid); ch2 = true; }
  }
}
console.log(`\n被识别为 MCP 子链（忽略）的进程数：${mcpPids.size}`);
let child = null;
for (const p of arr) {
  if (tree.has(p.pid) && !roots.has(p.pid) && !mcpPids.has(p.pid) && WORK.test(p.name)) { child = p; break; }
}
console.log(`\n判定结果：${child ? `🟢 running_command（${child.name}）` : "⚪ idle/前台/生成中（无工作子进程）"}`);
if (child) {
  const m = String(child.cmd || "").match(/\/c\s+"([^"]+)"/);
  const sc = m ? m[1].split(/\s+/)[0] : String(child.cmd || "").split(/\s+/)[0];
  console.log(`  正在跑：${child.name} ${sc}`);
}
