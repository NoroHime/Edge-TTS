/**
 * 播放器。
 *
 * 对应 Python 版 GUI_QWENv6.pyw 里的 QMediaPlayer 相关逻辑：
 *
 *   - 播放过程中自动进入下一段；
 *   - 如果下一段还没有生成，则进入“等待下一段”状态；
 *   - 播放到最后一段后停止，不会回到第一段循环；
 *   - 支持上一段 / 下一段 / 停止 / 暂停继续；
 *   - 播放速度与音量只影响播放，不改动已经生成的音频。
 *
 * 浏览器没有 QMediaPlayer，这里用 HTMLAudioElement +
 * 一个 100ms 的“守望”定时器（等价于 Python 版的 playback_watch_timer）。
 */

import { END_OF_MEDIA_TOLERANCE_MS } from './constants.ts'

export type PlaybackState = 'stopped' | 'playing' | 'paused'

export interface PlaybackCallbacks {
  /** 播放器状态变化（用于切换“播放 / 暂停”按钮文案）。 */
  onStateChange?: (state: PlaybackState) => void
  /** 播放进度变化（毫秒）。 */
  onProgress?: (positionMs: number, durationMs: number) => void
  /** 当前片段播放结束。 */
  onEnded?: (index: number) => void
  /** 播放出错。 */
  onError?: (message: string) => void
}

export interface SegmentSource {
  index: number
  blob: Blob
  durationMs: number
}

export class PlaybackController {
  private readonly audio: HTMLAudioElement

  private readonly callbacks: PlaybackCallbacks

  private objectUrl: string | null = null

  private currentIndex = -1

  private expectedIndex = -1

  private manualStop = true

  private watchTimer: number | null = null

  private watchHandler: (() => void) | null = null

  private finishedIndex: number | null = null

  /** 递增令牌：忽略旧片段的残留事件（等价于 Python 版的 playback_token）。 */
  private token = 0

  /** 记录最后有效播放位置，避免某些浏览器在 ended 后把位置重置为 0。 */
  private lastPositionMs = 0

  private durationMs = 0

  constructor(callbacks: PlaybackCallbacks = {}) {
    this.callbacks = callbacks
    this.audio = new Audio()
    this.audio.preload = 'auto'

    this.audio.addEventListener('timeupdate', this.handleTimeUpdate)
    this.audio.addEventListener('ended', this.handleEnded)
    this.audio.addEventListener('play', this.handlePlay)
    this.audio.addEventListener('pause', this.handlePause)
    this.audio.addEventListener('error', this.handleError)
    this.audio.addEventListener('loadedmetadata', this.handleLoadedMetadata)
  }

  /* ---------------------------------------------------------------- */
  /* 基础控制                                                          */
  /* ---------------------------------------------------------------- */

  get playbackState(): PlaybackState {
    if (this.audio.paused) {
      return this.audio.currentTime > 0 ? 'paused' : 'stopped'
    }

    return 'playing'
  }

  get index(): number {
    return this.currentIndex
  }

  get positionMs(): number {
    return Math.max(this.audio.currentTime * 1000, this.lastPositionMs)
  }

  get mediaDurationMs(): number {
    return this.durationMs
  }

  setVolume(value: number): void {
    this.audio.volume = Math.max(0, Math.min(1, value))
  }

  setRate(value: number): void {
    try {
      this.audio.playbackRate = Math.max(0.25, Math.min(4, value))
    } catch {
      /* 某些浏览器可能不支持 */
    }
  }

  /**
   * 播放指定片段。
   *
   * @param segment 片段音频
   * @param offsetMs 起始位置
   * @param shouldPlay 是否立即播放（false 表示只加载并暂停）
   */
  async playSegment(
    segment: SegmentSource,
    offsetMs = 0,
    shouldPlay = true,
  ): Promise<void> {
    this.token += 1
    this.manualStop = false
    this.currentIndex = segment.index
    this.expectedIndex = segment.index
    this.finishedIndex = null

    const offset = Math.max(0, offsetMs)
    this.lastPositionMs = offset

    // 加载新片段。
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }

    this.objectUrl = URL.createObjectURL(segment.blob)
    this.audio.pause()
    this.audio.src = this.objectUrl
    this.audio.load()

    this.durationMs = segment.durationMs

    await this.waitForMetadata()

    this.seek(offset)

    if (shouldPlay) {
      await this.resume()
    } else {
      this.audio.pause()
    }
  }

  /** 继续 / 从头播放当前片段。 */
  async resume(): Promise<void> {
    this.manualStop = false

    try {
      await this.audio.play()
    } catch (error) {
      this.callbacks.onError?.(
        `无法开始播放：${String((error as Error)?.message ?? error)}`,
      )
    }
  }

  pause(): void {
    this.audio.pause()
  }

  /** 停止播放（等价于 Python 版的 stop_playback）。 */
  stop(): void {
    this.token += 1
    this.manualStop = true
    this.expectedIndex = -1
    this.finishedIndex = null
    this.lastPositionMs = 0

    this.stopWatch()
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }

    this.callbacks.onStateChange?.('stopped')
  }

  /** 跳转到指定毫秒位置。 */
  seek(positionMs: number): void {
    const target = Math.max(0, positionMs) / 1000

    try {
      if (Number.isFinite(this.audio.duration)) {
        this.audio.currentTime = Math.min(target, this.audio.duration)
      } else {
        this.audio.currentTime = target
      }
    } catch {
      /* 元数据未就绪时忽略 */
    }

    this.lastPositionMs = Math.max(0, positionMs)
  }

  /** 当前片段是否已经播放到结尾。 */
  isAtEnd(): boolean {
    const duration = this.durationMs || this.audio.duration * 1000

    if (!Number.isFinite(duration) || duration <= 0) {
      return false
    }

    return this.positionMs >= Math.max(0, duration - END_OF_MEDIA_TOLERANCE_MS)
  }

  /* ---------------------------------------------------------------- */
  /* 等待下一段的守望定时器                                             */
  /* ---------------------------------------------------------------- */

  startWatch(handler: () => void): void {
    this.watchHandler = handler

    if (this.watchTimer === null) {
      this.watchTimer = window.setInterval(() => {
        this.watchHandler?.()
      }, 100)
    }
  }

  stopWatch(): void {
    if (this.watchTimer !== null) {
      clearInterval(this.watchTimer)
      this.watchTimer = null
    }
  }

  /** 通知播放器：某片段确实播放结束了。 */
  markFinished(index: number): void {
    this.finishedIndex = index
  }

  isFinished(index: number): boolean {
    return this.finishedIndex === index
  }

  /* ---------------------------------------------------------------- */
  /* 事件处理                                                          */
  /* ---------------------------------------------------------------- */

  private handleLoadedMetadata = (): void => {
    if (Number.isFinite(this.audio.duration)) {
      this.durationMs = this.audio.duration * 1000
    }

    this.callbacks.onProgress?.(this.positionMs, this.durationMs)
  }

  private handleTimeUpdate = (): void => {
    if (this.expectedIndex !== this.currentIndex) {
      return
    }

    const position = this.audio.currentTime * 1000

    if (this.audio.paused) {
      if (position > this.lastPositionMs) {
        this.lastPositionMs = position
      }
    } else {
      this.lastPositionMs = position
    }

    this.callbacks.onProgress?.(position, this.durationMs)
  }

  private handlePlay = (): void => {
    this.callbacks.onStateChange?.('playing')
  }

  private handlePause = (): void => {
    if (this.audio.ended) {
      return
    }

    this.callbacks.onStateChange?.('paused')
  }

  private handleError = (): void => {
    const code = this.audio.error?.code
    const message =
      this.audio.error?.message || `音频播放失败（错误码 ${code ?? '未知'}）。`

    this.callbacks.onError?.(message)
  }

  private handleEnded = (): void => {
    if (this.manualStop) {
      return
    }

    if (this.expectedIndex !== this.currentIndex) {
      return
    }

    const endedIndex = this.currentIndex

    if (this.finishedIndex === endedIndex) {
      return
    }

    this.lastPositionMs = this.durationMs

    this.callbacks.onEnded?.(endedIndex)
  }

  /** 等音频元数据就绪，最多等 5 秒（等价于 Python 版的 pending 重试）。 */
  private waitForMetadata(): Promise<void> {
    if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
      this.durationMs = this.audio.duration * 1000
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      const started = Date.now()

      const check = () => {
        if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
          this.durationMs = this.audio.duration * 1000
          resolve()
          return
        }

        if (Date.now() - started > 5000) {
          resolve()
          return
        }

        window.setTimeout(check, 50)
      }

      check()
    })
  }
}
