/**
 * 文本分段。
 *
 * 这是 Python 版 GUI_QWENv6.pyw 中以下函数的等价移植：
 *
 *   split_sentences / hard_split / join_text_units / split_text
 *
 * 保持与 Python 相同的行为（包括 hard_split 允许略微超过 max_chars
 * 的边界情况），以便同一段文本在两端得到相同的分段结果。
 */

import { DEFAULT_MAX_CHARS, DEFAULT_MIN_CHARS } from './constants.ts'

/** 中文引号、括号等需要跟随在句末标点之后的字符。 */
const CLOSING_CHARS = new Set('”’」』】》）)]'.split(''))

const SENTENCE_END_CHARS = '。！？!?；;…'

/**
 * 按中文句号、问号、感叹号、分号、省略号切分。
 * 尽量保留中文引号和括号。
 */
export function splitSentences(text: string): string[] {
  const result: string[] = []
  let start = 0

  for (let i = 0; i < text.length; i += 1) {
    if (i < start) {
      continue
    }

    const ch = text[i]

    if (!SENTENCE_END_CHARS.includes(ch)) {
      continue
    }

    let end = i + 1

    while (end < text.length && CLOSING_CHARS.has(text[end])) {
      end += 1
    }

    const piece = text.slice(start, end).trim()

    if (piece) {
      result.push(piece)
    }

    start = end
  }

  const tail = text.slice(start).trim()

  if (tail) {
    result.push(tail)
  }

  return result
}

/** 等价于 Python 的 str.rfind(sub, 0, end)：找不到时返回 -1。 */
function rfind(text: string, search: string, end: number): number {
  return text.lastIndexOf(search, Math.max(0, end - 1))
}

/**
 * 处理没有标点、但长度超过限制的文本。
 *
 * 注意：为了与 Python 版行为一致，这里刻意保留了
 * “找不到合适断点则按 maxChars - 1 切”的逻辑。
 */
export function hardSplit(text: string, maxChars: number): string[] {
  const result: string[] = []
  let rest = text.trim()

  while (rest.length > maxChars) {
    const candidates = [
      rfind(rest, '，', maxChars),
      rfind(rest, '、', maxChars),
      rfind(rest, ',', maxChars),
      rfind(rest, '：', maxChars),
      rfind(rest, ':', maxChars),
      rfind(rest, ' ', maxChars),
    ]

    let cut = Math.max(...candidates)

    if (cut < Math.floor(maxChars * 0.4)) {
      cut = maxChars - 1
    }

    const piece = rest.slice(0, cut + 1).trim()

    if (piece) {
      result.push(piece)
    }

    rest = rest.slice(cut + 1).trim()
  }

  if (rest) {
    result.push(rest)
  }

  return result
}

/**
 * 拼接两个文本片段。
 *
 * 中文之间不额外添加空格；英文片段之间自动添加一个空格。
 */
export function joinTextUnits(left: string, right: string): string {
  const a = left || ''
  const b = right || ''

  if (!a) {
    return b
  }

  if (!b) {
    return a
  }

  if (/\s$/.test(a) || /^\s/.test(b)) {
    return a + b
  }

  if (isAscii(a[a.length - 1]) && isAscii(b[0])) {
    return `${a} ${b}`
  }

  return a + b
}

/** Python str.isascii() 的等价实现（空字符返回 false）。 */
function isAscii(ch: string | undefined): boolean {
  if (!ch) {
    return false
  }

  return ch.charCodeAt(0) < 128
}

/**
 * 把长文本分割为适合 TTS 分段生成的片段。
 */
export function splitText(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS,
  minChars: number = DEFAULT_MIN_CHARS,
): string[] {
  const source = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()

  if (!source) {
    return []
  }

  const safeMax = Math.max(60, Math.min(500, Math.trunc(maxChars)))
  const safeMin = Math.max(0, Math.min(Math.trunc(minChars), safeMax))

  const paragraphs = source.split(/\n\s*\n+/)

  const allUnits: string[] = []

  for (const rawParagraph of paragraphs) {
    const paragraph = rawParagraph.replace(/[ \t]*\n[ \t]*/g, '').trim()

    if (!paragraph) {
      continue
    }

    let sentenceUnits = splitSentences(paragraph)

    if (sentenceUnits.length === 0) {
      sentenceUnits = [paragraph]
    }

    const normalizedUnits: string[] = []

    for (const rawUnit of sentenceUnits) {
      const unit = rawUnit.trim()

      if (!unit) {
        continue
      }

      if (unit.length <= safeMax) {
        normalizedUnits.push(unit)
      } else {
        normalizedUnits.push(...hardSplit(unit, safeMax))
      }
    }

    allUnits.push(...normalizedUnits)
  }

  if (allUnits.length === 0) {
    return []
  }

  const allChunks: string[] = []
  let buffer = ''

  for (const unit of allUnits) {
    if (!unit) {
      continue
    }

    if (!buffer) {
      buffer = unit
      continue
    }

    if (safeMin > 0 && buffer.length < safeMin) {
      buffer = joinTextUnits(buffer, unit)
      continue
    }

    const candidate = joinTextUnits(buffer, unit)

    if (candidate.length <= safeMax) {
      buffer = candidate
    } else {
      allChunks.push(buffer.trim())
      buffer = unit
    }
  }

  if (buffer) {
    const trimmed = buffer.trim()

    if (safeMin > 0 && trimmed.length < safeMin && allChunks.length > 0) {
      allChunks[allChunks.length - 1] = joinTextUnits(
        allChunks[allChunks.length - 1],
        trimmed,
      ).trim()
    } else {
      allChunks.push(trimmed)
    }
  }

  return allChunks.filter((chunk) => chunk.trim().length > 0)
}
