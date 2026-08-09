@echo off
chcp 65001 >nul
set DEST=%USERPROFILE%\.vscode\extensions\codestatus-companion-0.1.0
echo 安装 VS Code 扩展到 %DEST%
if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy /e /i /y "%~dp0extensions\vscode" "%DEST%" >nul
echo 完成。请重启 VS Code / Cursor。Cursor 用户把上面的 .vscode 改成 .cursor。
pause