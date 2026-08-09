#!/usr/bin/env node
// 单测：验证 evalEnhanced 的「进程树工作子进程」判定逻辑（逐字镜像 desktop-collector.mjs 中的实现）
// 用合成进程表跑正反例，证明 running_command 在真实跑命令时能触发、噪声不会误触发。
// 运行：node scripts/test-eval-enhanced.mjs

// ---- 镜像生产代码的判定核心（evalEnhanced 的树构建 + 过滤 + 判定） ----
function decide(fp, procs, fg, st) {
  const BROWSER = /^(chrome|msedge|firefox|brave|vivaldi|opera|arc|software_reporter_tool)\.exe$/i;
  const rootPids = new Set();
  for (const p of procs) if (fp.match(p)) rootPids.add(p.pid);
  const tree = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of procs) {
      if (tree.has(p.pid) || BROWSER.test(p.name)) continue;
      if (p.ppid && tree.has(p.ppid)) { tree.add(p.pid); changed = true; }
    }
  }
  const MCP = /mcp|modelcontextprotocol|@playwright|playwright|browser.?tools/i;
  const WORK = /^(git|cmd|bash|sh|node|python|pythonw|powershell|pwsh|npx|npm|yarn|pnpm|cargo|go|make|gcc|g\+\+|cl|dotnet|ruby|java|rustc|tsc|eslint|prettier|jest|vitest|pytest)\.?(exe)?$/i;
  const mcpPids = new Set();
  for (const p of procs) if (tree.has(p.pid) && MCP.test(p.cmd || "")) mcpPids.add(p.pid);
  let ch2 = true;
  while (ch2) {
    ch2 = false;
    for (const p of procs) {
      if (!tree.has(p.pid) || mcpPids.has(p.pid)) continue;
      if (p.ppid && mcpPids.has(p.ppid)) { mcpPids.add(p.pid); ch2 = true; }
    }
  }
  let child = null;
  for (const p of procs) {
    if (tree.has(p.pid) && !rootPids.has(p.pid) && !mcpPids.has(p.pid) && WORK.test(p.name)) { child = p; break; }
  }
  if (child) return { state: "running_command", who: child.name };
  if (st.cpuPct > 15) return { state: "using_tool(生成)" };
  if (fg.pid && tree.has(fg.pid)) return { state: "using_tool(前台)" };
  return { state: "idle" };
}

const FP = { match: (p) => p.name === "OpenCode.exe" };

let pass = 0, fail = 0;
function check(name, procs, fg, st, expect) {
  const r = decide(FP, procs, fg, st);
  const ok = r.state === expect;
  const tail = r.who ? ` (${r.who})` : "";
  const note = ok ? "" : `  [期望 ${expect}]`;
  console.log(`  ${ok ? "✅" : "❌"} ${name} -> ${r.state}${tail}${note}`);
  if (ok) pass++; else fail++;
}

const P = (pid, ppid, name, cmd = "") => ({ pid, ppid, name, cmd });

console.log("=== evalEnhanced 单测 ===\n");

// 1. 正例：sidecar 下挂一个真实 git 子进程 → running_command
check("sidecar 下跑 git",
  [P(1,0,"OpenCode.exe"), P(2,1,"OpenCode.exe","--utility-sub-type=node.mojom.NodeService"), P(3,2,"git.exe","fetch")],
  {pid:0}, {cpuPct:0}, "running_command");

// 2. 正例：cmd.exe 跑 npm test（非 MCP）→ running_command
check("sidecar 下 cmd 跑 npm test",
  [P(1,0,"OpenCode.exe"), P(2,1,"OpenCode.exe","node.mojom.NodeService"), P(3,2,"cmd.exe",'cmd /c "npm test"')],
  {pid:0}, {cpuPct:0}, "running_command");

// 3. 反例：playwright-mcp 整条子链（cmd→node→cmd→node）→ idle（全被 MCP 标记）
check("playwright-mcp 子链（应忽略）",
  [P(1,0,"OpenCode.exe"), P(2,1,"OpenCode.exe","node.mojom.NodeService"),
   P(3,2,"cmd.exe","npx @playwright/mcp@latest"), P(4,3,"node.exe","npm/cli.js"),
   P(5,4,"cmd.exe","playwright-mcp --browser msedge"), P(6,5,"node.exe","server.js")],
  {pid:0}, {cpuPct:0}, "idle");

// 4. 反例：浏览器子树（chrome + codex 插件 extension-host 的 cmd）→ idle（剪除）
check("浏览器子树含 codex 插件 cmd（应剪除）",
  [P(1,0,"OpenCode.exe"), P(7,1,"chrome.exe","--restore-last-session"),
   P(8,7,"cmd.exe",'"codex/plugins/cache/openai-bundled/extension-host"')],
  {pid:0}, {cpuPct:0}, "idle");

// 5. 反例：只有 OpenCode 自身，无子进程 → idle
check("静止（无子进程）",
  [P(1,0,"OpenCode.exe"), P(2,1,"OpenCode.exe","--type=renderer")],
  {pid:0}, {cpuPct:0}, "idle");

// 6. 正例：node.exe 跑业务脚本（非 MCP）→ running_command
check("sidecar 下 node 跑业务脚本",
  [P(1,0,"OpenCode.exe"), P(2,1,"OpenCode.exe","node.mojom.NodeService"), P(3,2,"node.exe","build.js")],
  {pid:0}, {cpuPct:0}, "running_command");

// 7. 边界：MCP 的 cmd 但子进程是非 MCP 工作进程（MCP 子链传染）→ idle
check("MCP cmd 下挂的 node（传染忽略）",
  [P(1,0,"OpenCode.exe"), P(2,1,"OpenCode.exe","node.mojom.NodeService"),
   P(3,2,"cmd.exe","/c npx @modelcontextprotocol/server-git"), P(4,3,"node.exe","server.js")],
  {pid:0}, {cpuPct:0}, "idle");

// 8. 前台：无工作子进程，OpenCode 在前台 → using_tool(前台)
check("前台（fg 命中 renderer）",
  [P(1,0,"OpenCode.exe"), P(2,1,"OpenCode.exe","--type=renderer")],
  {pid:2}, {cpuPct:0}, "using_tool(前台)");

// 9. 生成中：无子进程但 sidecar CPU 高 → using_tool(生成)
check("生成中（CPU 高）",
  [P(1,0,"OpenCode.exe"), P(2,1,"OpenCode.exe","node.mojom.NodeService")],
  {pid:0}, {cpuPct:42}, "using_tool(生成)");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
