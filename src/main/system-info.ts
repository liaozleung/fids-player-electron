import si from 'systeminformation'
import { uptime } from 'os'

export interface SystemInfo {
  cpuUsage: number
  memoryUsage: number
  diskUsage: number
}

/** 收集系统信息 (CPU / 内存 / 磁盘使用率) */
export async function collectSystemInfo(): Promise<SystemInfo> {
  try {
    const [cpu, mem, disk] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
    ])

    const cpuUsage = cpu.currentLoad || 0

    const memoryUsage = mem.total > 0
      ? ((mem.total - mem.available) / mem.total) * 100
      : 0

    // 计算所有磁盘的加权平均使用率
    let totalSize = 0
    let totalUsed = 0
    for (const fs of disk) {
      totalSize += fs.size
      totalUsed += fs.used
    }
    const diskUsage = totalSize > 0 ? (totalUsed / totalSize) * 100 : 0

    return {
      cpuUsage: Math.round(cpuUsage * 10) / 10,
      memoryUsage: Math.round(memoryUsage * 10) / 10,
      diskUsage: Math.round(diskUsage * 10) / 10,
    }
  } catch (e) {
    console.error('获取系统信息失败:', e)
    return { cpuUsage: 0, memoryUsage: 0, diskUsage: 0 }
  }
}

/** 获取系统运行时间 */
export function getUptime(): string {
  const secs = uptime()
  const hours = Math.floor(secs / 3600)
  const minutes = Math.floor((secs % 3600) / 60)
  return `${hours}h ${minutes}m`
}

/** 获取本机首个非回环 IPv4 地址 */
export async function getLocalIpAddress(): Promise<string | null> {
  try {
    const nets = await si.networkInterfaces()
    const list = Array.isArray(nets) ? nets : [nets]
    for (const iface of list) {
      if (iface.ip4 && !iface.internal && iface.ip4 !== '127.0.0.1') {
        return iface.ip4
      }
    }
  } catch (e) {
    console.error('获取本机 IP 失败:', e)
  }
  return null
}
