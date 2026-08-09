@echo off
chcp 65001 >nul
cd /d %~dp0
echo 启动 CodeStatus 通用 AI 工具监控...
if not exist data mkdir data
start "CodeStatus AI监控" /min cmd /c "chcp 65001 >nul & node adapters\desktop-collector.mjs > data\collector.log 2>&1"
echo.
echo 已在后台启动（最小化窗口）。
echo 日志：data\collector.log（可随时查看采集状态）
echo 指纹库：config\fingerprints.json（要加新工具改这里）
echo.
echo 提示：需先运行同目录的 CodeStatus-Monitor.exe，状态才会显示到桌面/手机。
echo.
pause
