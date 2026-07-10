# CodeStatus Mobile

这是手机端 APP 工程，基于 Expo / React Native，用于连接电脑端 CodeStatus Desktop Client。

## 开发运行

```powershell
npm install
npm run start
```

## 生成可安装 Android APK

在 Windows 上需要先安装：

- Java JDK 17
- Android Studio / Android SDK
- 设置 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT`

然后双击：

```text
Build-Android-APK.cmd
```

成功后会生成：

```text
dist/CodeStatus-Mobile-debug.apk
```

这个 debug APK 可以直接传到安卓手机安装测试。正式分发包建议使用 EAS 云打包：

```powershell
npm run build:android:apk
```

## iOS

iOS 不能在 Windows 上直接打包，需要 macOS、Xcode 和 Apple Developer 签名证书。
