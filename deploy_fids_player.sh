#!/bin/bash

if [ $# -lt 2 ]; then
  echo "用法: $0 <用户名> <IP...>"
  exit 1
fi

REMOTE_USER=$1
shift

# 自动定位 dist 下最新构建的 tar.gz（按修改时间，不依赖 package.json 版本号）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="${SCRIPT_DIR}/dist"
LOCAL_FILE=$(ls -t "${DIST_DIR}"/fids-player-electron-*.tar.gz 2>/dev/null | head -1)
if [ -z "$LOCAL_FILE" ]; then
  echo "❌ 未在 ${DIST_DIR} 下找到 fids-player-electron-*.tar.gz，请先 npm run build:linux"
  exit 1
fi
PACKAGE_NAME=$(basename "$LOCAL_FILE")
# 从 fids-player-electron-<VERSION>.tar.gz 提取 <VERSION>
VERSION=${PACKAGE_NAME#fids-player-electron-}
VERSION=${VERSION%.tar.gz}
EXTRACT_DIR="fids-player-electron-${VERSION}"
REMOTE_DIR="/opt/fids-player"

echo "📦 本次部署版本: ${VERSION}"
echo "   本地包: ${LOCAL_FILE}"
echo ""

for REMOTE_HOST in "$@"
do
  echo "======================================"
  echo "🚀 部署到: ${REMOTE_USER}@${REMOTE_HOST}"
  echo "======================================"

  echo "==> 上传安装包..."
  scp "$LOCAL_FILE" ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/ || {
    echo "❌ 上传失败"
    continue
  }

  echo "==> 执行远程部署..."
  
  # 简化版本，一步一步执行
  ssh ${REMOTE_USER}@${REMOTE_HOST} "cd ${REMOTE_DIR} && pkill -f fids-player-electron" || true
  ssh ${REMOTE_USER}@${REMOTE_HOST} "sleep 2"
  ssh ${REMOTE_USER}@${REMOTE_HOST} "cd ${REMOTE_DIR} && sudo rm -rf ${EXTRACT_DIR}"
  ssh ${REMOTE_USER}@${REMOTE_HOST} "cd ${REMOTE_DIR} && tar -xzf ${PACKAGE_NAME}"
  ssh ${REMOTE_USER}@${REMOTE_HOST} "cd ${REMOTE_DIR} && sudo chown root:root ${EXTRACT_DIR}/chrome-sandbox && sudo chmod 4755 ${EXTRACT_DIR}/chrome-sandbox"
  ssh ${REMOTE_USER}@${REMOTE_HOST} "cd ${REMOTE_DIR} && rm -f ${PACKAGE_NAME}"
  
  echo "✅ 部署完成，请手动重启程序"
  echo "======================================"
done

echo "🎉 全部完成"
