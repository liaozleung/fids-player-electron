import { BrowserWindow, WebFrameMain } from 'electron'
import type { DeviceConfig } from './config'

/**
 * 向子 frame 注入看门狗脚本。
 * 若页面设置了 __FIDS_WATCHDOG_MANAGED__（fids_webpage），跳过注入；
 * 否则启动 setInterval 每秒写入当前时间戳到 1×1 canvas 像素。
 */
const INJECT_SCRIPT = `(function(){
  if(window.__fidsWatchdogTimer||window.__FIDS_WATCHDOG_MANAGED__)return;
  function getCanvas(){
    var c=document.getElementById('__fids-watchdog__');
    if(!c){c=document.createElement('canvas');c.id='__fids-watchdog__';c.width=1;c.height=1;
    c.style.cssText='position:fixed;right:0;bottom:0;width:1px;height:1px;z-index:2147483647;pointer-events:none;';
    document.body.appendChild(c);}
    return c;
  }
  function tick(){try{var v=Date.now()%16777216;var ctx=getCanvas().getContext('2d');
    ctx.fillStyle='rgb('+((v>>16)&255)+','+((v>>8)&255)+','+(v&255)+')';ctx.fillRect(0,0,1,1);}catch(e){}}
  tick();window.__fidsWatchdogTimer=setInterval(tick,1000);
})();`

/** 直接从 canvas 内存读取编码值（r<<16|g<<8|b），避免截图合成误差 */
const READ_SCRIPT = `(function(){
  var c=document.getElementById('__fids-watchdog__');
  if(!c)return null;
  var d=c.getContext('2d').getImageData(0,0,1,1).data;
  return d[0]*65536+d[1]*256+d[2];
})();`

function injectIntoSubFrames(frame: WebFrameMain): void {
  for (const child of frame.frames) {
    child.executeJavaScript(INJECT_SCRIPT).catch(() => {})
    injectIntoSubFrames(child)
  }
}

async function readWatchdogValue(frame: WebFrameMain): Promise<number | null> {
  for (const child of frame.frames) {
    try {
      const val = await child.executeJavaScript(READ_SCRIPT)
      if (typeof val === 'number') return val
    } catch (_) {}
    const nested = await readWatchdogValue(child)
    if (nested !== null) return nested
  }
  return null
}

const CHECK_INTERVAL = 30_000
const STALE_THRESHOLD = 90_000
const MODULUS = 16_777_216

/**
 * 单屏看门狗服务。
 * P0-b：每屏一个 WatchdogService，按各自 deviceId 上报告警 / 冻结日志。
 */
export class WatchdogService {
  private timer: ReturnType<typeof setInterval> | null = null
  private frozenSince: number | null = null
  private recoveryAcknowledged = false
  private config: DeviceConfig
  private getMainWindow: () => BrowserWindow | null
  private getDisplayUrl: () => string | null

  constructor(
    config: DeviceConfig,
    getWindow: () => BrowserWindow | null,
    displayUrlGetter: () => string | null,
  ) {
    this.config = config
    this.getMainWindow = getWindow
    this.getDisplayUrl = displayUrlGetter
    this.start()
  }

  start(): void {
    this.stop()
    console.log(`[watchdog:${this.config.deviceId}] 已启动，检测间隔 30s，冻结阈值 90s`)
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  updateConfig(config: DeviceConfig): void {
    this.config = config
  }

  /** 显示 URL 切换时重置冻结计时，避免用旧状态误报 */
  reset(): void {
    this.frozenSince = null
    this.recoveryAcknowledged = false
    console.debug(`[watchdog:${this.config.deviceId}] 状态已重置`)
  }

  private async check(): Promise<void> {
    const win = this.getMainWindow()
    if (!win || win.isDestroyed()) return
    if (!this.getDisplayUrl()) {
      console.debug(`[watchdog:${this.config.deviceId}] 无显示 URL，跳过检测`)
      return
    }

    try {
      injectIntoSubFrames(win.webContents.mainFrame)
    } catch (_) {}

    try {
      const decoded = await readWatchdogValue(win.webContents.mainFrame)
      if (decoded === null) {
        console.log(`[watchdog:${this.config.deviceId}] 未找到看门狗 canvas，等待页面加载...`)
        return
      }

      const nowMod = Date.now() % MODULUS
      let diff = nowMod - decoded
      if (diff < 0) diff += MODULUS

      console.log(`[watchdog:${this.config.deviceId}] canvas 值=${decoded} nowMod=${nowMod} diff=${Math.round(diff / 1000)}s`)

      if (diff > STALE_THRESHOLD) {
        const wasFrozen = this.frozenSince !== null
        if (!this.frozenSince) this.frozenSince = Date.now()
        const frozenSec = Math.round((Date.now() - this.frozenSince) / 1000)
        console.warn(`[watchdog:${this.config.deviceId}] 页面疑似冻结，已持续 ${frozenSec}s，像素时差 ${Math.round(diff / 1000)}s`)
        await this.reportFreeze(frozenSec, diff)
        if (!wasFrozen) {
          await this.notifyAlert(true, `页面冻结 ${frozenSec}s，像素时差 ${Math.round(diff / 1000)}s`)
          this.recoveryAcknowledged = false
        }
      } else {
        if (this.frozenSince) {
          console.log(`[watchdog:${this.config.deviceId}] 页面已从冻结状态恢复`)
          this.frozenSince = null
          this.recoveryAcknowledged = true
          await this.notifyAlert(false)
        } else if (!this.recoveryAcknowledged) {
          this.recoveryAcknowledged = true
          console.debug(`[watchdog:${this.config.deviceId}] 启动后首次正常检测，主动同步未冻结状态`)
          await this.notifyAlert(false)
        }
      }
    } catch (e) {
      console.error(`[watchdog:${this.config.deviceId}] 检测异常:`, e)
    }
  }

  private async notifyAlert(alert: boolean, message?: string): Promise<void> {
    const cfg = this.config
    if (!cfg.serverUrl || !cfg.deviceId) return
    const url = `${cfg.serverUrl}/api/device-watchdog`
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: cfg.deviceId, alert, message }),
        signal: AbortSignal.timeout(5000),
      })
      console.log(`[watchdog:${cfg.deviceId}] 设备状态通知 alert=${alert} → HTTP ${resp.status}`)
    } catch (e) {
      console.error(`[watchdog:${cfg.deviceId}] 设备状态通知失败 (${url}):`, e)
    }
  }

  private async reportFreeze(frozenSec: number, staleMs: number): Promise<void> {
    const cfg = this.config
    if (!cfg.serverUrl || !cfg.deviceId) return
    try {
      await fetch(`${cfg.serverUrl}/api/device-status-logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: cfg.deviceId,
          status: 'error',
          timestamp: new Date().toISOString(),
          message: `[Watchdog] 页面冻结 ${frozenSec}s，像素时差 ${Math.round(staleMs / 1000)}s`,
        }),
        signal: AbortSignal.timeout(5000),
      })
    } catch (e) {
      console.error(`[watchdog:${cfg.deviceId}] 上报失败:`, e)
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 单例 wrapper：保持旧 API
// ─────────────────────────────────────────────────────────────
let defaultWatchdogService: WatchdogService | null = null

export function setDefaultWatchdogService(svc: WatchdogService): void {
  defaultWatchdogService = svc
}

export function startWatchdog(
  config: DeviceConfig,
  windowGetter: () => BrowserWindow | null,
  displayUrlGetter: () => string | null,
): void {
  defaultWatchdogService?.stop()
  defaultWatchdogService = new WatchdogService(config, windowGetter, displayUrlGetter)
}

export function stopWatchdog(): void {
  defaultWatchdogService?.stop()
}

export function updateWatchdogConfig(config: DeviceConfig): void {
  defaultWatchdogService?.updateConfig(config)
}

export function resetWatchdog(): void {
  defaultWatchdogService?.reset()
}
