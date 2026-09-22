import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { readdir, rename, rm, symlink, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { configDir, type DeviceConfig } from './config'
import { verifyUpdatePackage } from './ota-verify'

const execFileAsync = promisify(execFile)

/**
 * 终端 OTA（2026-09-22，Linux x64 tar.gz 形态）
 *
 * 触发：MQTT `update` 指令 { version, url, manifestUrl, sha256, size }
 * 流程：校验来源 → 下载包 + manifest 到 ~/.fids_player/ota/<version>/ → 本地 sha256 + ed25519 验签（fail-closed）
 *      → 解压到 <安装根>/fids-player-electron-<version>/ → chrome-sandbox 权限（sudo -n）→ 原子切 current 软链
 *      → 回报 restarting → 以 current 路径拉起新进程 → 退出。每步向 fids /api/devices/update-status 回报。
 * 安装根 = 当前可执行文件所在目录的上一级（/opt/fids-player/fids-player-electron-0.6.1/fids-player-electron → /opt/fids-player），
 * 与 deploy_fids_player.sh 的目录约定一致；自启动入口应指向 <安装根>/current。
 * 回滚：ln -sfn <旧版本目录> current 后重启（旧目录保留一份）。
 * 来源限制：url / manifestUrl 必须与 serverUrl 同源（防止被诱导从任意地址下载；即便下载了，验签也过不了）。
 */
export interface UpdateCommand {
  version: string
  url: string
  manifestUrl: string
  sha256?: string
  size?: number
}

type Status = 'downloading' | 'verifying' | 'installing' | 'restarting' | 'success' | 'failed'

let inFlight = false

export function installRoot(): string {
  // dev 模式（electron-vite dev）execPath 指向 node_modules 里的 Electron，不允许 OTA
  return resolve(dirname(process.execPath), '..')
}

export function isPackagedLinux(): boolean {
  return app.isPackaged && process.platform === 'linux'
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a), ub = new URL(b)
    return ua.protocol === ub.protocol && ua.host === ub.host
  } catch {
    return false
  }
}

async function report(cfg: DeviceConfig, version: string, status: Status, message?: string): Promise<void> {
  const url = `${cfg.serverUrl.replace(/\/+$/, '')}/api/devices/update-status`
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: cfg.deviceId, version, status, message }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (e) {
    console.warn(`[ota:${cfg.deviceId}] 回报 ${status} 失败:`, (e as Error).message)
  }
  console.log(`[ota:${cfg.deviceId}] ${status}${message ? ' · ' + message : ''}`)
}

async function download(url: string, dest: string, maxBytes: number): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!res.ok || !res.body) throw new Error(`下载 HTTP ${res.status}: ${url}`)
  const len = Number(res.headers.get('content-length') || 0)
  if (len > maxBytes) throw new Error(`包过大 ${len} > ${maxBytes}`)
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest))
  if (statSync(dest).size > maxBytes) throw new Error('包过大')
}

export async function runUpdate(cfg: DeviceConfig, cmd: UpdateCommand): Promise<void> {
  const v = String(cmd.version || '').trim()
  if (inFlight) { console.warn('[ota] 已有更新在进行，忽略'); return }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) { await report(cfg, v || '?', 'failed', '版本号非法'); return }
  if (v === app.getVersion()) { await report(cfg, v, 'success', '已是该版本'); return }
  if (!isPackagedLinux()) { await report(cfg, v, 'failed', `当前形态不支持自更新（packaged=${app.isPackaged} platform=${process.platform}）`); return }
  if (!sameOrigin(cmd.url, cfg.serverUrl) || !sameOrigin(cmd.manifestUrl, cfg.serverUrl)) {
    await report(cfg, v, 'failed', '下载地址与 serverUrl 不同源，拒绝'); return
  }

  inFlight = true
  const root = installRoot()
  const work = join(configDir(), 'ota', v)
  const pkgPath = join(work, `fids-player-electron-${v}.tar.gz`)
  const manPath = `${pkgPath}.manifest.json`
  const targetDir = join(root, `fids-player-electron-${v}`)
  const stagingDir = `${targetDir}.staging`
  try {
    mkdirSync(work, { recursive: true })
    await report(cfg, v, 'downloading', `${cmd.url}`)
    await download(cmd.manifestUrl, manPath, 64 * 1024)
    await download(cmd.url, pkgPath, 512 * 1024 * 1024)

    await report(cfg, v, 'verifying')
    const vr = verifyUpdatePackage(pkgPath, manPath)
    if (!vr.ok) throw new Error(`验签失败：${vr.reason}`)
    if (cmd.sha256 && cmd.sha256 !== vr.manifest.sha256) throw new Error('指令哈希与 manifest 不一致')

    await report(cfg, v, 'installing', targetDir)
    rmSync(stagingDir, { recursive: true, force: true })
    mkdirSync(stagingDir, { recursive: true })
    // 包内顶层目录为 fids-player-electron-<v>/（electron-builder tar.gz 约定）→ strip 1 层
    await execFileAsync('tar', ['-xzf', pkgPath, '-C', stagingDir, '--strip-components=1'])
    const bin = join(stagingDir, 'fids-player-electron')
    if (!existsSync(bin)) throw new Error('包内缺少 fids-player-electron 可执行文件')
    // chrome-sandbox 需 root:root 4755，否则 Electron 拒绝启动；无免密 sudo 则失败（部署时配置 NOPASSWD）
    try {
      await execFileAsync('sudo', ['-n', 'chown', 'root:root', join(stagingDir, 'chrome-sandbox')])
      await execFileAsync('sudo', ['-n', 'chmod', '4755', join(stagingDir, 'chrome-sandbox')])
    } catch (e) {
      throw new Error(`设置 chrome-sandbox 权限失败（需要免密 sudo）：${(e as Error).message}`)
    }
    rmSync(targetDir, { recursive: true, force: true })
    await rename(stagingDir, targetDir)
    // 原子切换 current：先建临时链再 rename 覆盖
    const cur = join(root, 'current')
    const tmpLink = join(root, `.current.${process.pid}`)
    await unlink(tmpLink).catch(() => {})
    await symlink(`fids-player-electron-${v}`, tmpLink)
    await rename(tmpLink, cur)
    // 清理：只留 current 指向的新版 + 版本号最高的一个旧版
    try {
      const dirs = (await readdir(root)).filter((d) => /^fids-player-electron-\d/.test(d) && d !== `fids-player-electron-${v}`)
      dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      for (const d of dirs.slice(0, -1)) {
        const full = join(root, d)
        // 目录内 chrome-sandbox 为 root 属主，某些环境下普通用户 rm 失败 → sudo -n 兜底（0.7.1 实测 0.6.0 未清）
        await rm(full, { recursive: true, force: true }).catch(() => execFileAsync('sudo', ['-n', 'rm', '-rf', full]))
        if (existsSync(full)) await execFileAsync('sudo', ['-n', 'rm', '-rf', full]).catch(() => {})
      }
    } catch { /* 清理失败不影响更新 */ }
    await rm(work, { recursive: true, force: true }).catch(() => {})

    await report(cfg, v, 'restarting', '新进程以 current 路径拉起')
    // 成功状态由新进程启动后回报（见 reportStartupIfUpdated）；这里只拉起并退出
    const child = spawn(join(cur, 'fids-player-electron'), process.argv.slice(1), {
      detached: true, stdio: 'ignore', env: { ...process.env, FIDS_OTA_JUST_UPDATED: v },
    })
    child.unref()
    setTimeout(() => app.exit(0), 800)
  } catch (e) {
    rmSync(stagingDir, { recursive: true, force: true })
    await report(cfg, v, 'failed', (e as Error).message)
    inFlight = false
  }
}

/** 新进程启动时调用：若由 OTA 拉起则回报 success（版本号来自 app.getVersion()，即真实运行版本） */
export async function reportStartupIfUpdated(cfg: DeviceConfig): Promise<void> {
  const expected = process.env.FIDS_OTA_JUST_UPDATED
  if (!expected) return
  const running = app.getVersion()
  if (running === expected) await report(cfg, running, 'success', `已运行 ${running}`)
  else await report(cfg, expected, 'failed', `拉起后运行版本为 ${running}，与目标 ${expected} 不符`)
}
