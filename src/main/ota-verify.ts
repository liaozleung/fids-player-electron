import { createHash, verify as cryptoVerify } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * OTA 更新包 ed25519 验签（安全整改 R09；2026-09-22 接入 fids_player_electron 并换入正式公钥）。
 *
 * 契约（与 fids/ops/ota-sign.mjs、fids services/ota.service.ts 一致）：
 * - 每个更新包旁挂 <file>.manifest.json：{ file, size, sha256, sig, algo, signedAt }
 * - sig = ed25519 私钥对 sha256 十六进制串（utf-8 字节）的签名，base64
 * - 终端：先核对包字节的 sha256，再用内嵌公钥验签；二者都过才允许安装。
 *   供应链任何一环被替换（下载源劫持 / 对象存储被改 / 服务端记录被改），验签即失败。
 *
 * 公钥由 fids/ops/ota-keygen.sh 生成（2026-09-22，私钥仅在签名机 ~/.fids-ota-keys）。
 * 私钥泄露 → 重新 keygen + 换这里的公钥发一版，此后旧私钥签的包全部失效。
 */
const OTA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAn0VC16TCBPG9BX1GRgEyMelfoQZgv+ab45d45ae3hYY=
-----END PUBLIC KEY-----`

export interface OtaManifest {
  file: string
  size: number
  sha256: string
  sig: string
  algo: string
  signedAt?: string
}

export type VerifyResult = { ok: true; manifest: OtaManifest } | { ok: false; reason: string }

export function parseManifestText(text: string): OtaManifest | null {
  try {
    const m = JSON.parse(text) as OtaManifest
    if (!m || typeof m !== 'object' || typeof m.sha256 !== 'string' || typeof m.sig !== 'string') return null
    return m
  } catch {
    return null
  }
}

/** 校验更新包文件与其 manifest（大小 + 哈希 + ed25519 签名），fail-closed */
export function verifyUpdatePackage(packagePath: string, manifestPath: string): VerifyResult {
  let manifest: OtaManifest | null
  try {
    manifest = parseManifestText(readFileSync(manifestPath, 'utf-8'))
  } catch (e) {
    return { ok: false, reason: `manifest 读取失败: ${(e as Error).message}` }
  }
  if (!manifest) return { ok: false, reason: 'manifest 解析失败或字段缺失' }
  if (manifest.algo !== 'ed25519-over-sha256hex') return { ok: false, reason: `不支持的签名算法: ${manifest.algo}` }

  let bytes: Buffer
  try {
    bytes = readFileSync(packagePath)
  } catch (e) {
    return { ok: false, reason: `更新包读取失败: ${(e as Error).message}` }
  }
  if (typeof manifest.size === 'number' && bytes.length !== manifest.size) {
    return { ok: false, reason: `更新包大小不符（manifest=${manifest.size} 实际=${bytes.length}）` }
  }
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== manifest.sha256) {
    return { ok: false, reason: `更新包哈希不符（manifest=${manifest.sha256.slice(0, 12)}… 实际=${actual.slice(0, 12)}…）` }
  }
  if (OTA_PUBLIC_KEY_PEM.includes('REPLACE_WITH')) return { ok: false, reason: 'OTA 公钥未配置，拒绝安装' }
  try {
    const valid = cryptoVerify(null, Buffer.from(manifest.sha256, 'utf-8'), OTA_PUBLIC_KEY_PEM, Buffer.from(manifest.sig, 'base64'))
    return valid ? { ok: true, manifest } : { ok: false, reason: 'ed25519 签名验证失败' }
  } catch (e) {
    return { ok: false, reason: `验签异常: ${(e as Error).message}` }
  }
}
