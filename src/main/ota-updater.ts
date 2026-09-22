import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { readdir, rename, rm, rmdir, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { configDir, type DeviceConfig } from './config'
import { verifyUpdatePackage } from './ota-verify'

const execFileAsync = promisify(execFile)

/**
 * 终端 OTA（2026-09-22 Linux tar.gz；2026-09-22 晚增 Windows zip，目录制同构）
 *
 * 触发：MQTT `update` 指令 { version, platform, url, manifestUrl, sha256, size }
 * 布局（两平台一致，自启动指向 current）：
 *   Linux   /opt/fids-player/fids-player-electron-<v>/fids-player-electron   + current 软链
 *   Windows C:\fids-player\fids-player-electron-<v>\FIDS Player.exe          + current 目录联接（junction，无需管理员）
 * 流程：平台/来源校验 → 下载包 + manifest 到 ~/.fids_player/ota/<v>/ → 本地 size/sha256/ed25519 三核（fail-closed）
 *      → 解压到 staging（Linux tar.gz strip 1 层；Windows zip 用系统自带 tar 解，无顶层目录）→ Linux 设 chrome-sandbox 4755（sudo -n）
 *      → 切 current → 清旧版只留一份 → 回报 restarting → 以 current 路径拉起新进程 → 退出。
 * 新进程启动时若带 FIDS_OTA_JUST_UPDATED，按真实 app.getVersion() 回报 success / failed。
 * 前置：必须运行在 fids-player-electron-<v>/ 目录制布局里（安装器版 / 任意目录解压版拒绝 OTA，提示用引导脚本重装）。
 * 回滚：把 current 指回旧版本目录后重启（Windows：rmdir current && mklink /J current <旧目录>）。
 */
export interface UpdateCommand {
  version: string
  url: string
  manifestUrl: string
  platform?: string
  sha256?: string
  size?: number
}

type Status = 'downloading' | 'verifying' | 'installing' | 'restarting' | 'success' | 'failed'

let inFlight = false
const IS_WIN = process.platform === 'win32'

/** 本机对应的发布包平台标识（与 fids RELEASE_PLATFORMS 一致） */
export function localPlatformKey(): string {
  return `electron-${IS_WIN ? 'win' : 'linux'}-x64`
}

/** 当前可执行文件所在的版本目录（fids-player-electron-<v>）与安装根 */
export function installLayout(): { root: string; versionDir: string; exeName: string; ok: boolean } {
  const exe = process.execPath
  const versionDir = dirname(exe)
  const root = resolve(versionDir, '..')
  const ok = app.isPackaged && /^fids-player-electron-\d/.test(basename(versionDir))
  return { root, versionDir, exeName: basename(exe), ok }
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

/** 解压到 staging：tar.gz 有顶层目录 strip 1；zip（Windows 10+ 自带 bsdtar 支持）无顶层目录 */
async function extract(pkgPath: string, stagingDir: string): Promise<void> {
  if (pkgPath.endsWith('.zip')) {
    // 精简版 Win10 可能没有 System32\tar.exe（hp001 实测）→ 回落 PowerShell Expand-Archive
    try {
      await execFileAsync('tar', ['-xf', pkgPath, '-C', stagingDir])
    } catch (e) {
      console.warn('[ota] tar 不可用，改用 Expand-Archive:', (e as Error).message)
      await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath '${pkgPath.replace(/'/g, "''")}' -DestinationPath '${stagingDir.replace(/'/g, "''")}' -Force`])
    }
  } else {
    await execFileAsync('tar', ['-xzf', pkgPath, '-C', stagingDir, '--strip-components=1'])
  }
}

/** 切 current：Linux 临时软链 rename 原子覆盖；Windows 目录联接（先删旧联接再建，联接删除不影响目标目录） */
async function switchCurrent(root: string, versionDirName: string): Promise<string> {
  const cur = join(root, 'current')
  if (IS_WIN) {
    if (existsSync(cur)) await rmdir(cur).catch(async () => { await unlink(cur) })
    await symlink(join(root, versionDirName), cur, 'junction')
  } else {
    const tmpLink = join(root, `.current.${process.pid}`)
    await unlink(tmpLink).catch(() => {})
    await symlink(versionDirName, tmpLink)
    await rename(tmpLink, cur)
  }
  return cur
}

async function removeDir(full: string): Promise<void> {
  await rm(full, { recursive: true, force: true }).catch(() => {})
  if (existsSync(full) && !IS_WIN) await execFileAsync('sudo', ['-n', 'rm', '-rf', full]).catch(() => {})
}

export async function runUpdate(cfg: DeviceConfig, cmd: UpdateCommand): Promise<void> {
  const v = String(cmd.version || '').trim()
  if (inFlight) { console.warn('[ota] 已有更新在进行，忽略'); return }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) { await report(cfg, v || '?', 'failed', '版本号非法'); return }
  if (v === app.getVersion()) { await report(cfg, v, 'success', '已是该版本'); return }
  if (cmd.platform && cmd.platform !== localPlatformKey()) {
    await report(cfg, v, 'failed', `包平台 ${cmd.platform} 与本机 ${localPlatformKey()} 不符，拒绝`); return
  }
  const layout = installLayout()
  if (!layout.ok) {
    await report(cfg, v, 'failed', `非目录制安装（${app.isPackaged ? layout.versionDir : 'dev 模式'}），请用引导脚本重装后再 OTA`); return
  }
  if (!sameOrigin(cmd.url, cfg.serverUrl) || !sameOrigin(cmd.manifestUrl, cfg.serverUrl)) {
    await report(cfg, v, 'failed', '下载地址与 serverUrl 不同源，拒绝'); return
  }

  inFlight = true
  const { root, exeName } = layout
  const ext = cmd.url.endsWith('.zip') ? 'zip' : 'tar.gz'
  const work = join(configDir(), 'ota', v)
  const pkgPath = join(work, `fids-player-electron-${v}.${ext}`)
  const manPath = `${pkgPath}.manifest.json`
  const versionDirName = `fids-player-electron-${v}`
  const targetDir = join(root, versionDirName)
  const stagingDir = `${targetDir}.staging`
  try {
    mkdirSync(work, { recursive: true })
    await report(cfg, v, 'downloading', cmd.url)
    await download(cmd.manifestUrl, manPath, 64 * 1024)
    await download(cmd.url, pkgPath, 512 * 1024 * 1024)

    await report(cfg, v, 'verifying')
    const vr = verifyUpdatePackage(pkgPath, manPath)
    if (!vr.ok) throw new Error(`验签失败：${vr.reason}`)
    if (cmd.sha256 && cmd.sha256 !== vr.manifest.sha256) throw new Error('指令哈希与 manifest 不一致')

    await report(cfg, v, 'installing', targetDir)
    rmSync(stagingDir, { recursive: true, force: true })
    mkdirSync(stagingDir, { recursive: true })
    await extract(pkgPath, stagingDir)
    if (!existsSync(join(stagingDir, exeName))) throw new Error(`包内缺少可执行文件 ${exeName}`)
    if (!IS_WIN) {
      // chrome-sandbox 需 root:root 4755，否则 Electron 拒绝启动；无免密 sudo 则失败（部署时配置 NOPASSWD）
      try {
        await execFileAsync('sudo', ['-n', 'chown', 'root:root', join(stagingDir, 'chrome-sandbox')])
        await execFileAsync('sudo', ['-n', 'chmod', '4755', join(stagingDir, 'chrome-sandbox')])
      } catch (e) {
        throw new Error(`设置 chrome-sandbox 权限失败（需要免密 sudo）：${(e as Error).message}`)
      }
    }
    rmSync(targetDir, { recursive: true, force: true })
    await rename(stagingDir, targetDir)
    const cur = await switchCurrent(root, versionDirName)
    // 清理：只留 current 指向的新版 + 版本号最高的一个旧版（当前正在运行的这个不删，留作回滚）
    try {
      const dirs = (await readdir(root)).filter((d) => /^fids-player-electron-\d/.test(d) && d !== versionDirName && !d.endsWith('.staging'))
      dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      for (const d of dirs.slice(0, -1)) await removeDir(join(root, d))
    } catch { /* 清理失败不影响更新 */ }
    await rm(work, { recursive: true, force: true }).catch(() => {})

    await report(cfg, v, 'restarting', '新进程以 current 路径拉起')
    const child = spawn(join(cur, exeName), process.argv.slice(1), {
      detached: true, stdio: 'ignore', windowsHide: false,
      env: { ...process.env, FIDS_OTA_JUST_UPDATED: v },
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
