/**
 * 常量定义。
 *
 * 这里是 tts_backends.py 里 Edge TTS 相关常量的 TypeScript 版本，
 * 同时补上了浏览器端合成需要的 Microsoft Edge 在线服务参数。
 */

/** 引擎 ID（原 Python 版有 edge / melo，这里只保留 Edge）。 */
export const ENGINE_EDGE = 'edge'

/** Edge TTS 参数：与 Python 版保持一致。 */
export const EDGE_TIMEOUT_SECONDS = 60.0
export const EDGE_MAX_ATTEMPTS = 3
export const EDGE_RETRY_DELAY_SECONDS = 1.0

/** 默认文本分段长度（与 Python 版一致）。 */
export const DEFAULT_MAX_CHARS = 500
export const DEFAULT_MIN_CHARS = 480
export const DEFAULT_PLAYBACK_RATE = 1.1
export const DEFAULT_PAUSE_MS = 80

/* ------------------------------------------------------------------ */
/* Microsoft Edge 在线语音合成服务参数                                 */
/* ------------------------------------------------------------------ */

const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud'

/**
 * Edge 浏览器内置的“可信客户端令牌”。
 *
 * 这是公开的固定值（Edge 浏览器自身就带着它），不是账号密钥；
 * 但它是微软的非公开接口，随时可能被改动或封禁。
 */
export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'

/**
 * 用于生成 Sec-MS-GEC 校验令牌的 Chromium 版本号。
 *
 * 必须跟随 edge-tts 上游的取值更新：服务端会校验这个版本号，
 * 版本太旧会直接 403。当前与 edge-tts 7.2.8 一致。
 */
export const CHROMIUM_FULL_VERSION = '143.0.3650.75'
export const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`

/**
 * WebSocket 合成地址。
 *
 * ⚠️ 关键限制：微软的合成服务在**握手阶段强制要求 User-Agent 头**，
 * 而浏览器的 WebSocket API 不允许页面设置 User-Agent
 * （User-Agent 是禁用头，见 HTML 规范的 forbidden header name 列表）。
 *
 * 实测结果（curl / Node 直连同一台机器）：
 *   带 User-Agent      → 101 Switching Protocols
 *   不带 User-Agent    → 403 Forbidden
 *
 * 所以在 Chrome / Firefox / Safari / 手机浏览器里，**直连必然失败**；
 * 桌面 Edge 能用，是因为 Edge 自己在握手时带了正确的 User-Agent。
 *
 * 解决办法：通过一个能补 User-Agent 的服务端中转（WebSocket 代理），
 * 见 `proxy/cloudflare-worker.js`。把代理地址填到
 * `VITE_EDGE_TTS_PROXY` 环境变量里即可（见下方 WSS_URL / PROXY_URL）。
 */
export const UPSTREAM_WSS_URL =
  `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`

/**
 * 可选的代理地址（不带路径，例如 `wss://edge-tts-proxy.xxx.workers.dev`）。
 *
 * 在项目根目录建一个 `.env.local`：
 *
 *   VITE_EDGE_TTS_PROXY=wss://你的-worker.workers.dev
 *
 * 构建时就会被写进产物。留空则直连（只有桌面 Edge 能用）。
 */
export const PROXY_URL = (
  (import.meta.env?.VITE_EDGE_TTS_PROXY as string | undefined) ?? ''
).trim()

/** 当前实际使用的合成地址。 */
export const WSS_URL = PROXY_URL ? `${PROXY_URL}/edge/v1` : UPSTREAM_WSS_URL

/** 是否配置了代理。 */
export const USING_PROXY = PROXY_URL.length > 0

/** 音色列表 HTTP 接口。 */
export const VOICE_LIST_URL =
  `https://${BASE_URL}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`

/** 输出音频格式：24kHz / 48kbps 单声道 MP3，浏览器可直接播放。 */
export const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'

/** 单次 SSML 请求的最大字节数（服务端限制）。 */
export const MAX_SSML_BYTE_LENGTH = 4096

/** 播放“结束”判定容差，等价于 Python 版的 duration - 200 毫秒。 */
export const END_OF_MEDIA_TOLERANCE_MS = 200
