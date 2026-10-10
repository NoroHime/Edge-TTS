/**
 * 文本分析。
 *
 * 对应 Python 版生成前的预处理：
 * 读取文本 → split_text 分段 → 填充片段列表。
 */

import { DEFAULT_MAX_CHARS, DEFAULT_MIN_CHARS } from './constants.ts'
import { splitText } from './text.ts'

export interface SplitOptions {
  maxChars?: number
  minChars?: number
}

export interface SplitOutcome {
  chunks: string[]
  maxChars: number
  minChars: number
  characters: number
}

/** 把原始文本切成待合成片段。 */
export function prepareChunks(
  rawText: string,
  options: SplitOptions = {},
): SplitOutcome {
  const maxChars = Math.max(
    60,
    Math.min(500, Math.trunc(options.maxChars ?? DEFAULT_MAX_CHARS)),
  )

  const minChars = Math.max(
    0,
    Math.min(Math.trunc(options.minChars ?? DEFAULT_MIN_CHARS), maxChars),
  )

  const chunks = splitText(rawText, maxChars, minChars)

  return {
    chunks,
    maxChars,
    minChars,
    characters: rawText.length,
  }
}
