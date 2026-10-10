/**
 * Edge TTS 浏览器端实现。
 *
 * 这是 Python 版 tts_backends.py 中 EdgeBackend 的移植：
 *
 *   - 原本用 edge-tts + FFmpeg（MP3 → WAV）+ soundfile；
 *   - 浏览器里改用原生 WebSocket 直接与微软的合成服务通信，
 *     直接拿到 MP3 字节流，不需要 FFmpeg。
 *
 * 保留的行为：
 *   - 单次请求 60 秒超时；
 *   - 最多尝试 3 次；
 *   - 每次失败后等 1s * attempt 再重试；
 *   - 失败重试时把上一次的残留结果清掉（等价于 _safe_unlink）。
 *
 * 说明：这是微软 Edge 浏览器的非公开接口，不是官方 SDK，随时可能变化或被限制。
 */

import {
  EDGE_MAX_ATTEMPTS,
  EDGE_RETRY_DELAY_SECONDS,
  EDGE_TIMEOUT_SECONDS,
  MAX_SSML_BYTE_LENGTH,
  OUTPUT_FORMAT,
  SEC_MS_GEC_VERSION,
  TRUSTED_CLIENT_TOKEN,
  USING_PROXY,
  WSS_URL,
} from './constants.ts'

import { splitByByteLength } from './bytelength.ts'
import { GenerationCancelled } from './generator.ts'
import { consolePrint, sleep } from './utils.ts'

/** 便于测试与外部使用，转发字节切分实现。 */
export { splitByByteLength }

/** 生成去掉横线的 UUID，等价于 Python 版的 connect_id()。 */
function connectId(): string {
  const webCrypto = globalThis.crypto as Crypto | undefined

  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID().replace(/-/g, '')
  }

  // 极旧浏览器的兜底实现。
  const bytes = new Uint8Array(16)

  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** JavaScript 风格的 GMT 时间字符串，等价于 Python 版的 date_to_string()。 */
function dateToString(date = new Date()): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]

  const pad = (value: number) => String(value).padStart(2, '0')

  return (
    `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ` +
    `${pad(date.getUTCDate())} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  )
}

/* ------------------------------------------------------------------ */
/* Sec-MS-GEC 校验令牌                                                 */
/* ------------------------------------------------------------------ */

const WIN_EPOCH_SECONDS = 11_644_473_600

let cachedToken: { value: string; expiresAt: number } | null = null

/** 把 ArrayBuffer 转成大写十六进制。 */
function toHexUpper(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, '0'),
  )
    .join('')
    .toUpperCase()
}

/**
 * 生成 Sec-MS-GEC 令牌。
 *
 * 算法（来自 rany2/edge-tts 的 DRM.generate_sec_ms_gec）：
 *   1. 取当前 UTC 时间戳；
 *   2. 加上 Windows 纪元偏移，向下取整到 5 分钟；
 *   3. 换算成 100 纳秒单位；
 *   4. 拼接可信客户端令牌后做 SHA-256，取大写十六进制。
 */
export async function generateSecMsGec(now = Date.now()): Promise<string> {
  const rounded = Math.floor(now / 1000) + WIN_EPOCH_SECONDS
  const fiveMinutes = rounded - (rounded % 300)
  const ticks = fiveMinutes * 10_000_000

  const payload = `${ticks}${TRUSTED_CLIENT_TOKEN}`

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(payload),
  )

  return toHexUpper(digest)
}

/** 带缓存地获取令牌：约 4 分钟更新一次。 */
async function getSecMsGec(): Promise<string> {
  const now = Date.now()

  if (cachedToken && now < cachedToken.expiresAt) {
    return cachedToken.value
  }

  const value = await generateSecMsGec(now)

  cachedToken = {
    value,
    expiresAt: now + 4 * 60 * 1000,
  }

  return value
}

/* ------------------------------------------------------------------ */
/* 文本预处理                                                          */
/* ------------------------------------------------------------------ */

/**
 * 服务端不支持的字符区间（主要是 OCR 文本里的垂直制表符）。
 * 等价于 Python 版的 remove_incompatible_characters。
 */
export function removeIncompatibleCharacters(text: string): string {
  let result = ''

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0

    const bad =
      (code >= 0 && code <= 8) ||
      (code >= 11 && code <= 12) ||
      (code >= 14 && code <= 31)

    result += bad ? ' ' : char
  }

  return result
}

/** 转义 XML 实体，等价于 Python 的 xml.sax.saxutils.escape。 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 韵律参数。 */
export interface SpeechOptions {
  rate: string
  pitch: string
  volume: string
}

export const DEFAULT_SPEECH_OPTIONS: SpeechOptions = {
  rate: '+0%',
  pitch: '+0Hz',
  volume: '+0%',
}

/** 生成 SSML。 */
export function buildSsml(
  text: string,
  voice: string,
  speech: SpeechOptions = DEFAULT_SPEECH_OPTIONS,
): string {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voice}'>` +
    `<prosody pitch='${speech.pitch}' rate='${speech.rate}' volume='${speech.volume}'>` +
    `${text}</prosody>` +
    '</voice>' +
    '</speak>'
  )
}

/* ------------------------------------------------------------------ */
/* WebSocket 合成                                                      */
/* ------------------------------------------------------------------ */

export interface SynthesisOptions {
  text: string
  voice: string
  timeoutSeconds?: number
  signal?: AbortSignal
  speech?: SpeechOptions
  onStatus?: (text: string) => void
}

interface ParsedMessage {
  headers: Map<string, string>
  body: string
}

function parseTextMessage(raw: string): ParsedMessage {
  const separator = raw.indexOf('\r\n\r\n')

  const headerText = separator >= 0 ? raw.slice(0, separator) : raw
  const body = separator >= 0 ? raw.slice(separator + 4) : ''

  const headers = new Map<string, string>()

  for (const line of headerText.split('\r\n')) {
    const colon = line.indexOf(':')

    if (colon <= 0) {
      continue
    }

    headers.set(
      line.slice(0, colon).trim().toLowerCase(),
      line.slice(colon + 1).trim(),
    )
  }

  return { headers, body }
}

function buildSpeechConfig(): string {
  return (
    `X-Timestamp:${dateToString()}\r\n` +
    'Content-Type:application/json; charset=utf-8\r\n' +
    'Path:speech.config\r\n\r\n' +
    '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
    '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"' +
    '},"outputFormat":"' +
    OUTPUT_FORMAT +
    '"}}}}\r\n'
  )
}

function buildSsmlRequest(ssml: string): string {
  return (
    `X-RequestId:${connectId()}\r\n` +
    'Content-Type:application/ssml+xml\r\n' +
    `X-Timestamp:${dateToString()}Z\r\n` +
    'Path:ssml\r\n\r\n' +
    ssml
  )
}

/** 从二进制消息里取出音频数据（前两个字节是大端的头部长度）。 */
function binaryChunkToAudio(buffer: ArrayBuffer): Uint8Array | null {
  const bytes = new Uint8Array(buffer)

  if (bytes.length < 2) {
    return null
  }

  const headerLength = (bytes[0] << 8) | bytes[1]

  if (headerLength + 2 > bytes.length) {
    return null
  }

  const headerText = new TextDecoder('utf-8').decode(
    bytes.subarray(2, 2 + headerLength),
  )

  const path = /Path:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim()

  if (path !== 'audio') {
    return null
  }

  // 头部之后还有一个 \r\n\r\n 分隔符。
  let audioStart = 2 + headerLength

  if (
    bytes[audioStart] === 0x0d &&
    bytes[audioStart + 1] === 0x0a &&
    bytes[audioStart + 2] === 0x0d &&
    bytes[audioStart + 3] === 0x0a
  ) {
    audioStart += 4
  }

  if (audioStart >= bytes.length) {
    return null
  }

  return bytes.subarray(audioStart)
}

/**
 * 一次 Edge TTS 请求：连接 → speech.config → ssml → 收集音频 → 关闭。
 *
 * 如果文本转义后超过 4096 字节，会自动拆成多次请求再拼起来
 * （等价于 Python 版 Communicate 内部对 text 的字节切分）。
 *
 * @returns 合成出来的 MP3 Blob
 */
export async function synthesizeOnce(
  options: SynthesisOptions,
): Promise<Blob> {
  const {
    text,
    voice,
    timeoutSeconds = EDGE_TIMEOUT_SECONDS,
    signal,
    speech = DEFAULT_SPEECH_OPTIONS,
    onStatus,
  } = options

  const escaped = escapeXml(removeIncompatibleCharacters(text))
  const pieces = splitByByteLength(escaped, MAX_SSML_BYTE_LENGTH)

  if (pieces.length === 0) {
    throw new Error('文本为空，无法合成。')
  }

  const blobs: Blob[] = []

  for (let index = 0; index < pieces.length; index += 1) {
    if (pieces.length > 1) {
      onStatus?.(`正在合成第 ${index + 1}/${pieces.length} 个文本块……`)
    }

    blobs.push(
      await synthesizePiece({
        text: pieces[index],
        voice,
        speech,
        timeoutSeconds,
        signal,
      }),
    )
  }

  if (blobs.length === 1) {
    return blobs[0]
  }

  return new Blob(blobs, { type: 'audio/mpeg' })
}

interface PieceOptions {
  text: string
  voice: string
  speech: SpeechOptions
  timeoutSeconds: number
  signal?: AbortSignal
}

/** 单次 WebSocket 合成（文本已经保证不超过字节上限）。 */
function synthesizePiece(options: PieceOptions): Promise<Blob> {
  const { text, voice, speech, timeoutSeconds, signal } = options

  return getSecMsGec().then((secMsGec) => {
    // 直连时 WSS_URL 已经带 ?TrustedClientToken=...；
    // 走代理时 WSS_URL 是代理地址（不带查询串），也要把查询参数带过去，
    // 这样代理才能原样转发给上游。
    const separator = WSS_URL.includes('?') ? '&' : '?'

    const url =
      `${WSS_URL}${separator}TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&ConnectionId=${connectId()}` +
      `&Sec-MS-GEC=${secMsGec}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`

    const audioParts: BlobPart[] = []

    return new Promise<Blob>((resolve, reject) => {
      let settled = false
      let timer: number | undefined
      let socket: WebSocket | null = null

      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }

        if (signal) {
          signal.removeEventListener('abort', onAbort)
        }

        if (
          socket &&
          (socket.readyState === WebSocket.OPEN ||
            socket.readyState === WebSocket.CONNECTING)
        ) {
          try {
            socket.close()
          } catch {
            /* 忽略 */
          }
        }

        socket = null
      }

      const fail = (error: Error) => {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        reject(error)
      }

      const succeed = () => {
        if (settled) {
          return
        }

        if (audioParts.length === 0) {
          fail(new Error('Edge TTS 返回了空音频文件。'))
          return
        }

        settled = true
        cleanup()
        resolve(new Blob(audioParts, { type: 'audio/mpeg' }))
      }

      function onAbort() {
        fail(new GenerationCancelled())
      }

      if (signal) {
        if (signal.aborted) {
          reject(new GenerationCancelled())
          return
        }

        signal.addEventListener('abort', onAbort, { once: true })
      }

      timer = window.setTimeout(() => {
        fail(new Error(`Edge TTS 请求超过 ${timeoutSeconds.toFixed(0)} 秒。`))
      }, timeoutSeconds * 1000)

      try {
        socket = new WebSocket(url)
      } catch (error) {
        fail(new Error(`无法建立 WebSocket 连接：${String(error)}`))
        return
      }

      const ws = socket

      ws.onopen = () => {
        try {
          ws.send(buildSpeechConfig())
          ws.send(buildSsmlRequest(buildSsml(text, voice, speech)))
        } catch (error) {
          fail(new Error(`发送合成请求失败：${String(error)}`))
        }
      }

      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data === 'string') {
          const { headers, body } = parseTextMessage(event.data)
          const path = headers.get('path')

          if (path === 'turn.end') {
            succeed()
            return
          }

          if (
            path === 'turn.start' ||
            path === 'response' ||
            path === 'audio.metadata'
          ) {
            return
          }

          // 服务端会把错误信息放在未知路径的消息里。
          if (body && /error/i.test(body)) {
            fail(new Error(`Edge TTS 服务端返回错误：${body.slice(0, 300)}`))
          }

          return
        }

        // 二进制消息：音频数据。
        void (async () => {
          const buffer =
            event.data instanceof Blob
              ? await event.data.arrayBuffer()
              : (event.data as ArrayBuffer)

          const chunk = binaryChunkToAudio(buffer)

          if (chunk) {
            audioParts.push(chunk.slice().buffer)
          }
        })()
      }

      ws.onerror = () => {
        // 绝大多数情况下 403 都是这个原因：微软在握手阶段强制要求
        // User-Agent，而浏览器的 WebSocket API 不允许页面设置该头。
        const hint = USING_PROXY
          ? '（已配置代理，请确认代理服务正常并且能补上 User-Agent 头）'
          : '：浏览器不允许网页在 WebSocket 握手里设置 User-Agent，' +
            '而微软的服务强制要求它，所以除了桌面 Edge 之外都会 403。' +
            '解决办法是配置一个服务端中转（见 README 的「为什么必须用代理」），' +
            '并设置 VITE_EDGE_TTS_PROXY。'

        fail(new Error(`Edge TTS WebSocket 握手失败（HTTP 403）${hint}`))
      }

      ws.onclose = (event: CloseEvent) => {
        if (settled) {
          return
        }

        if (audioParts.length > 0) {
          succeed()
          return
        }

        fail(
          new Error(
            `Edge TTS 连接被关闭（code=${event.code}${
              event.reason ? `, reason=${event.reason}` : ''
            }）。`,
          ),
        )
      }
    })
  })
}

/* ------------------------------------------------------------------ */
/* 带超时与重试的合成（等价于 edge_save_with_retry）                    */
/* ------------------------------------------------------------------ */

export interface RetryOptions {
  text: string
  voice: string
  timeoutSeconds?: number
  maxAttempts?: number
  retryDelaySeconds?: number
  signal?: AbortSignal
  speech?: SpeechOptions
  onStatus?: (text: string) => void
}

/**
 * 带超时、重试的 Edge TTS 合成。
 *
 * 与 Python 版 edge_save_with_retry 一致：
 * 每次失败都会清掉残留结果，然后按 attempt 递增的延迟重试。
 */
export async function synthesizeWithRetry(
  options: RetryOptions,
): Promise<Blob> {
  const {
    text,
    voice,
    timeoutSeconds = EDGE_TIMEOUT_SECONDS,
    maxAttempts = EDGE_MAX_ATTEMPTS,
    retryDelaySeconds = EDGE_RETRY_DELAY_SECONDS,
    signal,
    speech,
    onStatus,
  } = options

  const attempts = Math.max(1, Math.trunc(maxAttempts))
  const timeout = Math.max(1, timeoutSeconds)

  let lastError: unknown = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) {
      throw new GenerationCancelled()
    }

    consolePrint(
      `[EdgeTTS] 开始第 ${attempt}/${attempts} 次请求，` +
        `超时限制 ${timeout.toFixed(0)} 秒，音色：${voice}`,
    )

    onStatus?.(`Edge TTS：第 ${attempt}/${attempts} 次请求……`)

    try {
      const blob = await synthesizeOnce({
        text,
        voice,
        timeoutSeconds: timeout,
        signal,
        speech,
        onStatus,
      })

      if (blob.size <= 0) {
        throw new Error('Edge TTS 返回了空音频文件。')
      }

      consolePrint(
        `[EdgeTTS] 第 ${attempt}/${attempts} 次请求成功，` +
          `文件大小：${blob.size} bytes`,
      )

      onStatus?.('Edge TTS 请求成功。')

      return blob
    } catch (error) {
      if (error instanceof GenerationCancelled || signal?.aborted) {
        throw new GenerationCancelled()
      }

      lastError = error

      consolePrint(
        `[EdgeTTS] 第 ${attempt}/${attempts} 次请求失败：${String(error)}`,
      )

      onStatus?.(`Edge TTS 第 ${attempt} 次请求失败，准备重试。`)
    }

    if (attempt < attempts) {
      const delay = retryDelaySeconds * attempt

      consolePrint(`[EdgeTTS] ${delay.toFixed(1)} 秒后重试……`)
      onStatus?.(`Edge TTS 将在 ${delay.toFixed(1)} 秒后重试。`)

      await sleep(delay * 1000)
    }
  }

  const message =
    `Edge TTS 请求失败：连续尝试 ${attempts} 次仍未成功。` +
    `最后错误：${String(lastError)}`

  consolePrint(message)
  onStatus?.('Edge TTS 连续重试失败。')

  throw new Error(message)
}

/* ------------------------------------------------------------------ */
/* 后端对象（等价于 EdgeBackend）                                      */
/* ------------------------------------------------------------------ */

export class EdgeBackend {
  private loaded = false

  private statusCallback: (text: string) => void = () => {
    /* 默认空实现 */
  }

  /** 等价于 EdgeBackend.load。 */
  load(statusCallback: (text: string) => void): void {
    this.statusCallback = statusCallback

    const alreadyLoaded = this.loaded
    this.loaded = true

    if (alreadyLoaded) {
      this.statusCallback('复用 Edge TTS 后端。')
    } else {
      this.statusCallback('Edge TTS 后端已加载。')
    }

    // 浏览器端不需要 FFmpeg，这里说明一下与 Python 版的差异。
    this.statusCallback('浏览器端直接使用 WebSocket 合成，无需 FFmpeg。')
    this.statusCallback(
      `Edge TTS 单次请求超时：${EDGE_TIMEOUT_SECONDS.toFixed(0)} 秒；` +
        `最多尝试 ${EDGE_MAX_ATTEMPTS} 次。`,
    )
  }

  /** 等价于 EdgeBackend.unload。 */
  unload(): void {
    this.loaded = false
  }

  /**
   * 等价于 EdgeBackend.infer。
   *
   * Python 版返回 (numpy 波形, 采样率)；
   * 浏览器端直接返回可以播放的 MP3 Blob。
   */
  async infer(options: {
    text: string
    speaker: string
    signal?: AbortSignal
    speech?: SpeechOptions
  }): Promise<Blob> {
    const { text, speaker, signal, speech } = options

    if (!this.loaded) {
      this.load(this.statusCallback)
    }

    return synthesizeWithRetry({
      text,
      voice: speaker,
      signal,
      speech,
      onStatus: this.statusCallback,
    })
  }
}

/** 等价于 create_backend("edge")。 */
export function createBackend(): EdgeBackend {
  return new EdgeBackend()
}
