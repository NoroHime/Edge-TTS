/**
 * 通用工具函数。
 *
 * 对应 Python 版 GUI_QWENv6.pyw 里的：
 *   console_print / format_time / preview_text / read_text_file
 */

/** 极简日志：写控制台与页面日志（由 UI 层订阅）。 */
type LogSink = (text: string) => void

const logSinks = new Set<LogSink>()

export function onLog(sink: LogSink): () => void {
  logSinks.add(sink)
  return () => logSinks.delete(sink)
}

/** 等价于 Python 的 console_print：写控制台，失败也不抛错。 */
export function consolePrint(text: string): void {
  try {
    // eslint-disable-next-line no-console
    console.log(text)
  } catch {
    /* 忽略 */
  }

  for (const sink of logSinks) {
    try {
      sink(text)
    } catch {
      /* 忽略 */
    }
  }
}

/** 把毫秒格式化为 mm:ss 或 hh:mm:ss。 */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  const pad = (value: number) => String(value).padStart(2, '0')

  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  }

  return `${pad(minutes)}:${pad(seconds)}`
}

/** 生成片段列表里的短预览文本。 */
export function previewText(text: string, length = 36): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  if (flat.length > length) {
    return flat.slice(0, length) + '……'
  }

  return flat
}

/**
 * 读取 TXT 文件，尽量兼容常见中文编码。
 *
 * 浏览器端的 TextDecoder 原生支持 utf-8 / gbk / gb18030，
 * 因此这里的逻辑与 Python 版 read_text_file 等价。
 */
export async function readTextFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()

  const encodings = ['utf-8', 'gb18030', 'gbk', 'big5']

  for (const encoding of encodings) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer)
    } catch {
      /* 换下一种编码 */
    }
  }

  // 与 Python 版一致：全部失败时用 utf-8 + replace。
  return new TextDecoder('utf-8').decode(buffer)
}

/** 触发浏览器下载。 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()

  // 稍后回收，确保下载已经开始。
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** 异步等待。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 当前时间戳字符串，用于导出文件名。 */
export function timestampForFilename(): string {
  const now = new Date()
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')

  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}
