import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

// 把电脑端监控打包成单个 Windows 可执行文件（内嵌 Node 运行时 + 网页资源）。
// 产物：APP/电脑端监控/CodeStatus-Monitor.exe —— 双击即运行，无需安装 Node。
const root = process.cwd();
const buildDir = path.join(root, "build");
const distDir = path.join(root, "dist");
const outDir = path.join(root, "APP", "电脑端监控");
const bundlePath = path.join(buildDir, "codestatus-server.cjs");
const blobPath = path.join(buildDir, "sea-prep.blob");
const configPath = path.join(buildDir, "sea-config.json");
const exeName = "CodeStatus-Monitor.exe";
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

// 1. 构建网页
console.log("[1/6] vite build...");
run("npm.cmd", ["run", "build"]);

// 2. 把服务端打包成单个 CJS
console.log("[2/6] bundle server...");
await build({
  entryPoints: [path.join(root, "server", "index.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: bundlePath,
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "error"
});

// 3. 收集 dist 下所有文件作为内嵌资源
console.log("[3/6] collect web assets...");
const assets = {};
for (const file of walk(distDir)) {
  const key = path.relative(distDir, file).replaceAll("\\", "/");
  assets[key] = file;
}
console.log(`      embedded ${Object.keys(assets).length} assets`);

// 4. 生成 SEA 配置与 blob
console.log("[4/6] generate SEA blob...");
fs.writeFileSync(
  configPath,
  JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true, assets }, null, 2)
);
run(process.execPath, ["--experimental-sea-config", configPath]);

// 5. 复制 node 运行时并注入
console.log("[5/6] create exe + inject...");
const exePath = path.join(outDir, exeName);
fs.rmSync(exePath, { force: true });
fs.copyFileSync(process.execPath, exePath);
run(process.execPath, [
  path.join(root, "node_modules", "postject", "dist", "cli.js"),
  exePath,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  FUSE
]);

// 6. 附带一个说明
console.log("[6/6] write readme...");
fs.writeFileSync(
  path.join(outDir, "使用说明.txt"),
  [
    "CodeStatus 电脑端监控",
    "",
    "双击 CodeStatus-Monitor.exe 即可启动，浏览器会自动打开 http://127.0.0.1:5173",
    "无需安装 Node.js，网页已内嵌在程序里。",
    "",
    "接入各 Coding 工具：见同目录 extensions/ 与 hooks 安装脚本（如随包提供）。",
    "手机端：页面「局域网配对」二维码，手机 App 扫码连接（同一 Wi-Fi）。"
  ].join("\r\n"),
  "utf8"
);

console.log(`\nDone: ${exePath}`);

function run(file, args) {
  if (process.platform === "win32" && file.endsWith(".cmd")) {
    execFileSync("cmd.exe", ["/c", file, ...args], { cwd: root, stdio: "inherit", windowsHide: true });
    return;
  }
  execFileSync(file, args, { cwd: root, stdio: "inherit", windowsHide: true });
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
