@echo off
chcp 65001 >nul
cd /d %~dp0
node scripts/install-codex-hooks.mjs
echo 还需在 Codex 里 /hooks 信任 CodeStatus hook。
pause