import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'fs'
import { join } from 'path'
import { configDir } from './config'

/**
 * 文件日志：劫持 console.log/info/warn/error，在保留原控制台输出的同时把日志追加到
 *   {configDir}/logs/player.log
 * Windows GUI 应用默认无控制台，只能靠文件日志诊断远程控制失败原因
 */

const LOG_DIR = join(configDir(), 'logs')
const LOG_FILE = join(LOG_DIR, 'player.log')
const MAX_SIZE = 5 * 1024 * 1024 // 5MB 后滚动一次

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(LOG_FILE)) return
    const st = statSync(LOG_FILE)
    if (st.size < MAX_SIZE) return
    const rotated = join(LOG_DIR, `player.${Date.now()}.log`)
    renameSync(LOG_FILE, rotated)
  } catch {
    // 滚动失败不致命，继续追加
  }
}

function format(level: string, args: unknown[]): string {
  const ts = new Date().toISOString()
  const msg = args
    .map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack || ''}`
      if (typeof a === 'object') {
        try { return JSON.stringify(a) } catch { return String(a) }
      }
      return String(a)
    })
    .join(' ')
  return `[${ts}] [${level}] ${msg}\n`
}

function write(level: string, args: unknown[]): void {
  try {
    ensureLogDir()
    rotateIfNeeded()
    appendFileSync(LOG_FILE, format(level, args), 'utf-8')
  } catch {
    // 日志写失败不能阻塞应用
  }
}

let installed = false

/** 挂钩 console，并启动一条分隔线表明本次启动 */
export function installFileLogger(): void {
  if (installed) return
  installed = true
  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  }

  console.log = (...args: unknown[]) => { write('LOG', args); orig.log(...args) }
  console.info = (...args: unknown[]) => { write('INFO', args); orig.info(...args) }
  console.warn = (...args: unknown[]) => { write('WARN', args); orig.warn(...args) }
  console.error = (...args: unknown[]) => { write('ERROR', args); orig.error(...args) }

  // 捕获进程级未处理异常
  process.on('uncaughtException', (err) => {
    write('FATAL', ['uncaughtException:', err])
  })
  process.on('unhandledRejection', (reason) => {
    write('FATAL', ['unhandledRejection:', reason])
  })

  write('INFO', [
    '=== fids-player-electron 启动 ===',
    `platform=${process.platform}`,
    `arch=${process.arch}`,
    `pid=${process.pid}`,
    `logFile=${LOG_FILE}`,
  ])
}

/** 返回日志文件绝对路径，供调试显示 */
export function logFilePath(): string {
  return LOG_FILE
}
