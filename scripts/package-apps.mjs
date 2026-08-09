import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// 把成品文件组织到 APP/ 文件夹：
//   APP/电脑端监控/CodeStatus-Monitor.exe   双击即运行（内嵌 Node + 网页，免安装）
//   APP/安卓App/CodeStatus.apk              安卓安装包
//   APP/鸿蒙App/                            鸿蒙工程（需 DevEco 构建 .hap）
//
// 用法：node scripts/package-apps.mjs
//   - 默认会调用 build-desktop-exe.mjs 重新构建 exe；加 --skip-exe 跳过（复用已构建的 exe）。
const root = process.cwd();
const appDir = path.join(root, "APP");
const desktopDir = path.join(appDir, "电脑端监控");
const androidDir = path.join(appDir, "安卓App");
const harmonyDir = path.join(appDir, "鸿蒙App");
const skipExe = process.argv.includes("--skip-exe");
const CR = "\r\n";

fs.mkdirSync(appDir, { recursive: true });

// ---------------- 电脑端监控（单文件 exe）----------------
if (!skipExe) {
  console.log("== 构建电脑端 exe ==");
  run(process.execPath, [path.join(root, "scripts", "build-desktop-exe.mjs")]);
}
fs.mkdirSync(desktopDir, { recursive: true });

// 附带：VS Code 扩展 + hooks 安装脚本（接入各 Coding 工具用）
copyDir(path.join(root, "extensions"), path.join(desktopDir, "extensions"));
copyDir(path.join(root, "scripts", "install-claude-code-hooks.mjs"), path.join(desktopDir, "scripts", "install-claude-code-hooks.mjs"));
copyDir(path.join(root, "scripts", "install-codex-hooks.mjs"), path.join(desktopDir, "scripts", "install-codex-hooks.mjs"));
copyDir(path.join(root, "adapters"), path.join(desktopDir, "adapters"));

// 通用 AI 工具监控采集器：指纹库 + 自动发现 + 诊断/单测 + 启动/安装脚本
copyDir(path.join(root, "config"), path.join(desktopDir, "config"));
copyDir(path.join(root, "scripts", "scan-ai-tools.mjs"), path.join(desktopDir, "scripts", "scan-ai-tools.mjs"));
copyDir(path.join(root, "scripts", "diag-opencode.mjs"), path.join(desktopDir, "scripts", "diag-opencode.mjs"));
copyDir(path.join(root, "scripts", "test-eval-enhanced.mjs"), path.join(desktopDir, "scripts", "test-eval-enhanced.mjs"));
copyDir(path.join(root, "scripts", "启动AI工具监控.cmd"), path.join(desktopDir, "启动AI工具监控.cmd"));
copyDir(path.join(root, "scripts", "安装AI工具监控.cmd"), path.join(desktopDir, "安装AI工具监控.cmd"));

writeFile(path.join(desktopDir, "安装VSCode扩展.cmd"), [
  "@echo off",
  "chcp 65001 >nul",
  "set DEST=%USERPROFILE%\\.vscode\\extensions\\codestatus-companion-0.1.0",
  'echo 安装 VS Code 扩展到 %DEST%',
  'if exist "%DEST%" rmdir /s /q "%DEST%"',
  'xcopy /e /i /y "%~dp0extensions\\vscode" "%DEST%" >nul',
  "echo 完成。请重启 VS Code / Cursor。Cursor 用户把上面的 .vscode 改成 .cursor。",
  "pause"
].join(CR));
writeFile(path.join(desktopDir, "安装ClaudeCode监控.cmd"), [
  "@echo off",
  "chcp 65001 >nul",
  "cd /d %~dp0",
  "node scripts/install-claude-code-hooks.mjs",
  "pause"
].join(CR));
writeFile(path.join(desktopDir, "安装Codex监控.cmd"), [
  "@echo off",
  "chcp 65001 >nul",
  "cd /d %~dp0",
  "node scripts/install-codex-hooks.mjs",
  "echo 还需在 Codex 里 /hooks 信任 CodeStatus hook。",
  "pause"
].join(CR));
// 一键放行 Windows 防火墙（手机连不上多半是这个）。自动以管理员身份重启。
writeFile(path.join(desktopDir, "允许防火墙.cmd"), [
  "@echo off",
  "chcp 65001 >nul",
  "net session >nul 2>&1",
  "if %errorlevel% neq 0 (",
  "  echo 需要管理员权限，正在重新以管理员身份运行...",
  "  powershell -Command \"Start-Process '%~f0' -Verb RunAs\"",
  "  exit /b",
  ")",
  "echo 正在放行 CodeStatus 端口 4317 / 5173 / 4318 ...",
  "netsh advfirewall firewall delete rule name=\"CodeStatus\" >nul 2>&1",
  "netsh advfirewall firewall add rule name=\"CodeStatus\" dir=in action=allow protocol=TCP localport=4317,5173,4318",
  "echo 完成。现在手机应能连上电脑端了。",
  "pause"
].join(CR));

// ---------------- 安卓 ----------------
resetDir(androidDir);
const apk = findApk();
if (apk) {
  fs.copyFileSync(apk, path.join(androidDir, "CodeStatus.apk"));
  console.log(`== 已放入 APK: ${apk}`);
} else {
  console.log("== 未找到已构建的 APK（先运行安卓构建）");
}
writeFile(path.join(androidDir, "安装说明.txt"), [
  "CodeStatus 安卓手机端",
  "",
  "把 CodeStatus.apk 传到安卓手机安装（需允许“未知来源”应用）。",
  "打开 App → 扫码连接 → 对准电脑端页面「局域网配对」二维码即可。",
  "手机需与电脑同一 Wi-Fi。"
].join(CR), "utf8");

// ---------------- 鸿蒙 ----------------
resetDir(harmonyDir);
copyDir(path.join(root, "apps", "harmony"), path.join(harmonyDir, "鸿蒙工程"));
copyIfExists(path.join(root, "apps", "harmony", "README.md"), path.join(harmonyDir, "构建说明.md"));

// ---------------- 顶层说明 ----------------
writeFile(path.join(appDir, "使用说明.md"), [
  "# CodeStatus 成品包",
  "",
  "| 平台 | 文件 | 用法 |",
  "| --- | --- | --- |",
  "| 电脑 | `电脑端监控/CodeStatus-Monitor.exe` | 双击运行（免装 Node，自动开浏览器）|",
  "| 安卓 | `安卓App/CodeStatus.apk` | 传到手机安装 |",
  "| 鸿蒙 | `鸿蒙App/鸿蒙工程/` | 需 DevEco Studio 构建 .hap（本机无法直接产出）|",
  "",
  "## 连接（很快）",
  "1. 电脑双击 exe，页面「局域网配对」显示二维码。",
  "2. 手机装好 App → 「扫码连接」→ 对准二维码，几秒连上。",
  "3. 鸿蒙手机也可直接用浏览器扫码打开副屏（零安装）。",
  "",
  "## 接入被监控的 Coding 工具（电脑端）",
  "- VS Code / Cursor / Kimi Code / MiniMax Code / GLM Code：双击 `电脑端监控/安装VSCode扩展.cmd`。",
  "- Claude Code / Codex：双击对应 `安装*.cmd`（需本机已装 Node）。",
  "",
  "## 接入更多 AI 工具（通用监控，桌面端）",
  "",
  "除了上面的「专用 adapter」，还有一个**通用监控采集器**，能自动监控一大批 AI 工具，装了哪个就监控哪个，无需逐个写代码。",
  "",
  "**一键安装（推荐）**：双击 `电脑端监控/安装AI工具监控.cmd` —— 会设开机自启并立即启动。",
  "",
  "**手动启动**：双击 `电脑端监控/启动AI工具监控.cmd`。后台最小化运行，日志在 `电脑端监控/data/collector.log`。",
  "",
  "### 能监控哪些",
  "",
  "| 类型 | 工具 | 信号精度 |",
  "| --- | --- | --- |",
  "| 本地出图/推理服务 | **ComfyUI**（出图中/队列/完成/报错）、**Ollama**（加载模型/正在推理）、LM Studio、SD WebUI | 准（HTTP API） |",
  "| 桌面 AI 应用 | **OpenCode**、**Kimi 桌面版**、**AutoGLM**、**Pieces** | 弱（在线/前台/在忙） |",
  "| JetBrains 全家桶 | PyCharm、WebStorm、IntelliJ、GoLand、RustRover、CLion、PhpStorm | 弱 |",
  "| AI IDE fork | Windsurf、Trae、Zed、Void、PearAI | 弱 |",
  "",
  "> 「弱信号」只能判断工具**开着 / 窗口在前台 / CPU 占用高（在忙）**，做不到像 Claude Code 那样精确到「正在改哪个文件」。这是这些应用本身不开放内部状态导致的。",
  "",
  "### 改端口 / 开关某个工具",
  "",
  "编辑 `电脑端监控/config/fingerprints.json`：",
  "",
  "- ComfyUI 秋叶整合包默认端口写在 `8909`，如果你用的是标准版改成 `8188`；找到 `comfyui` 那条的 `httpProbe.baseUrl`。",
  "- Ollama 默认 `11434`。",
  "- 不想监控某工具：把它那条的 `\"enabled\": true` 改成 `false`。",
  "- 改完**重启**「启动AI工具监控.cmd」生效。",
  "",
  "### 加一个新工具（指纹库可扩展）",
  "",
  "在 `fingerprints.json` 的 `fingerprints` 数组里照格式加一条，关键填进程名和窗口标题关键词即可：",
  "",
  "```json",
  "{",
  "  \"source\": \"my-tool\",",
  "  \"label\": \"我的工具\",",
  "  \"type\": \"desktop\",",
  "  \"processNames\": [\"MyTool.exe\"],",
  "  \"windowKeywords\": [\"MyTool\"],",
  "  \"enabled\": true",
  "}",
  "```",
  "",
  "### 自动发现",
  "",
  "采集器每次启动会自动扫一遍本机（注册表 / 编辑器扩展 / 开始菜单 / 监听端口），把你装的 AI 工具识别出来。也可以手动跑一次看清单：",
  "",
  "```",
  "node 电脑端监控/scripts/scan-ai-tools.mjs",
  "```",
  "",
  "它会列出「已纳入监控 / 已被其他方式覆盖 / 未纳入」三类，未纳入的会提示你考虑加一条指纹。"
].join("\n"));

console.log("\n完成。APP/ 目录已就绪。");

function findApk() {
  const candidates = [
    path.join(root, "apps", "mobile", "android", "app", "build", "outputs", "apk", "release"),
    path.join(root, "apps", "mobile", "android", "app", "build", "outputs", "apk", "debug"),
    path.join(root, "apps", "mobile", "dist")
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const apk = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith(".apk"));
    if (apk) return path.join(dir, apk);
  }
  return null;
}

function run(file, args) {
  if (process.platform === "win32" && file.endsWith(".cmd")) {
    execFileSync("cmd.exe", ["/c", file, ...args], { cwd: root, stdio: "inherit", windowsHide: true });
    return;
  }
  execFileSync(file, args, { cwd: root, stdio: "inherit", windowsHide: true });
}

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // 先清掉目标（带重试，规避 Windows 上 cpSync 覆盖已存在文件时偶发的 spurious unlink 错误），
  // 让 cpSync 写入全新目标。
  if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true, retryDelay: 100, maxRetries: 3 });
  fs.cpSync(from, to, {
    recursive: true,
    filter: (source) => {
      const n = source.replaceAll("\\", "/");
      return !n.includes("/node_modules/") && !n.includes("/.expo/") && !n.includes("/android/build/") && !n.includes("/.git/");
    }
  });
}

function copyIfExists(from, to) {
  if (fs.existsSync(from)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function writeFile(filePath, value, encoding = "utf8") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, encoding);
}
