import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 一键构建安卓 APK —— 复用仓库内已就绪的工具链，无需再配环境。
//
// 复用的东西（已持久化，不会每次重来）：
//   - JDK17 + Android SDK：仓库内 .android-build/（脚本会把它们映射到无空格路径）
//   - Gradle / Maven 依赖：缓存在用户目录 ~/.gradle（首次构建后不再下载）
//   - node_modules：apps/mobile 内已安装
//
// 每次构建唯一要做的：把工程同步到无空格路径再构建（因为项目目录 "coding KK" 带空格，
// 会让 React Native 的 Gradle 插件出错）。脚本已自动处理，增量同步、很快。
//
// 用法：node scripts/build-android-apk.mjs    （或双击根目录 打包安卓APK.cmd）

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jdk = path.join(repoRoot, ".android-build", "jdk17");
const sdk = path.join(repoRoot, ".android-build", "android-sdk");
const mobileSrc = path.join(repoRoot, "apps", "mobile");

// 无空格的工作路径（Windows 联接 / 目录）
const JDK_LINK = "C:\\csj";
const SDK_LINK = "C:\\csk";
const WORK = "C:\\csbuild";
const outApk = path.join(repoRoot, "APP", "安卓App", "CodeStatus.apk");

const t0 = Date.now();
log("检查工具链...");
assert(fs.existsSync(path.join(jdk, "bin", "java.exe")), `找不到 JDK：${jdk}`);
assert(fs.existsSync(path.join(sdk, "cmdline-tools")), `找不到 Android SDK：${sdk}`);

// 1. 确保无空格联接存在（JDK / SDK）
ensureJunction(JDK_LINK, jdk);
ensureJunction(SDK_LINK, sdk);

// 2. 把工程增量同步到无空格工作目录（排除生成的 android/ 与缓存；保留 node_modules）
log("同步工程到无空格目录（增量）...");
fs.mkdirSync(WORK, { recursive: true });
robocopy(mobileSrc, WORK, [
  "/E",
  "/XD", path.join(mobileSrc, "android"), path.join(mobileSrc, ".expo"), ".cxx", ".gradle", ".git", ".idea",
  "/XF", "*.log",
  "/NFL", "/NDL", "/NJH", "/NJS", "/R:1", "/W:1", "/MT:16"
]);

// 3. node_modules 兜底（极少触发）
if (!fs.existsSync(path.join(WORK, "node_modules", "expo"))) {
  log("工作目录缺少 node_modules，安装中...");
  execIn(WORK, "cmd.exe", ["/c", "npm", "install", "--no-audit", "--no-fund"]);
}

const env = {
  ...process.env,
  JAVA_HOME: JDK_LINK,
  ANDROID_HOME: SDK_LINK,
  ANDROID_SDK_ROOT: SDK_LINK,
  PATH: `${JDK_LINK}\\bin;${process.env.PATH}`
};

// 4. 生成原生工程：首次（或加 --clean）才生成，之后复用以走 Gradle 增量、提速
const wantClean = process.argv.includes("--clean");
const androidDir = path.join(WORK, "android");
if (wantClean) fs.rmSync(androidDir, { recursive: true, force: true });
if (!fs.existsSync(path.join(androidDir, "app", "build.gradle"))) {
  log("生成原生工程 (expo prebuild)...");
  fs.rmSync(androidDir, { recursive: true, force: true });
  execIn(WORK, "cmd.exe", ["/c", "npx", "expo", "prebuild", "--platform", "android", "--no-install"], env);
} else {
  log("复用已生成的原生工程（如改了 app.json 权限/插件，请用 --clean 重新生成）");
}
fs.writeFileSync(path.join(androidDir, "local.properties"), `sdk.dir=${SDK_LINK.replace(/\\/g, "\\\\")}\n`, "ascii");

// 5. Gradle 构建 release（独立可装：内嵌 JS，debug 证书签名）
log("Gradle 构建 release APK（首次较久，之后走缓存很快）...");
execIn(androidDir, "cmd.exe", ["/c", path.join(androidDir, "gradlew.bat"), "assembleRelease", "--no-daemon"], env);

// 6. 取出 APK
const built = path.join(WORK, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
assert(fs.existsSync(built), `构建完成但未找到 APK：${built}`);
fs.mkdirSync(path.dirname(outApk), { recursive: true });
fs.copyFileSync(built, outApk);

const mb = (fs.statSync(outApk).size / 1048576).toFixed(1);
const sec = ((Date.now() - t0) / 1000).toFixed(0);
log(`完成！用时 ${sec}s`);
log(`APK: ${outApk} (${mb} MB)`);

function ensureJunction(link, target) {
  if (fs.existsSync(link)) {
    try {
      const real = fs.realpathSync(link);
      if (path.resolve(real).toLowerCase() === path.resolve(target).toLowerCase()) return;
    } catch {
      // 失效联接，重建
    }
    try { fs.rmSync(link, { recursive: true, force: true }); } catch {}
  }
  fs.symlinkSync(target, link, "junction");
  log(`联接 ${link} -> ${target}`);
}

function robocopy(src, dst, args) {
  // robocopy 退出码 0-7 都算成功
  try {
    execFileSync("robocopy", [src, dst, ...args], { stdio: "ignore", windowsHide: true });
  } catch (error) {
    if ((error.status ?? 8) >= 8) throw new Error(`robocopy 失败 (code ${error.status})`);
  }
}

function execIn(cwd, file, args, env = process.env) {
  execFileSync(file, args, { cwd, env, stdio: "inherit", windowsHide: true });
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`[错误] ${msg}`);
    process.exit(1);
  }
}

function log(msg) {
  console.log(`[安卓构建] ${msg}`);
}
