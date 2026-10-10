/**
 * Edge TTS 协议自检（用假的 WebSocket 服务端，不访问网络）。
 *
 * 验证的是真实代码路径：
 *   - 连接 URL 是否带上 Sec-MS-GEC / Sec-MS-GEC-Version / ConnectionId；
 *   - 发出的 speech.config 与 SSML 请求格式是否正确；
 *   - 能否正确解析二进制音频帧（前两字节 = 头部长度）；
 *   - turn.end 后是否返回完整音频；
 *   - 超长文本是否自动拆成多次请求并拼接；
 *   - 出错时是否正确重试。
 *
 * 运行：node tests/protocol.test.ts
 */

import { strict as assert } from 'node:assert'

import { SEC_MS_GEC_VERSION } from '../src/constants.ts'
import { synthesizeOnce, synthesizeWithRetry } from '../src/edgeTts.ts'

/* ------------------------------------------------------------------ */
/* 假的 WebSocket                                                      */
/* ------------------------------------------------------------------ */

class FakeWebSocket {
  static readonly CONNECTING = 0

  static readonly OPEN = 1

  static readonly CLOSING = 2

  static readonly CLOSED = 3

  static instances: FakeWebSocket[] = []

  readonly url: string

  readyState = FakeWebSocket.CONNECTING

  sent: string[] = []

  onopen: (() => void) | null = null

  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null

  onerror: (() => void) | null = null

  onclose: ((event: { code: number; reason: string }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)

    // 异步“连接成功”。
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    })
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }

  /** 测试用：把一段文本消息推给客户端。 */
  pushText(body: string): void {
    this.onmessage?.({ data: body })
  }

  /** 测试用：把一段二进制音频帧推给客户端。 */
  pushBinary(audio: Uint8Array, path = 'audio'): void {
    const header = `X-RequestId:test\r\nContent-Type:audio/mpeg\r\nPath:${path}\r\n`
    const headerBytes = new TextEncoder().encode(header)
    const separator = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a])

    const total = 2 + headerBytes.length + separator.length + audio.length
    const frame = new Uint8Array(total)
    const view = new DataView(frame.buffer)

    view.setUint16(0, headerBytes.length, false)
    frame.set(headerBytes, 2)
    frame.set(separator, 2 + headerBytes.length)
    frame.set(audio, 2 + headerBytes.length + separator.length)

    this.onmessage?.({ data: frame.buffer })
  }

  /** 测试用：模拟服务端关闭连接。 */
  pushClose(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason })
  }
}

// 让被测试的代码看到假的 WebSocket 与 window.setTimeout。
const globals = globalThis as unknown as {
  WebSocket: unknown
  window: unknown
}

globals.WebSocket = FakeWebSocket
globals.window = { setTimeout, clearTimeout }

const AUDIO = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44])

/**
 * 等到第 count 个假 WebSocket 被创建。
 *
 * synthesizeOnce 会先异步计算 Sec-MS-GEC 令牌，所以构造连接不是同步的。
 */
async function waitForSocket(count = 1): Promise<FakeWebSocket> {
  for (let i = 0; i < 400; i += 1) {
    if (FakeWebSocket.instances.length >= count) {
      return FakeWebSocket.instances[count - 1]
    }

    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  throw new Error(`等待第 ${count} 个 WebSocket 连接超时。`)
}

/** 等到假 socket 上出现 n 条已发送消息。 */
async function waitForSends(
  socket: FakeWebSocket,
  count: number,
): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (socket.sent.length >= count) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  throw new Error(`等待 ${count} 条 WebSocket 消息超时。`)
}

/* ------------------------------------------------------------------ */
/* 用例 1：正常一次合成                                                */
/* ------------------------------------------------------------------ */

FakeWebSocket.instances = []

const promise = synthesizeOnce({
  text: '你好，世界。',
  voice: 'zh-CN-XiaoxiaoNeural',
})

const socket = await waitForSocket()
await waitForSends(socket, 2)

// URL 必须包含全部鉴权参数。
assert.ok(
  socket.url.startsWith(
    'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1',
  ),
  `WebSocket URL 前缀不对：${socket.url}`,
)
assert.ok(
  socket.url.includes('TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4'),
)
assert.ok(socket.url.includes('&ConnectionId='))
assert.ok(/&Sec-MS-GEC=[0-9A-F]{64}/.test(socket.url), 'Sec-MS-GEC 缺失或格式错误')
assert.ok(
  socket.url.includes(`&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`),
  'Sec-MS-GEC-Version 缺失',
)

// 第一条：speech.config
const config = socket.sent[0]
assert.ok(config.includes('Path:speech.config\r\n\r\n'), 'speech.config 头部格式错误')
assert.ok(config.includes('"outputFormat":"audio-24khz-48kbitrate-mono-mp3"'))
assert.ok(config.includes('"sentenceBoundaryEnabled":"false"'))

// 第二条：SSML
const ssml = socket.sent[1]
assert.ok(ssml.includes('Path:ssml\r\n\r\n'), 'SSML 头部格式错误')
assert.ok(ssml.includes('Content-Type:application/ssml+xml'))
assert.ok(ssml.includes("<voice name='zh-CN-XiaoxiaoNeural'>"))
assert.ok(ssml.includes("rate='+0%'"))
assert.ok(ssml.includes('你好，世界。'))

// 服务端应答。
socket.pushText('X-RequestId:test\r\nPath:turn.start\r\n\r\n{}')
socket.pushBinary(AUDIO)
socket.pushBinary(AUDIO)
socket.pushText('X-RequestId:test\r\nPath:turn.end\r\n\r\n')

const blob = await promise

assert.equal(blob.type, 'audio/mpeg')
assert.equal(blob.size, AUDIO.length * 2, '音频字节数不等于两帧之和')

const bytes = new Uint8Array(await blob.arrayBuffer())
assert.deepEqual(Array.from(bytes.slice(0, 4)), [0xff, 0xfb, 0x90, 0x00])

console.log('ok 1/4 - speech.config + SSML + 二进制音频帧解析 + turn.end')

/* ------------------------------------------------------------------ */
/* 用例 2：超长文本自动分块                                            */
/* ------------------------------------------------------------------ */

FakeWebSocket.instances = []

const longText = '中'.repeat(3000) // 9000 字节
const longPromise = synthesizeOnce({
  text: longText,
  voice: 'zh-CN-XiaoxiaoNeural',
})

const firstSocket = await waitForSocket()
await waitForSends(firstSocket, 2)

// 第一块的正文（<prosody> 与 </prosody> 之间）必须受 4096 字节预算约束。
const firstSsmlBody = firstSocket.sent[1].split('\r\n\r\n')[1] ?? ''
const innerText = firstSsmlBody
  .replace(/^[\s\S]*?<prosody[^>]*>/, '')
  .replace(/<\/prosody>[\s\S]*$/, '')

const innerBytes = new TextEncoder().encode(innerText).length

assert.ok(
  innerBytes <= 4096,
  `第一块正文 ${innerBytes} 字节，超过 4096 字节预算`,
)

firstSocket.pushBinary(AUDIO)
firstSocket.pushText('X-RequestId:test\r\nPath:turn.end\r\n\r\n')

const secondSocket = await waitForSocket(2)
await waitForSends(secondSocket, 2)
secondSocket.pushBinary(AUDIO)
secondSocket.pushText('X-RequestId:test\r\nPath:turn.end\r\n\r\n')

// 9000 字节的文本会被切成 3 块（4096 + 4096 + 808）。
const thirdSocket = await waitForSocket(3)
await waitForSends(thirdSocket, 2)
thirdSocket.pushBinary(AUDIO)
thirdSocket.pushText('X-RequestId:test\r\nPath:turn.end\r\n\r\n')

const longBlob = await longPromise

assert.equal(
  longBlob.size,
  AUDIO.length * 3,
  '分块合成的三段音频应被拼接',
)

console.log(
  'ok 2/4 - 超过 4096 字节的文本自动拆成 3 次请求，结果按顺序拼接',
)

/* ------------------------------------------------------------------ */
/* 用例 3：失败后重试                                                  */
/* ------------------------------------------------------------------ */

FakeWebSocket.instances = []

const retryPromise = synthesizeWithRetry({
  text: '重试测试',
  voice: 'zh-CN-XiaoxiaoNeural',
  retryDelaySeconds: 0.01,
})

// 第一次：服务端直接关闭，且没有音频。
const firstAttempt = await waitForSocket()
await waitForSends(firstAttempt, 2)
firstAttempt.pushClose(1006, 'boom')

// 第二次：正常返回。
const retrySocket = await waitForSocket(2)
await waitForSends(retrySocket, 2)
retrySocket.pushBinary(AUDIO)
retrySocket.pushText('X-RequestId:test\r\nPath:turn.end\r\n\r\n')

const retryBlob = await retryPromise

assert.equal(retryBlob.size, AUDIO.length)

console.log('ok 3/4 - 连接中断后会按配置重试，并返回成功那一次的结果')

/* ------------------------------------------------------------------ */
/* 用例 4：连续失败时抛出明确的错误                                     */
/* ------------------------------------------------------------------ */

FakeWebSocket.instances = []

const failPromise = synthesizeWithRetry({
  text: '必定失败',
  voice: 'zh-CN-XiaoxiaoNeural',
  maxAttempts: 2,
  retryDelaySeconds: 0.01,
})

for (let attempt = 1; attempt <= 2; attempt += 1) {
  const failing = await waitForSocket(attempt)
  await waitForSends(failing, 2)
  failing.pushClose(1006, 'nope')
}

await assert.rejects(failPromise, /连续尝试 2 次仍未成功/)

console.log('ok 4/4 - 全部尝试失败时抛出可读错误')

console.log('OK - Edge TTS 协议自检全部通过（4/4，未访问网络）')
