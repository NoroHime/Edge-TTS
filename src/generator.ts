/**
 * 生成器。
 *
 * 对应 Python 版 GUI_QWENv6.pyw 里的 GenerateThread：
 *
 *   - 逐段调用后端合成；
 *   - 每段生成完成立即回调（所以可以边生成边播放）；
 *   - 支持中途停止：当前片段生成完后停止；
 *   - 生成失败时把错误信息回报给界面。
 *
 * 浏览器里没有线程，这里用异步流程实现同样的“边生成边产出”行为。
 */

import { measureDurationMs } from './audio.ts'
import type { EdgeBackend } from './edgeTts.ts'
import { consolePrint } from './utils.ts'

export interface GeneratedSegment {
  index: number
  text: string
  blob: Blob
  durationMs: number
}

export interface GeneratorCallbacks {
  onStatus?: (text: string) => void
  onProgress?: (current: number, total: number) => void
  /** 每段生成完成。可以是异步的，界面可以先渲染再继续。 */
  onSegment?: (segment: GeneratedSegment) => void | Promise<void>
  onCompleted?: () => void
  onStopped?: () => void
  onFailed?: (errorText: string) => void
}

export interface GenerateRequest {
  chunks: string[]
  speaker: string
  backend: EdgeBackend
  callbacks?: GeneratorCallbacks
  /** 由调用方持有，用于请求停止。 */
  controller: AbortController
}

/** 用户主动停止。 */
export class GenerationCancelled extends Error {
  constructor() {
    super('已请求停止。')
    this.name = 'GenerationCancelled'
  }
}

/**
 * 顺序生成全部片段。
 *
 * 返回已经生成的片段数组；中途停止时返回已经生成的部分。
 * 出错时通过 onFailed 上报，并且返回已生成的部分。
 */
export async function generateSegments(
  request: GenerateRequest,
): Promise<GeneratedSegment[]> {
  const { chunks, speaker, backend, callbacks = {}, controller } = request

  const produced: GeneratedSegment[] = []

  try {
    backend.load((text) => callbacks.onStatus?.(text))

    const total = chunks.length

    for (let index = 0; index < total; index += 1) {
      if (controller.signal.aborted) {
        callbacks.onStopped?.()
        return produced
      }

      const text = chunks[index]

      callbacks.onStatus?.(
        `正在生成第 ${index + 1}/${total} 段，约 ${text.length} 字。`,
      )

      const blob = await backend.infer({
        text,
        speaker,
        signal: controller.signal,
      })

      const durationMs = await measureDurationMs(blob)

      const segment: GeneratedSegment = {
        index,
        text,
        blob,
        durationMs: Math.max(1, Math.trunc(durationMs)),
      }

      produced.push(segment)

      await callbacks.onSegment?.(segment)

      callbacks.onProgress?.(index + 1, total)
    }

    callbacks.onStatus?.('全部片段生成完成。')
    callbacks.onCompleted?.()

    return produced
  } catch (error) {
    if (error instanceof GenerationCancelled || controller.signal.aborted) {
      callbacks.onStopped?.()
      return produced
    }

    const text =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error)

    consolePrint(text)
    callbacks.onFailed?.(text)

    return produced
  }
}
