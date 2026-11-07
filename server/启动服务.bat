@echo off
chcp 65001 >nul
title TVAutoPlayer 媒体服务端
cd /d "%~dp0"

rem 端口默认 8300；config.env 里配置的 PORT 优先（仅用于显示地址和自动打开浏览器，
rem 其余配置项由 server.js 直接读取 config.env）
if not defined PORT set "PORT=8300"
if exist "%~dp0config.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~dp0config.env") do (
    if /i "%%a"=="PORT" set "PORT=%%b"
  )
)

rem 媒体目录必须存在，否则上传会失败
if not exist "%~dp0media" mkdir "%~dp0media"

rem 优先使用同目录自带的 node.exe（免安装绿色包），否则用系统安装的 Node.js
set "NODE_CMD="
if exist "%~dp0node.exe" set "NODE_CMD=%~dp0node.exe"
if not defined NODE_CMD (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_CMD=node"
)
if not defined NODE_CMD (
  echo.
  echo [错误] 没有找到 Node.js
  echo.
  echo 请下载免安装绿色包（自带运行环境），或安装 Node.js 24：
  echo   https://nodejs.org/zh-cn/download
  echo.
  pause
  exit /b 1
)

rem 同目录有 ffmpeg.exe 时自动加入搜索路径（用于旧封装 MKV 自动重封装）
if exist "%~dp0ffmpeg.exe" set "PATH=%~dp0;%PATH%"

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [提示] 未检测到 ffmpeg。旧封装 MKV 上传时会被拒绝，其余功能不受影响。
  echo.
)

echo 正在启动服务端，端口 %PORT%
echo 管理后台: http://localhost:%PORT%/
echo.
echo 首次运行如弹出"Windows 防火墙"提示，请点击"允许访问"，
echo 否则电视端无法连接本机。
echo 关闭此窗口即停止服务。
echo.

start "" "http://localhost:%PORT%/"
"%NODE_CMD%" server.js

echo.
echo 服务已停止。
pause
