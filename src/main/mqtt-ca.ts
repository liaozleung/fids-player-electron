import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { configDir } from './config'

/**
 * 内部 CA 证书获取（可信通信 v4 第一波 / R03，2026-09-09）。
 *
 * MQTT 端口为 8883 时启用 TLS，CA 从 fids 静态分发端点自取：
 *   {serverUrl}/uploads/fids-ca.crt → 缓存到 configDir()/fids-ca.crt
 * CA 是公钥，明文 HTTP 拉取无泄密问题；首次获取的真实性由部署波次
 * （内网 + 管理端发起）保证，此后固定使用本地缓存（TOFU 语义），
 * 换 CA 需删除缓存文件或运维下发。
 */
const CA_FILE = 'fids-ca.crt'

export function cachedCaPath(): string {
  return join(configDir(), CA_FILE)
}

/** 读本地缓存的 CA（无则返回 null） */
export function loadCaSync(): Buffer | null {
  try {
    const p = cachedCaPath()
    if (existsSync(p)) return readFileSync(p)
  } catch (e) {
    console.warn('[mqtt-ca] 读取本地 CA 失败:', (e as Error).message)
  }
  return null
}

/** 从 fids 下载 CA 并缓存；成功返回 true */
export async function fetchAndCacheCa(serverUrl: string): Promise<boolean> {
  try {
    const url = `${serverUrl.replace(/\/$/, '')}/uploads/${CA_FILE}`
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!resp.ok) {
      console.warn(`[mqtt-ca] 下载 CA 失败 HTTP ${resp.status}: ${url}`)
      return false
    }
    const pem = await resp.text()
    if (!pem.includes('BEGIN CERTIFICATE')) {
      console.warn('[mqtt-ca] 下载内容不是 PEM 证书，忽略')
      return false
    }
    writeFileSync(cachedCaPath(), pem, 'utf-8')
    console.log('[mqtt-ca] CA 已缓存到', cachedCaPath())
    return true
  } catch (e) {
    console.warn('[mqtt-ca] 下载 CA 异常:', (e as Error).message)
    return false
  }
}
