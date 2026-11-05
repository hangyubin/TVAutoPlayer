@echo off
chcp 65001 >nul
title 安装 ffmpeg
cd /d "%~dp0"

echo 正在下载 ffmpeg（约 120MB），请保持网络连接，稍候...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue';" ^
  "Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile 'ffmpeg.zip';" ^
  "Expand-Archive -Force 'ffmpeg.zip' -DestinationPath 'ffmpeg_tmp';" ^
  "$b = Get-ChildItem -Path 'ffmpeg_tmp' -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1;" ^
  "if ($b) { Copy-Item $b.FullName -Destination 'ffmpeg.exe' -Force };" ^
  "$p = Get-ChildItem -Path 'ffmpeg_tmp' -Filter 'ffprobe.exe' -Recurse | Select-Object -First 1;" ^
  "if ($p) { Copy-Item $p.FullName -Destination 'ffprobe.exe' -Force };" ^
  "Remove-Item -Recurse -Force 'ffmpeg.zip','ffmpeg_tmp' -ErrorAction SilentlyContinue"

if exist "%~dp0ffmpeg.exe" (
  echo.
  echo [成功] ffmpeg 已安装到本目录，再次启动服务即可使用。
) else (
  echo.
  echo [失败] 下载或解压未成功，请检查网络后重新双击本文件。
  echo        如仍失败，可手动下载：https://www.gyan.dev/ffmpeg/builds/
  echo        解压后把 ffmpeg.exe 放到本文件夹即可。
)
echo.
pause
