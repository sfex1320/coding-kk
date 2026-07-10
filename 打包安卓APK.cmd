@echo off
chcp 65001 >nul
cd /d %~dp0
echo === CodeStatus 安卓 APK 一键构建 ===
node scripts/build-android-apk.mjs
echo.
echo 完成后 APK 在 APP\安卓App\CodeStatus.apk
pause
