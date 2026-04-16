#!/bin/bash

if [ $# -lt 2 ]; then
  echo "用法: $0 <用户名> <IP...>"
  exit 1
fi

REMOTE_USER=$1
shift

LOCAL_FILE="/Users/hzwl/proj_fids/fids_player_electron/dist/fids-player-electron-0.1.0.tar.gz"
REMOTE_DIR="/opt/fids-player"
PACKAGE_NAME="fids-player-electron-0.1.0.tar.gz"
EXTRACT_DIR="fids-player-electron-0.1.0"

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
