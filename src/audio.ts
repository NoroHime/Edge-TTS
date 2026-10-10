/**
 * 音频工具。
 *
 * 对应 Python 版的：
 *   - _normalise_audio（音频归一化）
 *   - ExportThread（把多个片段拼成一个 WAV）
 *
 * 浏览器没有 soundfile，所以这里用 AudioContext 解码 WAV，
 * 再用 PCM 16bit 重新编码，得到与 Python 版 `subtype="PCM_16"` 相同的输出。
 */

export interface DecodedAudio {
  /** 单声道 Float32 采样。 */
  samples: Float32Array
  sampleRate: number
}

/** 采样点归一化：与 Python 版 _normalise_audio 行为一致。 */
export function normaliseSamples(samples: Float32Array): Float32Array {
  if (samples.length === 0) {
    throw new Error('音频数据为空。')
  }

  let peak = 0

  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i])
    if (value > peak) {
      peak = value
    }
  }

  if (peak <= 1) {
    return samples
  }

  const result = new Float32Array(samples.length)

  for (let i = 0; i < samples.length; i += 1) {
    result[i] = samples[i] / peak
  }

  return result
}

/* ------------------------------------------------------------------ */
/* WAV 容器                                                            */
/* ------------------------------------------------------------------ */

interface WavFormat {
  channels: number
  sampleRate: number
  bitsPerSample: number
  audioFormat: number
  dataStart: number
  dataSize: number
}

function readAscii(view: DataView, offset: number, length: number): string {
  let text = ''

  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(view.getUint8(offset + i))
  }

  return text
}

function parseWavFormat(buffer: ArrayBuffer): WavFormat {
  const view = new DataView(buffer)

  if (buffer.byteLength < 44 || readAscii(view, 0, 4) !== 'RIFF') {
    throw new Error('不是有效的 WAV 文件。')
  }

  if (readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('不是有效的 WAV 文件。')
  }

  let offset = 12
  let format: Partial<WavFormat> = {}

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = readAscii(view, offset, 4)
    const chunkSize = view.getUint32(offset + 4, true)
    const body = offset + 8

    if (chunkId === 'fmt ') {
      format = {
        ...format,
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      }
    } else if (chunkId === 'data') {
      format.dataStart = body
      format.dataSize = Math.min(chunkSize, buffer.byteLength - body)
    }

    // 块大小为奇数时补一个填充字节。
    offset = body + chunkSize + (chunkSize % 2)
  }

  if (
    format.audioFormat === undefined ||
    format.channels === undefined ||
    format.sampleRate === undefined ||
    format.bitsPerSample === undefined ||
    format.dataStart === undefined ||
    format.dataSize === undefined
  ) {
    throw new Error('WAV 文件缺少 fmt 或 data 块。')
  }

  return format as WavFormat
}

/** 把 WAV 的 PCM 数据解码为单声道 Float32。 */
function decodeWavToMono(buffer: ArrayBuffer): DecodedAudio {
  const format = parseWavFormat(buffer)
  const view = new DataView(buffer)
  const { audioFormat, channels, sampleRate, bitsPerSample } = format

  const bytesPerSample = bitsPerSample / 8
  const frameCount = Math.floor(format.dataSize / (bytesPerSample * channels))

  if (frameCount <= 0) {
    throw new Error('WAV 文件没有音频数据。')
  }

  const samples = new Float32Array(frameCount)

  const isFloat = audioFormat === 3
  const isPcm = audioFormat === 1

  if (!isFloat && !isPcm) {
    throw new Error(`不支持的 WAV 编码格式：${audioFormat}`)
  }

  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0

    for (let channel = 0; channel < channels; channel += 1) {
      const position =
        format.dataStart + (frame * channels + channel) * bytesPerSample

      let value = 0

      if (isFloat) {
        if (bitsPerSample === 32) {
          value = view.getFloat32(position, true)
        } else if (bitsPerSample === 64) {
          value = view.getFloat64(position, true)
        } else {
          throw new Error(`不支持的浮点位深：${bitsPerSample}`)
        }
      } else if (bitsPerSample === 8) {
        value = (view.getUint8(position) - 128) / 128
      } else if (bitsPerSample === 16) {
        value = view.getInt16(position, true) / 32768
      } else if (bitsPerSample === 24) {
        const low = view.getUint8(position)
        const mid = view.getUint8(position + 1)
        const high = view.getInt8(position + 2)
        value = ((high << 16) | (mid << 8) | low) / 8388608
      } else if (bitsPerSample === 32) {
        value = view.getInt32(position, true) / 2147483648
      } else {
        throw new Error(`不支持的 PCM 位深：${bitsPerSample}`)
      }

      sum += value
    }

    samples[frame] = sum / channels
  }

  return { samples, sampleRate }
}

/** 用 AudioContext 解码音频（MP3 / WAV 都支持）。 */
export async function decodeAudioBlob(blob: Blob): Promise<DecodedAudio> {
  const AudioContextCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext

  if (!AudioContextCtor) {
    throw new Error('当前浏览器不支持 Web Audio API。')
  }

  const context = new AudioContextCtor()

  try {
    const buffer = await blob.arrayBuffer()
    const audioBuffer = await context.decodeAudioData(buffer.slice(0))
    const channels = audioBuffer.numberOfChannels
    const length = audioBuffer.length

    const samples = new Float32Array(length)

    for (let channel = 0; channel < channels; channel += 1) {
      const data = audioBuffer.getChannelData(channel)

      for (let i = 0; i < length; i += 1) {
        samples[i] += data[i] / channels
      }
    }

    return { samples, sampleRate: audioBuffer.sampleRate }
  } finally {
    void context.close()
  }
}

/** 把单声道 Float32 采样编码为 PCM 16bit WAV。 */
export function encodeWavMono(samples: Float32Array, sampleRate: number): Blob {
  const dataSize = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i))
    }
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')

  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt 块长度
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // 字节率
  view.setUint16(32, 2, true) // 块对齐
  view.setUint16(34, 16, true) // 位深

  writeAscii(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, Math.round(clamped * 32767), true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

/**
 * 把多个片段的音频拼成一个 WAV（等价于 Python 版的 ExportThread）。
 *
 * @param blobs    已生成片段的音频（顺序与 segments 一致）
 * @param onProgress 进度回调 (已完成数, 总数)
 */
export async function mergeBlobsToWav(
  blobs: Blob[],
  onProgress?: (current: number, total: number) => void,
): Promise<Blob> {
  if (blobs.length === 0) {
    throw new Error('没有可导出的音频片段。')
  }

  const first = await decodeSegment(blobs[0])
  const sampleRate = first.sampleRate

  let total = first.samples.length

  for (let i = 1; i < blobs.length; i += 1) {
    total += (await decodeSegment(blobs[i])).samples.length
  }

  const merged = new Float32Array(total)
  let offset = 0

  const write = (samples: Float32Array) => {
    merged.set(samples, offset)
    offset += samples.length
  }

  write(first.samples)
  onProgress?.(1, blobs.length)

  for (let i = 1; i < blobs.length; i += 1) {
    const decoded = await decodeSegment(blobs[i])

    if (decoded.sampleRate !== sampleRate) {
      throw new Error(
        `采样率不一致：第 ${i + 1} 段是 ${decoded.sampleRate}Hz，` +
          `但第一段是 ${sampleRate}Hz。`,
      )
    }

    write(decoded.samples)
    onProgress?.(i + 1, blobs.length)
  }

  return encodeWavMono(merged, sampleRate)
}

/** 优先使用自带解码器（更快、不依赖 AudioContext），否则退回 Web Audio。 */
async function decodeSegment(blob: Blob): Promise<DecodedAudio> {
  const buffer = await blob.arrayBuffer()

  try {
    return decodeWavToMono(buffer)
  } catch {
    return decodeAudioBlob(new Blob([buffer], { type: blob.type }))
  }
}

/** 读取音频时长（毫秒），用于显示与“是否播放到结尾”的判断。 */
export async function measureDurationMs(blob: Blob): Promise<number> {
  const buffer = await blob.arrayBuffer()

  try {
    const format = parseWavFormat(buffer)
    const bytesPerSample = format.bitsPerSample / 8
    const frames = format.dataSize / (bytesPerSample * format.channels)

    return Math.max(1, Math.round((frames / format.sampleRate) * 1000))
  } catch {
    /* 非 WAV（例如 MP3）：走媒体元素 */
  }

  return new Promise<number>((resolve) => {
    const url = URL.createObjectURL(blob)
    const audio = document.createElement('audio')

    const finish = (value: number) => {
      URL.revokeObjectURL(url)
      audio.src = ''
      resolve(value)
    }

    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      const seconds = Number.isFinite(audio.duration) ? audio.duration : 0
      finish(Math.max(1, Math.round(seconds * 1000)))
    }
    audio.onerror = () => finish(1)
    audio.src = url
  })
}
