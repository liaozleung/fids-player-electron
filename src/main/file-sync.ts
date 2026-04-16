import { createHash } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { cacheDir } from './config'

export interface FileEntry {
  url: string
  path: string
  md5: string
}

/** 同步文件列表 — 只下载 MD5 不匹配的文件 */
export async function syncFiles(fileList: FileEntry[], serverUrl: string): Promise<string[]> {
  const cache = cacheDir()
  if (!existsSync(cache)) {
    mkdirSync(cache, { recursive: true })
  }

  const synced: string[] = []

  for (const entry of fileList) {
    const localPath = join(cache, entry.path)

    // 检查本地文件 MD5
    if (existsSync(localPath)) {
      const localMd5 = computeMd5(localPath)
      if (localMd5 === entry.md5) {
        console.debug('文件未变化，跳过:', entry.path)
        continue
      }
    }

    // 构建下载 URL
    const url = entry.url.startsWith('http') ? entry.url : `${serverUrl}${entry.url}`
    console.log(`下载文件: ${url} -> ${entry.path}`)

    try {
      await downloadFile(url, localPath)

      // 校验下载后的 MD5
      const downloadedMd5 = computeMd5(localPath)
      if (downloadedMd5 !== entry.md5) {
        console.warn(`文件 MD5 校验失败: ${entry.path} (期望 ${entry.md5}, 实际 ${downloadedMd5})`)
        unlinkSync(localPath)
        continue
      }

      synced.push(entry.path)
      console.log('文件同步成功:', entry.path)
    } catch (e) {
      console.error(`下载文件失败 ${entry.path}:`, e)
    }
  }

  return synced
}

/** 下载单个文件 */
async function downloadFile(url: string, localPath: string): Promise<void> {
  const dir = dirname(localPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`)
  }

  const buffer = Buffer.from(await resp.arrayBuffer())
  writeFileSync(localPath, buffer)
}

/** 计算文件 MD5 */
function computeMd5(filePath: string): string {
  const data = readFileSync(filePath)
  return createHash('md5').update(data).digest('hex')
}
