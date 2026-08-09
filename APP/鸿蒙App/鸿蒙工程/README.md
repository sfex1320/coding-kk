# CodeStatus 鸿蒙手机端

HarmonyOS（Stage 模型，ArkTS）客户端：扫描电脑端页面的二维码后，用内置 WebView 加载副屏页面，实现状态展示与语音播报。

> 说明：鸿蒙 NEXT **不能直接运行安卓 APK**，必须单独构建。本工程是一个可在 DevEco Studio 打开并构建 `.hap` 的脚手架。

## 构建 .hap（需要鸿蒙开发环境）

1. 安装 **DevEco Studio 5+**（API 12 及以上）。
2. 用 DevEco Studio 打开本目录 `apps/harmony`。
3. 配置签名：File → Project Structure → Signing Configs（用华为开发者账号自动签名）。
4. Build → Build Hap(s)/APP(s) → Build Hap，产物在 `entry/build/.../outputs/.../entry-default-signed.hap`。
5. 用 hdc 安装到手机：`hdc install entry-default-signed.hap`。

## 连接方式

打开 App → 点「扫码连接」→ 对准电脑端页面「局域网配对」里的二维码 → 自动加载副屏。
（二维码内容形如 `http://192.168.x.x:5173?display=1&pair=XXXXX`，手机需与电脑同一 Wi-Fi。）

## 零安装替代方案（最快）

鸿蒙手机自带浏览器即可：用相机/浏览器扫同一个二维码，直接打开副屏页面，无需安装。可在浏览器里「添加到桌面」当作 App 用。
