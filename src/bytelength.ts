/**
 * 按 UTF-8 字节长度切分文本。
 *
 * 这是 edge_tts.communicate.split_text_by_byte_length 的等价移植
 * （Python 版 tts_backends.py 通过 edge-tts 使用同一算法）。
 *
 * 规则：
 *   1. 每块不超过 byteLength 字节；
 *   2. 优先在换行或空格处断开（换行优先）；
 *   3. 否则退回到一个完整的 UTF-8 字符边界；
 *   4. 不允许把 XML 实体（如 &amp;）从中间切开。
 *
 * 注意第 2 点的细节：切分点本身（换行 / 空格）会留在**前一块**里，
 * 与 Python 的 `text[:split_at].strip()` 行为一致。
 */

export function splitByByteLength(text: string, byteLength: number): string[] {
  if (byteLength <= 0) {
    throw new Error('byteLength 必须大于 0。')
  }

  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8')
  const chunks: string[] = []

  let rest = text

  while (encoder.encode(rest).length > byteLength) {
    // 原实现把文本当作字节序列，所以切分点以**字节**为单位定位。
    const encoded = encoder.encode(rest)

    // 1) 找最后一个换行；2) 没有换行就找最后一个空格。
    let byteSplit = -1

    for (let i = Math.min(byteLength, encoded.length) - 1; i >= 0; i -= 1) {
      if (encoded[i] === 0x0a) {
        byteSplit = i
        break
      }
    }

    if (byteSplit < 0) {
      for (let i = Math.min(byteLength, encoded.length) - 1; i >= 0; i -= 1) {
        if (encoded[i] === 0x20) {
          byteSplit = i
          break
        }
      }
    }

    // 3) 没有自然断点：回退到最长的完整 UTF-8 前缀。
    if (byteSplit < 0) {
      byteSplit = safeUtf8Length(encoded, byteLength)
    }

    // 4) 不要把 XML 实体切开。
    let prefixBytes = encoded.subarray(0, byteSplit)
    let ampersand = indexOfLastByte(prefixBytes, 0x26)

    while (ampersand >= 0) {
      const semicolon = indexOfByteBetween(
        prefixBytes,
        0x3b,
        ampersand,
        byteSplit,
      )

      if (semicolon >= 0) {
        break
      }

      byteSplit = ampersand
      prefixBytes = encoded.subarray(0, byteSplit)
      ampersand = indexOfLastByte(prefixBytes, 0x26)
    }

    const piece = decoder.decode(encoded.subarray(0, byteSplit)).trim()

    if (piece) {
      chunks.push(piece)
    }

    // 与 Python 的 `data[split_at if split_at > 0 else 1:]` 完全一致。
    rest = decoder.decode(encoded.subarray(byteSplit > 0 ? byteSplit : 1))
  }

  const tail = rest.trim()

  if (tail) {
    chunks.push(tail)
  }

  return chunks
}

/**
 * 返回不超过 limit 的最长 UTF-8 前缀长度（不会切在多字节字符中间）。
 *
 * 实现方式：从 limit 处的字节往前找字符起始字节，再判断该字符是否完整。
 */
function safeUtf8Length(encoded: Uint8Array, limit: number): number {
  let end = Math.min(limit, encoded.length)

  while (end > 0) {
    // 跳过续字节（10xxxxxx），找到字符的起始字节。
    while (end > 0 && (encoded[end - 1] & 0xc0) === 0x80) {
      end -= 1
    }

    if (end === 0) {
      return 0
    }

    const start = end - 1
    const lead = encoded[start]

    const size =
      (lead & 0x80) === 0
        ? 1
        : (lead & 0xe0) === 0xc0
          ? 2
          : (lead & 0xf0) === 0xe0
            ? 3
            : (lead & 0xf8) === 0xf0
              ? 4
              : 1

    const charEnd = start + size

    // 字符完整且不超过限制：这就是最长的合法前缀。
    if (charEnd <= limit && charEnd <= encoded.length) {
      return charEnd
    }

    // 否则丢掉这个不完整的字符，继续往前找。
    end = start
  }

  return 0
}

/** bytes[0..end) 里最后一个等于 value 的下标。 */
function indexOfLastByte(bytes: Uint8Array, value: number): number {
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    if (bytes[i] === value) {
      return i
    }
  }

  return -1
}

/** bytes[start..end) 里第一个等于 value 的下标。 */
function indexOfByteBetween(
  bytes: Uint8Array,
  value: number,
  start: number,
  end: number,
): number {
  for (let i = start; i < Math.min(end, bytes.length); i += 1) {
    if (bytes[i] === value) {
      return i
    }
  }

  return -1
}
