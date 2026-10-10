/**
 * 主程序（对应 Python 版 MainWindow）。
 *
 * 这里完整保留 Python 版的播放状态机语义：
 *
 *   - 生成与播放并行：第一段生成完就开始播，后续片段边生成边播；
 *   - 当前片段播完时，如果下一段已经生成就立刻播放；
 *   - 如果下一段还没生成，就进入“等待下一段”状态，生成后自动接上；
 *   - 播放到最后一段后停止，绝不回到第一段循环；
 *   - 单击片段 = 从该片段开始连续播放；
 *   - 上一段 / 下一段 / 停止 / 暂停继续 / 拖动进度；
 *   - 播放音量与播放速度只影响播放，不改动已生成的音频；
 *   - 全部生成完成后可以导出拼合好的 WAV。
 *
 * 调用方（main.ts）需要先把 template.ts 的界面渲染进 DOM。
 */

import { mergeBlobsToWav } from './audio.ts'
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MIN_CHARS,
  DEFAULT_PAUSE_MS,
  DEFAULT_PLAYBACK_RATE,
} from './constants.ts'
import { createBackend, type EdgeBackend, type SpeechOptions } from './edgeTts.ts'
import { generateSegments, type GeneratedSegment } from './generator.ts'
import { PlaybackController, type PlaybackState } from './playback.ts'
import { prepareChunks } from './splitter.ts'
import {
  DEFAULT_VOICE,
  EDGE_VOICE_OPTIONS,
  fetchVoiceList,
  type VoiceOption,
} from './voices.ts'
import {
  consolePrint,
  downloadBlob,
  formatTime,
  onLog,
  previewText,
  readTextFile,
  timestampForFilename,
} from './utils.ts'

/* ------------------------------------------------------------------ */
/* 片段与设置                                                          */
/* ------------------------------------------------------------------ */

interface SegmentInfo {
  index: number
  text: string
  blob: Blob
  durationMs: number
}

interface PersistedSettings {
  voice?: string
  rate?: string
  pitch?: string
  volume?: string
  maxChars?: number
  minChars?: number
  pauseMs?: number
  autoPlay?: boolean
  autoExport?: boolean
  playRate?: number
  playVolume?: number
  voiceSearch?: string
  instruction?: string
}

const STORAGE_KEY = 'edge-tts-web.settings.v1'

/** 完整音色列表的缓存键（拿到过 322 个之后就不用每次重新拉了）。 */
const VOICE_CACHE_KEY = 'edge-tts-web.voices.v1'

/** 音色搜索框的默认值：首次打开只显示中文音色。 */
const DEFAULT_VOICE_FILTER = 'zh'

interface CachedVoices {
  fetchedAt: number
  voices: VoiceOption[]
}

/** 读取缓存的完整音色列表；过期或损坏时返回 null。 */
function loadVoiceCache(maxAgeMs = 7 * 24 * 60 * 60 * 1000): VoiceOption[] | null {
  try {
    const raw = localStorage.getItem(VOICE_CACHE_KEY)

    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as CachedVoices

    if (
      typeof parsed?.fetchedAt !== 'number' ||
      !Array.isArray(parsed.voices) ||
      parsed.voices.length === 0 ||
      Date.now() - parsed.fetchedAt > maxAgeMs
    ) {
      localStorage.removeItem(VOICE_CACHE_KEY)
      return null
    }

    // 简单校验每条记录的字段，避免旧版本数据把界面搞崩。
    const voices = parsed.voices.filter(
      (voice) =>
        typeof voice?.id === 'string' &&
        voice.id.length > 0 &&
        typeof voice.name === 'string',
    )

    return voices.length > 0 ? voices : null
  } catch {
    return null
  }
}

/** 保存完整音色列表。 */
function saveVoiceCache(voices: VoiceOption[]): void {
  try {
    const payload: CachedVoices = { fetchedAt: Date.now(), voices }
    localStorage.setItem(VOICE_CACHE_KEY, JSON.stringify(payload))
  } catch {
    /* 配额满或隐私模式，忽略 */
  }
}

/** 取得元素并断言存在，避免到处写非空判断。 */
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id)

  if (!found) {
    throw new Error(`界面元素缺失：#${id}`)
  }

  return found as T
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export class NovelTtsApp {
  /* ---------------- 状态（对应 Python 版的实例属性） ---------------- */

  private textChunks: string[] = []

  private readonly segmentMap = new Map<number, SegmentInfo>()

  private segments: SegmentInfo[] = []

  private currentSegmentIndex = -1

  private generationActive = false

  private generationCompleted = false

  private sequenceMode = false

  private waitingForNext = false

  private manualStop = false

  private controller: AbortController | null = null

  private backend: EdgeBackend | null = null

  private exporting = false

  private seeking = false

  /** 当前展示在下拉框里的音色；点了「获取全部」之后会换成完整列表。 */
  private voices: VoiceOption[] = EDGE_VOICE_OPTIONS

  private allVoices: VoiceOption[] = EDGE_VOICE_OPTIONS

  private pendingVoice: string = DEFAULT_VOICE

  private readonly player: PlaybackController

  private readonly dom: ReturnType<typeof collectDom>

  constructor() {
    this.dom = collectDom()

    this.player = new PlaybackController({
      onStateChange: (state) => this.handlePlayerState(state),
      onProgress: (position, duration) =>
        this.handlePlayerProgress(position, duration),
      onEnded: (index) => this.handleSegmentEnded(index),
      onError: (message) => {
        this.stopWatch()
        this.sequenceMode = false
        this.waitingForNext = false
        this.setStatus(`播放失败：${message}`, true)
        consolePrint(`播放失败：${message}`)
      },
    })

    // 把 utils.consolePrint 的输出同时写进页面日志。
    onLog((text) => this.appendLog(text))

    const storedSettings = this.loadSettings()

    this.applySettings(storedSettings)

    // 如果之前拉取过完整音色列表，直接用缓存，不必重新请求。
    const cachedVoices = loadVoiceCache()

    if (cachedVoices) {
      this.allVoices = cachedVoices
      this.voices = cachedVoices
    }

    // 「生成第一段后自动开始播放」默认开启：只有在用户**显式**关过
    // （localStorage 里有 false）时才保持关闭。
    if (storedSettings.autoPlay === undefined) {
      this.dom.autoPlay.checked = true
    }

    this.bindEvents()
    this.rebuildVoiceOptions()
    this.updateCharCount()
    this.renderSegmentList()
    this.updateProgress(0, 0)
    this.updateControls()
    this.setStatus('就绪。请粘贴文本后点击“开始生成”。')

    this.appendLog('novel-tts Web · Edge TTS 已就绪。')
    this.appendLog(
      '提示：合成由微软在线服务完成，需要联网；接口为非公开接口，可能变更。',
    )
  }

  /* ---------------------------------------------------------------- */
  /* 事件绑定                                                          */
  /* ---------------------------------------------------------------- */

  private bindEvents(): void {
    const { dom } = this

    dom.start.addEventListener('click', () => void this.startGeneration())
    dom.stopGenerate.addEventListener('click', () => this.stopGeneration())

    dom.openTxt.addEventListener('click', () => dom.txtInput.click())
    dom.txtInput.addEventListener('change', () => void this.handleOpenTxt())
    dom.clearText.addEventListener('click', () => {
      dom.text.value = ''
      this.updateCharCount()
    })
    dom.text.addEventListener('input', () => this.updateCharCount())

    dom.maxChars.addEventListener('input', () => {
      const max = Number(dom.maxChars.value) || 500
      dom.minChars.max = String(max)

      if (Number(dom.minChars.value) > max) {
        dom.minChars.value = String(max)
      }

      this.saveSettings()
    })

    dom.minChars.addEventListener('input', () => this.saveSettings())
    dom.pause.addEventListener('input', () => this.saveSettings())

    dom.voice.addEventListener('change', () => {
      this.pendingVoice = dom.voice.value
      this.saveSettings()
    })

    dom.voiceFilter.addEventListener('input', () => {
      this.rebuildVoiceOptions()
      this.saveSettings()
    })

    dom.fetchVoices.addEventListener('click', () => void this.handleFetchVoices())

    dom.rate.addEventListener('change', () => this.saveSettings())
    dom.pitch.addEventListener('change', () => this.saveSettings())
    dom.volume.addEventListener('change', () => this.saveSettings())
    dom.autoPlay.addEventListener('change', () => this.saveSettings())
    dom.autoExport.addEventListener('change', () => this.saveSettings())

    dom.reset.addEventListener('click', () => this.resetSettings())
    dom.instruction.addEventListener('input', () => this.saveSettings())

    dom.segmentList.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>(
        '.segment-item',
      )

      if (!target) {
        return
      }

      this.handleSegmentClick(Number(target.dataset.index ?? '-1'))
    })

    dom.playAll.addEventListener('click', () => void this.playAll())
    dom.playPause.addEventListener('click', () => void this.togglePlayPause())
    dom.previous.addEventListener('click', () => void this.playPrevious())
    dom.next.addEventListener('click', () => void this.playNext())
    dom.stopPlay.addEventListener('click', () => this.stopPlayback())
    dom.exportWav.addEventListener('click', () => void this.exportAudio())

    dom.playVolume.addEventListener('input', () => {
      const value = Number(dom.playVolume.value)
      this.player.setVolume(value / 100)
      dom.playVolumeValue.textContent = `${value}%`
      this.saveSettings()
    })

    dom.playRate.addEventListener('input', () => {
      const value = Number(dom.playRate.value) / 100
      this.player.setRate(value)
      dom.playRateValue.textContent = `${value.toFixed(2)}x`
      this.saveSettings()
    })

    // 拖动进度条时暂停跟随，松手后跳转。
    dom.seek.addEventListener('pointerdown', () => {
      this.seeking = true
    })

    dom.seek.addEventListener('pointerup', () => {
      this.seeking = false

      const ratio = Number(dom.seek.value) / 1000
      const duration = this.player.mediaDurationMs

      if (duration > 0) {
        this.player.seek(ratio * duration)
      }
    })

    dom.seek.addEventListener('input', () => {
      if (!this.seeking) {
        return
      }

      const ratio = Number(dom.seek.value) / 1000
      const duration = this.player.mediaDurationMs

      dom.timeCurrent.textContent = formatTime(ratio * duration)
    })
  }

  /* ---------------------------------------------------------------- */
  /* 设置持久化                                                        */
  /* ---------------------------------------------------------------- */

  private loadSettings(): PersistedSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)

      if (!raw) {
        return {}
      }

      return JSON.parse(raw) as PersistedSettings
    } catch {
      return {}
    }
  }

  private saveSettings(): void {
    const { dom } = this

    const settings: PersistedSettings = {
      voice: dom.voice.value || this.pendingVoice,
      rate: dom.rate.value,
      pitch: dom.pitch.value,
      volume: dom.volume.value,
      maxChars: Number(dom.maxChars.value) || 500,
      minChars: Number(dom.minChars.value) || 0,
      pauseMs: Number(dom.pause.value) || 0,
      autoPlay: dom.autoPlay.checked,
      autoExport: dom.autoExport.checked,
      playRate: Number(dom.playRate.value) / 100,
      playVolume: Number(dom.playVolume.value),
      voiceSearch: dom.voiceFilter.value,
      instruction: dom.instruction.value,
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      /* 隐私模式下可能失败，忽略 */
    }
  }

  private applySettings(settings: PersistedSettings): void {
    const { dom } = this

    if (settings.rate) dom.rate.value = settings.rate
    if (settings.pitch) dom.pitch.value = settings.pitch
    if (settings.volume) dom.volume.value = settings.volume
    if (settings.maxChars) dom.maxChars.value = String(settings.maxChars)

    if (settings.minChars !== undefined) {
      dom.minChars.value = String(settings.minChars)
    }

    if (settings.pauseMs !== undefined) {
      dom.pause.value = String(settings.pauseMs)
    }

    if (settings.autoPlay !== undefined) {
      dom.autoPlay.checked = settings.autoPlay
    }

    if (settings.autoExport !== undefined) {
      dom.autoExport.checked = settings.autoExport
    }

    if (settings.voiceSearch !== undefined) {
      // 搜索词是用户自己设的（包括「故意清空」），照用。
      dom.voiceFilter.value = settings.voiceSearch
    } else {
      // 首次使用：默认只显示中文音色，避免 300+ 条英文音色淹没列表。
      dom.voiceFilter.value = DEFAULT_VOICE_FILTER
    }

    if (settings.instruction !== undefined) {
      dom.instruction.value = settings.instruction
    }

    const playRate = settings.playRate ?? DEFAULT_PLAYBACK_RATE
    dom.playRate.value = String(Math.round(playRate * 100))
    dom.playRateValue.textContent = `${playRate.toFixed(2)}x`
    this.player.setRate(playRate)

    const playVolume = settings.playVolume ?? 100
    dom.playVolume.value = String(playVolume)
    dom.playVolumeValue.textContent = `${playVolume}%`
    this.player.setVolume(playVolume / 100)

    dom.minChars.max = dom.maxChars.value

    this.pendingVoice = settings.voice ?? DEFAULT_VOICE
  }

  /**
   * 恢复默认设置。
   *
   * 对应 Python 版里每次启动都是默认值的状态：
   * 清掉 localStorage 里保存的设置，再把界面控件重置回默认值。
   */
  private resetSettings(): void {
    const { dom } = this

    try {
      localStorage.removeItem(STORAGE_KEY)
      localStorage.removeItem(VOICE_CACHE_KEY)
    } catch {
      /* 隐私模式下可能失败，忽略 */
    }

    // 音色：丢掉缓存的完整列表，回到内置的 6 个中文音色。
    this.allVoices = EDGE_VOICE_OPTIONS
    this.voices = EDGE_VOICE_OPTIONS

    // 分段与停顿。
    dom.maxChars.value = String(DEFAULT_MAX_CHARS)
    dom.minChars.value = String(DEFAULT_MIN_CHARS)
    dom.minChars.max = String(DEFAULT_MAX_CHARS)
    dom.pause.value = String(DEFAULT_PAUSE_MS)

    // 语音参数。
    dom.rate.value = '+0%'
    dom.pitch.value = '+0Hz'
    dom.volume.value = '+0%'

    // 自定义指令与音色搜索（搜索框回到默认的 zh）。
    dom.instruction.value = ''
    dom.voiceFilter.value = DEFAULT_VOICE_FILTER
    this.pendingVoice = DEFAULT_VOICE
    this.rebuildVoiceOptions()

    // 开关。
    dom.autoPlay.checked = true
    dom.autoExport.checked = false

    // 播放参数（语速只影响播放，不改动已生成的音频）。
    dom.playRate.value = String(Math.round(DEFAULT_PLAYBACK_RATE * 100))
    dom.playRateValue.textContent = `${DEFAULT_PLAYBACK_RATE.toFixed(2)}x`
    this.player.setRate(DEFAULT_PLAYBACK_RATE)

    dom.playVolume.value = '100'
    dom.playVolumeValue.textContent = '100%'
    this.player.setVolume(1)

    this.setStatus('已恢复默认设置。')
    this.appendLog('已恢复默认设置（localStorage 中的设置已清除）。')
  }

  /* ---------------------------------------------------------------- */
  /* 音色列表                                                          */
  /* ---------------------------------------------------------------- */

  private rebuildVoiceOptions(): void {
    const filter = this.dom.voiceFilter.value.trim().toLowerCase()

    const matched = filter
      ? this.allVoices.filter(
          (voice) =>
            voice.id.toLowerCase().includes(filter) ||
            voice.name.toLowerCase().includes(filter),
        )
      : this.voices

    // 有搜索但没匹配到时，不要偷偷回退成别的列表，而是明确显示「无匹配」。
    const list = filter ? matched : this.voices

    const previous = this.dom.voice.value || this.pendingVoice

    this.dom.voice.innerHTML = ''

    if (list.length === 0) {
      const option = document.createElement('option')
      option.value = ''
      option.textContent = '没有匹配的音色'
      option.disabled = true
      this.dom.voice.appendChild(option)
      this.dom.voice.value = ''
      return
    }

    for (const voice of list) {
      const option = document.createElement('option')
      option.value = voice.id
      option.textContent = `${voice.name}（${voice.gender}）· ${voice.id}`
      this.dom.voice.appendChild(option)
    }

    const keep = list.some((voice) => voice.id === previous)
      ? previous
      : list[0]?.id ?? DEFAULT_VOICE

    this.dom.voice.value = keep
    this.pendingVoice = keep
  }

  private async handleFetchVoices(): Promise<void> {
    this.dom.fetchVoices.disabled = true
    this.setStatus('正在获取完整音色列表……')

    try {
      const voices = await fetchVoiceList()

      if (voices.length === 0) {
        throw new Error('接口返回了空列表。')
      }

      // 注意：this.voices 是「当前展示的列表」。
      // 只更新 allVoices 的话，搜索框为空时下拉框仍然读 voices，
      // 所以界面不会变 —— 这就是「提示已获取 322 个但列表没动」的原因。
      this.allVoices = voices
      this.voices = voices

      // 缓存到 localStorage：下次打开直接可用（有效期 7 天）。
      saveVoiceCache(voices)

      this.rebuildVoiceOptions()
      this.appendLog(`已获取 ${voices.length} 个音色（已缓存到本地）。`)
      this.setStatus(`已获取 ${voices.length} 个音色。`)
    } catch (error) {
      this.appendLog(
        '获取音色列表失败（HTTPS 页面请求 HTTP 接口被浏览器拦截时属于正常现象）：' +
          String(error),
      )
      this.setStatus('获取音色列表失败，继续使用内置音色。', true)
    } finally {
      this.dom.fetchVoices.disabled = false
    }
  }

  /* ---------------------------------------------------------------- */
  /* 界面小工具                                                        */
  /* ---------------------------------------------------------------- */

  private setStatus(text: string, isError = false): void {
    this.dom.status.textContent = `状态：${text}`
    this.dom.status.classList.toggle('error', isError)
  }

  private appendLog(text: string): void {
    const view = this.dom.log
    const atBottom =
      view.scrollTop + view.clientHeight >= view.scrollHeight - 24

    view.textContent += `${text}\n`

    // 控制长度，避免长时间运行后内存膨胀。
    if (view.textContent.length > 200_000) {
      view.textContent = view.textContent.slice(-100_000)
    }

    if (atBottom) {
      view.scrollTop = view.scrollHeight
    }
  }

  private updateCharCount(): void {
    const count = this.dom.text.value.length
    this.dom.charCount.textContent = `${count.toLocaleString('zh-CN')} 字`
  }

  private updateProgress(current: number, total: number): void {
    if (total <= 0) {
      this.dom.progressTrack.classList.remove('indeterminate')
      this.dom.progressBar.style.width = '0%'
      return
    }

    this.dom.progressTrack.classList.remove('indeterminate')

    const percent = Math.max(0, Math.min(100, (current / total) * 100))
    this.dom.progressBar.style.width = `${percent}%`
  }

  private setIndeterminate(): void {
    this.dom.progressTrack.classList.add('indeterminate')
  }

  private handlePlayerState(state: PlaybackState): void {
    this.dom.playPause.textContent =
      state === 'playing' ? '暂停' : '播放 / 继续'
  }

  private handlePlayerProgress(position: number, duration: number): void {
    this.dom.timeCurrent.textContent = formatTime(position)
    this.dom.timeTotal.textContent = formatTime(duration)

    if (!this.seeking) {
      const ratio = duration > 0 ? position / duration : 0
      this.dom.seek.value = String(Math.round(ratio * 1000))
    }

    const segment = this.segmentMap.get(this.currentSegmentIndex)

    if (segment) {
      this.dom.nowPlaying.textContent =
        `当前片段：${segment.index + 1}/${this.segments.length}　` +
        `${formatTime(position)} / ${formatTime(segment.durationMs)}`
    }
  }

  private updateControls(): void {
    const running = this.generationActive

    this.dom.start.disabled = running
    this.dom.stopGenerate.disabled = !running
    this.dom.exportWav.disabled =
      running || !this.generationCompleted || this.segments.length === 0

    for (const control of [
      this.dom.engine,
      this.dom.voice,
      this.dom.voiceFilter,
      this.dom.fetchVoices,
      this.dom.rate,
      this.dom.pitch,
      this.dom.volume,
      this.dom.maxChars,
      this.dom.minChars,
      this.dom.pause,
      this.dom.autoPlay,
      this.dom.autoExport,
      this.dom.instruction,
      this.dom.reset,
      this.dom.openTxt,
      this.dom.clearText,
      this.dom.text,
    ]) {
      control.disabled = running
    }
  }

  /* ---------------------------------------------------------------- */
  /* 片段列表                                                          */
  /* ---------------------------------------------------------------- */

  private renderSegmentList(): void {
    const list = this.dom.segmentList
    list.innerHTML = ''

    if (this.textChunks.length === 0) {
      this.dom.segmentSummary.textContent = ''
      return
    }

    const fragment = document.createDocumentFragment()

    for (let index = 0; index < this.textChunks.length; index += 1) {
      const text = this.textChunks[index]
      const segment = this.segmentMap.get(index)

      const item = document.createElement('li')
      item.className = 'segment-item'
      item.dataset.index = String(index)

      if (!segment) {
        item.classList.add('pending')
      }

      if (index === this.currentSegmentIndex) {
        item.classList.add('active')
      }

      const no = document.createElement('span')
      no.className = 'no'
      no.textContent = String(index + 1).padStart(4, '0')

      const dur = document.createElement('span')
      dur.className = 'dur'
      dur.textContent = segment ? formatTime(segment.durationMs) : '等待生成'

      const txt = document.createElement('span')
      txt.className = 'txt'
      txt.textContent = previewText(text)
      txt.title = text

      item.append(no, dur, txt)
      fragment.appendChild(item)
    }

    list.appendChild(fragment)

    this.dom.segmentSummary.textContent =
      `已生成 ${this.segments.length}/${this.textChunks.length}`
  }

  private markSegmentActive(index: number): void {
    this.currentSegmentIndex = index

    for (const item of this.dom.segmentList.querySelectorAll<HTMLElement>(
      '.segment-item',
    )) {
      const itemIndex = Number(item.dataset.index ?? '-1')
      item.classList.toggle('active', itemIndex === index)
    }

    this.dom.segmentList
      .querySelector<HTMLElement>('.segment-item.active')
      ?.scrollIntoView({ block: 'nearest' })
  }

  /* ---------------------------------------------------------------- */
  /* 打开 TXT                                                          */
  /* ---------------------------------------------------------------- */

  private async handleOpenTxt(): Promise<void> {
    const file = this.dom.txtInput.files?.[0]

    if (!file) {
      return
    }

    try {
      const content = await readTextFile(file)
      this.dom.text.value = content
      this.updateCharCount()
      this.setStatus(`已读取：${file.name}`)
    } catch (error) {
      this.setStatus(`读取失败：${String(error)}`, true)
    } finally {
      this.dom.txtInput.value = ''
    }
  }

  /* ---------------------------------------------------------------- */
  /* 生成流程                                                          */
  /* ---------------------------------------------------------------- */

  private ensureBackend(): EdgeBackend {
    if (!this.backend) {
      this.backend = createBackend()
    }

    return this.backend
  }

  private speechOptions(): SpeechOptions {
    return {
      rate: this.dom.rate.value,
      pitch: this.dom.pitch.value,
      volume: this.dom.volume.value,
    }
  }

  private async startGeneration(): Promise<void> {
    if (this.generationActive) {
      return
    }

    const rawText = this.dom.text.value.trim()

    if (!rawText) {
      this.setStatus('没有文本，请先在文本框中粘贴要朗读的内容。', true)
      return
    }

    const outcome = prepareChunks(rawText, {
      maxChars: Number(this.dom.maxChars.value),
      minChars: Number(this.dom.minChars.value),
    })

    if (outcome.chunks.length === 0) {
      this.setStatus('没有解析出可朗读的文本。', true)
      return
    }

    const speaker = this.dom.voice.value || DEFAULT_VOICE

    this.clearPreviousSession()

    this.manualStop = false
    this.textChunks = outcome.chunks

    this.renderSegmentList()
    this.updateProgress(0, outcome.chunks.length)
    this.setIndeterminate()

    this.generationActive = true
    this.generationCompleted = false
    this.updateControls()

    this.appendLog('使用引擎：Edge TTS（在线）')
    this.appendLog(
      `文本已分为 ${outcome.chunks.length} 段；` +
        `最大长度 ${outcome.maxChars} 字，最小长度 ${outcome.minChars} 字。`,
    )

    this.setStatus(`共 ${outcome.chunks.length} 段，正在准备 Edge TTS 后端。`)

    const controller = new AbortController()
    this.controller = controller

    const speech = this.speechOptions()

    this.appendLog(
      `语音参数：rate=${speech.rate} pitch=${speech.pitch} volume=${speech.volume}`,
    )

    try {
      await generateSegments({
        chunks: outcome.chunks,
        speaker,
        backend: this.ensureBackend(),
        controller,
        callbacks: {
          onStatus: (text) => this.setStatus(text),
          onProgress: (current, total) => {
            this.updateProgress(current, total)
            this.dom.segmentSummary.textContent = `已生成 ${current}/${total}`
          },
          onSegment: async (segment) => this.handleSegmentReady(segment),
          onCompleted: () => this.handleGenerationCompleted(),
          onStopped: () => this.handleGenerationStopped(),
          onFailed: (errorText) => this.handleGenerationFailed(errorText),
        },
      })
    } finally {
      this.controller = null
    }
  }

  private stopGeneration(): void {
    if (!this.generationActive) {
      return
    }

    this.controller?.abort()
    this.setStatus('已请求停止，将在当前片段生成完毕后停止。')
  }

  private handleSegmentReady(segment: GeneratedSegment): void {
    const info: SegmentInfo = {
      index: segment.index,
      text: segment.text,
      blob: segment.blob,
      durationMs: Math.max(1, Math.trunc(segment.durationMs)),
    }

    this.segmentMap.set(info.index, info)

    this.segments = [...this.segmentMap.values()].sort(
      (a, b) => a.index - b.index,
    )

    this.renderSegmentList()

    // 第一段生成后自动播放。
    if (
      info.index === 0 &&
      this.currentSegmentIndex < 0 &&
      !this.manualStop &&
      this.dom.autoPlay.checked
    ) {
      this.sequenceMode = true
      this.waitingForNext = false

      void this.playSegment(0, 0, true)

      return
    }

    // 当前片段已经播完并在等下一段：立刻接上。
    if (this.sequenceMode && this.waitingForNext) {
      this.tryStartNextReadySegment()
    }
  }

  private handleGenerationCompleted(): void {
    this.generationActive = false
    this.generationCompleted = true

    this.updateControls()
    this.updateProgress(this.textChunks.length, this.textChunks.length)

    this.setStatus(`生成完成，共 ${this.segments.length} 段。`)

    this.resolveWaitingAfterGenerationEnd()

    if (this.dom.autoExport.checked && !this.exporting) {
      void this.exportAudio()
    }
  }

  private handleGenerationStopped(): void {
    this.generationActive = false
    this.generationCompleted = false

    this.updateControls()

    this.setStatus(`已停止，当前生成了 ${this.segments.length} 段。`)

    this.resolveWaitingAfterGenerationEnd()
  }

  private handleGenerationFailed(errorText: string): void {
    this.generationActive = false
    this.generationCompleted = false

    this.updateControls()
    this.appendLog(errorText)

    const lines = errorText.trim().split('\n')
    const summary = lines[lines.length - 1] || '未知错误'

    this.setStatus(`生成失败：${summary}`, true)

    this.resolveWaitingAfterGenerationEnd()
  }

  private resolveWaitingAfterGenerationEnd(): void {
    if (!this.sequenceMode || !this.waitingForNext) {
      return
    }

    if (this.tryStartNextReadySegment()) {
      return
    }

    this.finishAfterLastSegment()
  }

  /* ---------------------------------------------------------------- */
  /* 会话清理                                                          */
  /* ---------------------------------------------------------------- */

  private clearPreviousSession(): void {
    this.manualStop = true
    this.stopWatch()

    this.sequenceMode = false
    this.waitingForNext = false

    this.currentSegmentIndex = -1
    this.segmentMap.clear()
    this.segments = []
    this.textChunks = []

    this.player.stop()

    this.generationActive = false
    this.generationCompleted = false

    this.dom.segmentList.innerHTML = ''
    this.dom.nowPlaying.textContent = '当前片段：—'
    this.dom.timeCurrent.textContent = '00:00'
    this.dom.timeTotal.textContent = '00:00'
    this.dom.seek.value = '0'
    this.updateProgress(0, 0)
  }

  /* ---------------------------------------------------------------- */
  /* 播放状态机                                                        */
  /* ---------------------------------------------------------------- */

  private getSegment(index: number): SegmentInfo | undefined {
    return this.segmentMap.get(Math.trunc(index))
  }

  private getFirstSegment(): SegmentInfo | undefined {
    return this.segments[0]
  }

  /**
   * 尝试启动当前片段之后的下一段。
   *
   * 如果下一段还没有生成，返回 false；
   * 如果下一段已经生成，则自动播放并返回 true。
   */
  private tryStartNextReadySegment(): boolean {
    if (!this.sequenceMode) {
      return false
    }

    const nextIndex =
      this.currentSegmentIndex < 0 ? 0 : this.currentSegmentIndex + 1

    const segment = this.getSegment(nextIndex)

    if (!segment) {
      return false
    }

    this.waitingForNext = false

    void this.playSegment(nextIndex, 0, true)

    return true
  }

  /** 等下一段生成时启动守望定时器（等价于 playback_watch_timer）。 */
  private startWatch(): void {
    this.player.startWatch(() => this.watchPlayback())
  }

  private stopWatch(): void {
    this.player.stopWatch()
  }

  private watchPlayback(): void {
    if (!this.sequenceMode) {
      this.stopWatch()
      return
    }

    if (this.waitingForNext) {
      if (this.tryStartNextReadySegment()) {
        return
      }

      if (!this.generationActive) {
        this.finishAfterLastSegment()
      }

      return
    }

    if (this.currentSegmentIndex < 0) {
      return
    }

    // 备用判断：某些浏览器不会可靠地触发 ended 事件。
    if (this.player.playbackState !== 'playing' && this.player.isAtEnd()) {
      this.handleEndOfMedia(this.currentSegmentIndex)
    }
  }

  /** 已经到达最后一个片段：停止连续播放，不回到第一段。 */
  private finishAfterLastSegment(statusText = '最后一段播放完成。'): boolean {
    this.sequenceMode = false
    this.waitingForNext = false
    this.stopWatch()
    this.setStatus(statusText)

    return true
  }

  private handleSegmentEnded(index: number): void {
    this.player.markFinished(index)
    this.handleEndOfMedia(index)
  }

  private handleEndOfMedia(expectedIndex: number): void {
    if (this.manualStop) {
      return
    }

    if (expectedIndex !== this.currentSegmentIndex) {
      return
    }

    const current = this.getSegment(this.currentSegmentIndex)

    if (!current) {
      return
    }

    // 自动连续播放，但不循环。
    this.sequenceMode = true

    // 下一段已经生成：立即播放。
    if (this.tryStartNextReadySegment()) {
      return
    }

    // 下一段还没有生成：继续等待。
    if (this.generationActive) {
      this.waitingForNext = true
      this.startWatch()
      this.setStatus('当前片段播放完成，等待下一段生成。')
      return
    }

    // 已经没有下一段，播放结束。
    this.finishAfterLastSegment()
  }

  /* ---------------------------------------------------------------- */
  /* 播放控制                                                          */
  /* ---------------------------------------------------------------- */

  private async playSegment(
    index: number,
    offsetMs: number,
    shouldPlay: boolean,
  ): Promise<boolean> {
    const segment = this.getSegment(index)

    if (!segment) {
      return false
    }

    this.manualStop = false
    this.sequenceMode = true
    this.waitingForNext = false

    this.markSegmentActive(index)

    this.dom.nowPlaying.textContent =
      `当前片段：${index + 1}/${this.segments.length}`

    this.player.setRate(Number(this.dom.playRate.value) / 100)

    await this.player.playSegment(
      {
        index: segment.index,
        blob: segment.blob,
        durationMs: segment.durationMs,
      },
      offsetMs,
      shouldPlay,
    )

    return true
  }

  private async playAll(): Promise<void> {
    this.manualStop = false
    this.sequenceMode = true
    this.waitingForNext = false

    const first = this.getFirstSegment()

    if (first) {
      await this.playSegment(first.index, 0, true)
      return
    }

    if (this.generationActive) {
      this.currentSegmentIndex = -1
      this.waitingForNext = true
      this.startWatch()
      this.setStatus('正在等待第一段生成。')
      return
    }

    this.sequenceMode = false
    this.setStatus('目前还没有生成音频。')
  }

  private async togglePlayPause(): Promise<void> {
    if (this.player.playbackState === 'playing') {
      this.player.pause()
      return
    }

    this.sequenceMode = true

    if (this.segments.length === 0) {
      if (this.generationActive) {
        await this.playAll()
      } else {
        this.setStatus('目前还没有生成音频。')
      }

      return
    }

    if (this.currentSegmentIndex < 0) {
      await this.playAll()
      return
    }

    if (this.waitingForNext) {
      if (this.tryStartNextReadySegment()) {
        return
      }

      if (this.generationActive) {
        this.startWatch()
        this.setStatus('等待下一段生成。')
        return
      }
    }

    if (this.player.isAtEnd()) {
      this.handleEndOfMedia(this.currentSegmentIndex)
      return
    }

    await this.playSegment(
      this.currentSegmentIndex,
      this.player.positionMs,
      true,
    )
  }

  private async playPrevious(): Promise<void> {
    if (this.segments.length === 0) {
      return
    }

    this.manualStop = false
    this.sequenceMode = true
    this.waitingForNext = false

    let targetIndex: number

    // 与 Python 版一致：在第一段按“上一段”时回到最后一段。
    if (this.currentSegmentIndex <= 0) {
      targetIndex =
        this.currentSegmentIndex === 0
          ? this.segments[this.segments.length - 1].index
          : this.segments[0].index
    } else {
      targetIndex = this.currentSegmentIndex - 1
    }

    if (!this.getSegment(targetIndex)) {
      targetIndex = this.segments[0].index
    }

    await this.playSegment(targetIndex, 0, true)
  }

  private async playNext(): Promise<void> {
    const first = this.getFirstSegment()

    if (!first) {
      if (this.generationActive) {
        this.manualStop = false
        this.sequenceMode = true
        this.waitingForNext = true
        this.startWatch()
        this.setStatus('正在等待第一段生成。')
      } else {
        this.setStatus('目前还没有生成音频。')
      }

      return
    }

    this.manualStop = false
    this.sequenceMode = true

    const targetIndex = this.currentSegmentIndex + 1

    if (this.getSegment(targetIndex)) {
      this.waitingForNext = false
      await this.playSegment(targetIndex, 0, true)
      return
    }

    if (this.generationActive) {
      this.startWatch()
      this.waitingForNext = true
      this.setStatus('下一段尚未生成，生成后会自动播放。')
      return
    }

    this.finishAfterLastSegment('已经是最后一段，不再循环播放。')
  }

  private stopPlayback(): void {
    this.manualStop = true
    this.sequenceMode = false
    this.waitingForNext = false

    this.stopWatch()
    this.player.stop()

    this.markSegmentActive(-1)
    this.setStatus('播放已停止。')
  }

  private handleSegmentClick(index: number): void {
    if (index < 0) {
      return
    }

    if (!this.getSegment(index)) {
      this.setStatus('该片段还没有生成。')
      return
    }

    // 单击片段后，从该片段开始自动连续播放；播放到最后一段后停止。
    void this.playSegment(index, 0, true)
  }

  /* ---------------------------------------------------------------- */
  /* 导出 WAV                                                          */
  /* ---------------------------------------------------------------- */

  private async exportAudio(): Promise<void> {
    if (this.exporting) {
      return
    }

    if (!this.generationCompleted) {
      this.setStatus('请等待全部片段生成完成后再导出。', true)
      return
    }

    if (this.segments.length === 0) {
      return
    }

    this.exporting = true
    this.dom.exportWav.disabled = true
    this.setStatus('正在导出完整 WAV……')

    try {
      const blob = await mergeBlobsToWav(
        this.segments.map((segment) => segment.blob),
        (current, total) => {
          this.setStatus(`正在导出 WAV：${current}/${total}`)
        },
      )

      const name = `novel_tts_edge_${timestampForFilename()}.wav`

      downloadBlob(blob, name)

      this.setStatus('WAV 导出完成。')
      this.appendLog(`已导出：${name}`)
    } catch (error) {
      this.setStatus('WAV 导出失败。', true)
      this.appendLog(`导出失败：${String(error)}`)
    } finally {
      this.exporting = false
      this.updateControls()
    }
  }
}

/* ------------------------------------------------------------------ */
/* DOM 收集                                                            */
/* ------------------------------------------------------------------ */

function collectDom() {
  return {
    engine: el<HTMLSelectElement>('engine'),
    voice: el<HTMLSelectElement>('voice'),
    voiceFilter: el<HTMLInputElement>('voice-search'),
    fetchVoices: el<HTMLButtonElement>('fetch-voices'),
    rate: el<HTMLSelectElement>('rate'),
    pitch: el<HTMLSelectElement>('pitch'),
    volume: el<HTMLSelectElement>('volume'),
    maxChars: el<HTMLInputElement>('max-chars'),
    minChars: el<HTMLInputElement>('min-chars'),
    pause: el<HTMLInputElement>('pause'),
    autoPlay: el<HTMLInputElement>('auto-play'),
    autoExport: el<HTMLInputElement>('auto-export'),
    reset: el<HTMLButtonElement>('reset-settings'),
    instruction: el<HTMLInputElement>('instruction'),
    start: el<HTMLButtonElement>('start'),
    stopGenerate: el<HTMLButtonElement>('stop-generate'),

    text: el<HTMLTextAreaElement>('source-text'),
    openTxt: el<HTMLButtonElement>('open-txt'),
    clearText: el<HTMLButtonElement>('clear-text'),
    txtInput: el<HTMLInputElement>('txt-input'),
    charCount: el<HTMLSpanElement>('char-count'),

    progressTrack: el<HTMLDivElement>('progress-track'),
    progressBar: el<HTMLDivElement>('progress-bar'),
    status: el<HTMLSpanElement>('status'),

    segmentList: el<HTMLUListElement>('segment-list'),
    segmentSummary: el<HTMLSpanElement>('segment-summary'),

    playAll: el<HTMLButtonElement>('play-all'),
    playPause: el<HTMLButtonElement>('play-pause'),
    previous: el<HTMLButtonElement>('previous'),
    next: el<HTMLButtonElement>('next'),
    stopPlay: el<HTMLButtonElement>('stop-play'),
    exportWav: el<HTMLButtonElement>('export-wav'),

    timeCurrent: el<HTMLSpanElement>('time-current'),
    timeTotal: el<HTMLSpanElement>('time-total'),
    seek: el<HTMLInputElement>('progress-seek'),
    playVolume: el<HTMLInputElement>('play-volume'),
    playVolumeValue: el<HTMLSpanElement>('play-volume-value'),
    playRate: el<HTMLInputElement>('play-rate'),
    playRateValue: el<HTMLSpanElement>('play-rate-value'),
    nowPlaying: el<HTMLSpanElement>('now-playing'),

    log: el<HTMLPreElement>('log'),
  }
}
