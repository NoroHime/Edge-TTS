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

/** 用于生成 Sec-MS-GEC 校验令牌的 Chromium 版本号。 */
export const CHROMIUM_FULL_VERSION = '130.0.2849.68'
export const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`

/** WebSocket 合成地址（浏览器无法自定义请求头，只能靠查询参数）。 */
export const WSS_URL =
  `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`

/** 音色列表 HTTP 接口。 */
export const VOICE_LIST_URL =
  `https://${BASE_URL}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`

/** 输出音频格式：24kHz / 48kbps 单声道 MP3，浏览器可直接播放。 */
export const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'

/** 单次 SSML 请求的最大字节数（服务端限制）。 */
export const MAX_SSML_BYTE_LENGTH = 4096

/** 播放“结束”判定容差，等价于 Python 版的 duration - 200 毫秒。 */
export const END_OF_MEDIA_TOLERANCE_MS = 200
