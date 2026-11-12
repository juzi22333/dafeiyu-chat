@echo off
rem 启动大肥鱼聊天（Windows）。相对路径，拷到哪都能跑。
rem 可覆盖：PORT / HOST / UPSTREAM_BASE_URL / UPSTREAM_API_KEY / UPSTREAM_MODEL
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8710
if "%HOST%"=="" set HOST=127.0.0.1
if not exist data mkdir data
node server.js >> "data\app.log" 2>&1
