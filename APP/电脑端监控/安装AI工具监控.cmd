@echo off
chcp 65001 >nul
cd /d %~dp0
echo 安装 CodeStatus 通用 AI 工具监控（设置开机自启）...

REM 把启动项的快捷方式放进开机启动文件夹
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LAUNCHER=%~dp0启动AI工具监控.cmd"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%STARTUP%\CodeStatus AI监控.lnk'); $s.TargetPath='%LAUNCHER%'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if exist "%STARTUP%\CodeStatus AI监控.lnk" (echo 开机自启已创建：%STARTUP%\CodeStatus AI监控.lnk) else (echo [警告] 自启项创建失败，可手动把「启动AI工具监控.cmd」快捷方式拖进启动文件夹)

echo.
echo 立即启动一次...
if not exist data mkdir data
start "CodeStatus AI监控" /min cmd /c "chcp 65001 >nul & node adapters\desktop-collector.mjs > data\collector.log 2>&1"
echo 已在后台启动。日志：data\collector.log
echo.
pause
