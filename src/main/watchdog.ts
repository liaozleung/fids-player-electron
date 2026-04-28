import { BrowserWindow, screen } from 'electron'
import type { DeviceConfig } from './config'

const CHECK_INTERVAL = 30_000    // 每 30s 检测一次
const STALE_THRESHOLD = 90_000   // 90s 像素未变化则判定为冻结
const MODULUS = 16_777_216       // 2^24，与前端编码一致

let watchdogTimer: ReturnType<typeof setInterval> | null = null
let frozenSince: number | null = null
let currentConfig: DeviceConfig | null = null
let getMainWindow: (() => BrowserWindow | null) | null = null

export function startWatchdog(
  config: DeviceConfig,
  windowGetter: () => BrowserWindow | null
): void {
  currentConfig = config
  getMainWindow = windowGetter
  stopWatchdog()
  console.log('[Watchdog] 已启动，检测间隔 30s，冻结阈值 90s')
  watchdogTimer = setInterval(checkWatchdog, CHECK_INTERVAL)
}

export function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}

export function updateWatchdogConfig(config: DeviceConfig): void {
  currentConfig = config
}

async function checkWatchdog(): Promise<void> {
  const win = getMainWindow?.()
  if (!win || win.isDestroyed()) return

  try {
    const image = await win.webContents.capturePage()
    const buf = image.toBitmap()  // BGRA 格式
    const { width, height } = image.getSize()

    if (width === 0 || height === 0 || buf.length < 4) return

    // 读取右下角像素（canvas 固定在 right:0 bottom:0）
    // capturePage 返回逻辑分辨率图像，无需手动乘以 scaleFactor
    const x = width - 1
    const y = height - 1
    const i = (y * width + x) * 4

    if (i + 3 >= buf.length) return

    // toBitmap() 字节序：B G R A
    const b = buf[i], g = buf[i + 1], r = buf[i + 2]
    const decoded = (r << 16) | (g << 8) | b  // 还原 timestamp % 2^24

    const nowMod = Date.now() % MODULUS
    // 处理模运算循环进位（如 decoded 接近 2^24，nowMod 已归零）
    let diff = nowMod - decoded
    if (diff < 0) diff += MODULUS

    console.debug(`[Watchdog] pixel rgb(${r},${g},${b}) diff=${Math.round(diff / 1000)}s`)

    if (diff > STALE_THRESHOLD) {
      if (!frozenSince) frozenSince = Date.now()
      const frozenSec = Math.round((Date.now() - frozenSince) / 1000)
      console.warn(`[Watchdog] 页面疑似冻结，已持续 ${frozenSec}s，像素时差 ${Math.round(diff / 1000)}s`)
      await reportFreeze(frozenSec, diff)
    } else {
      if (frozenSince) {
        console.log('[Watchdog] 页面已从冻结状态恢复')
        frozenSince = null
      }
    }
  } catch (e) {
    console.error('[Watchdog] 检测异常:', e)
  }
}

async function reportFreeze(frozenSec: number, staleMs: number): Promise<void> {
  if (!currentConfig?.serverUrl || !currentConfig?.deviceId) return

  try {
    await fetch(`${currentConfig.serverUrl}/api/device-status-logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: currentConfig.deviceId,
        status: 'error',
        timestamp: new Date().toISOString(),
        message: `[Watchdog] 页面冻结 ${frozenSec}s，像素时差 ${Math.round(staleMs / 1000)}s`,
      }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (e) {
    console.error('[Watchdog] 上报失败:', e)
  }
}
