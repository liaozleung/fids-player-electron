#!/usr/bin/env bash
# 在 Linux 设备上启用 Wake-on-LAN 并持久化
# 用法: sudo bash enable-wol.sh [interface]
#   interface 省略时自动检测默认路由出口网卡
# 前提: 已在 BIOS 里开启 "Wake on LAN" / "Power On by PCIe"

set -eu

if [ "$(id -u)" != "0" ]; then
  echo "需要 root 权限，请: sudo bash $0"
  exit 1
fi

# 1. 确保 ethtool 已安装
if ! command -v ethtool >/dev/null 2>&1; then
  echo "未检测到 ethtool，正在安装..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y ethtool
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y ethtool
  elif command -v yum >/dev/null 2>&1; then
    yum install -y ethtool
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm ethtool
  else
    echo "未识别的包管理器，请手动安装 ethtool 后重试"
    exit 1
  fi
fi

# 2. 确定网卡
IFACE="${1:-}"
if [ -z "$IFACE" ]; then
  IFACE=$(ip -o -4 route show default 2>/dev/null | awk '{print $5}' | head -n1)
fi
if [ -z "$IFACE" ]; then
  echo "无法自动检测网卡，请作为参数传入：sudo bash $0 eth0"
  exit 1
fi
echo "使用网卡: $IFACE"

# 3. 检查网卡是否支持 WoL
SUPPORTED=$(ethtool "$IFACE" 2>/dev/null | awk -F: '/Supports Wake-on/ {gsub(/ /,"",$2); print $2}')
if [ -z "$SUPPORTED" ] || ! echo "$SUPPORTED" | grep -q 'g'; then
  echo "网卡 $IFACE 不支持 Magic Packet (Supports Wake-on: $SUPPORTED)"
  echo "可能原因：驱动限制 / 集显网卡 / 主板未开启"
  exit 1
fi

CURRENT=$(ethtool "$IFACE" 2>/dev/null | awk -F: '/Wake-on:/ {gsub(/ /,"",$2); print $2}' | tail -n1)
echo "当前 WoL 状态: $CURRENT"

# 4. 立即启用 WoL（此次重启前有效）
ethtool -s "$IFACE" wol g
echo "已启用 Magic Packet 唤醒: ethtool -s $IFACE wol g"

# 5. 写 systemd service 开机自动设置（关键！ethtool 设置关机后会复位）
SERVICE_PATH="/etc/systemd/system/wol@.service"
cat > "$SERVICE_PATH" <<'EOF'
[Unit]
Description=Enable Wake-on-LAN for %I
Requires=network.target
After=network.target

[Service]
Type=oneshot
ExecStart=/sbin/ethtool -s %i wol g
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "wol@${IFACE}.service"

# 6. 验证
echo ""
echo "=== 最终状态 ==="
ethtool "$IFACE" | grep -E "Wake-on|Supports Wake-on"
echo ""
MAC=$(cat "/sys/class/net/$IFACE/address")
echo "设备 MAC: $MAC"
echo ""
echo "完成。关机后用魔术包唤醒：wakeonlan $MAC"
echo "或从服务端对该 MAC 发 UDP 广播 port 9 的 Magic Packet"
