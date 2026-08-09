@echo off
chcp 65001 >nul
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo 需要管理员权限，正在重新以管理员身份运行...
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
echo 正在放行 CodeStatus 端口 4317 / 5173 / 4318 ...
netsh advfirewall firewall delete rule name="CodeStatus" >nul 2>&1
netsh advfirewall firewall add rule name="CodeStatus" dir=in action=allow protocol=TCP localport=4317,5173,4318
echo 完成。现在手机应能连上电脑端了。
pause