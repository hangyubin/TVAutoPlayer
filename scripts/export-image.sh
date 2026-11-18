#!/usr/bin/env bash
# 导出服务端镜像为离线 tar 包，供无法访问 GHCR 的部署机使用。
# 用法：./scripts/export-image.sh [版本号]
# 不传版本号时读取 app/build.gradle.kts 的 versionName。
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

version="${1:-}"
if [ -z "$version" ]; then
  version="$(sed -n 's/.*versionName *= *"\([^"]*\)".*/\1/p' app/build.gradle.kts | head -1)"
fi
if [ -z "$version" ]; then
  echo "无法读取版本号，请手动传入：./scripts/export-image.sh 1.11.1" >&2
  exit 1
fi

image="ghcr.io/hangyubin/tvautoplayer-server:${version}"
output="dist/tvautoplayer-server-${version}.tar"

if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 docker 命令，请先安装 Docker。" >&2
  exit 1
fi

mkdir -p dist
echo "拉取镜像 ${image}"
docker pull "$image"

echo "导出到 ${output}"
docker save "$image" -o "$output"

echo
echo "完成：${output}（$(du -h "$output" | cut -f1)）"
echo "部署机导入："
echo "  docker load -i ${output}"
echo "  docker compose up -d"
