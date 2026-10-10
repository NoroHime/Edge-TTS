/**
 * 音色管理。
 *
 * 对应 Python 版 GUI_QWENv6.pyw 的 EDGE_VOICE_OPTIONS，
 * 并额外支持在浏览器里拉取微软的完整音色列表。
 */

import { VOICE_LIST_URL } from './constants.ts'

export interface VoiceOption {
  /** 传给 TTS 服务的音色 ID。 */
  id: string
  /** 界面显示名。 */
  name: string
  /** 性别标注。 */
  gender: string
}

/**
 * 默认内置的 6 个中文音色（与 Python 版完全一致）。
 */
export const EDGE_VOICE_OPTIONS: VoiceOption[] = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: '女' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', gender: '女' },
  { id: 'zh-CN-YunjianNeural', name: '云健', gender: '男' },
  { id: 'zh-CN-YunxiNeural', name: '云希', gender: '男' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', gender: '男' },
  { id: 'zh-CN-YunyangNeural', name: '云扬', gender: '男' },
]

export const DEFAULT_VOICE = EDGE_VOICE_OPTIONS[0].id

interface RawVoice {
  ShortName?: string
  Gender?: string
  Locale?: string
  FriendlyName?: string
}

/**
 * 从微软接口拉取音色列表。
 *
 * 注意：这个接口只有 HTTP 版本，如果页面通过 HTTPS 打开
 * （GitHub Pages 就是 HTTPS），浏览器会因为混合内容而拦截请求。
 * 这种情况下函数会抛错，界面继续使用内置音色列表。
 */
export async function fetchVoiceList(): Promise<VoiceOption[]> {
  const response = await fetch(VOICE_LIST_URL)

  if (!response.ok) {
    throw new Error(`音色列表接口返回 HTTP ${response.status}`)
  }

  const raw = (await response.json()) as RawVoice[]

  if (!Array.isArray(raw)) {
    throw new Error('音色列表格式不正确。')
  }

  const voices: VoiceOption[] = []

  for (const item of raw) {
    const id = (item.ShortName || '').trim()

    if (!id) {
      continue
    }

    const genderRaw = (item.Gender || '').trim()
    const gender =
      genderRaw === 'Female' ? '女' : genderRaw === 'Male' ? '男' : '—'

    // FriendlyName 形如 "Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)"
    const friendly = (item.FriendlyName || '').trim()
    const shortName = friendly
      .replace(/^Microsoft\s+/, '')
      .replace(/\s+Online.*$/, '')
      .trim()

    voices.push({
      id,
      name: shortName || id,
      gender,
    })
  }

  voices.sort((a, b) => a.id.localeCompare(b.id))

  return voices
}
