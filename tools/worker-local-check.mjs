/**
 * 用 Miniflare（Cloudflare 官方本地运行时）加载 proxy/cloudflare-worker.js，
 * 然后像浏览器一样连它，验证 Worker 代码到底能不能合成。
 *
 * 这样可以在不部署的情况下定位 Worker 的问题。
 *
 * 运行：node tools/worker-local-check.mjs
 */

import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'

const workerSource = readFileSync('proxy/cloudflare-worker.js', 'utf8')

const mf = new Miniflare({
  workers: [
    {
      config: {
        name: 'edge-tts-proxy',
        compatibilityDate: '2026-10-01',
        manifest: {
          mainModule: 'worker.js',
          modules: {
            'worker.js': { type: 'esm', contents: workerSource },
          },
        },
      },
    },
  ],
  port: 8788,
})

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const WIN = 11644473600
const VER = '1-143.0.3650.75'

async function buildQuery() {
  const t = Math.floor(Date.now() / 1000) + WIN
  const ticks = (t - (t % 300)) * 10_000_000
  const d = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${ticks}${TOKEN}`),
  )
  const gec = Array.from(new Uint8Array(d), (b) =>
    b.toString(16).padStart(2, '0'),
  )
    .join('')
    .toUpperCase()

  return (
    `TrustedClientToken=${TOKEN}` +
    `&ConnectionId=${crypto.randomUUID().replace(/-/g, '')}` +
    `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${VER}`
  )
}

/* 1) 健康检查（走 Miniflare 的 fetch 派发） */
const health = await mf.dispatchFetch('http://localhost/')
console.log('健康检查:', health.status, (await health.text()).slice(0, 70))

/* 2) 真正的 WebSocket 合成测试 —— 连本地 Miniflare 端口 */
const query = await buildQuery()
const url = `ws://127.0.0.1:8788/edge/v1?${query}`

const result = await new Promise((resolve) => {
  let textFrames = 0
  let audioFrames = 0
  let audioBytes = 0
  let sawTurnEnd = false
  const started = Date.now()
  let socket

  const finish = (ok, detail) => {
    try {
      socket?.close()
    } catch {
      /* 忽略 */
    }
    resolve({ ok, detail, textFrames, audioFrames, audioBytes, ms: Date.now() - started })
  }

  try {
    socket = new WebSocket(url)
  } catch (error) {
    finish(false, `ctor: ${error.message}`)
    return
  }

  setTimeout(() => finish(sawTurnEnd, sawTurnEnd ? 'turn.end' : 'timeout 20s'), 20_000)

  socket.onopen = () => {
    socket.send(
      `X-Timestamp:${new Date().toUTCString()}\r\n` +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
        '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"' +
        '},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n',
    )
    socket.send(
      `X-RequestId:${crypto.randomUUID().replace(/-/g, '')}\r\n` +
        'Content-Type:application/ssml+xml\r\n' +
        `X-Timestamp:${new Date().toUTCString()}\r\nPath:ssml\r\n\r\n` +
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
        "<voice name='zh-CN-XiaoxiaoNeural'>" +
        "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>你好，这是 Worker 本地测试。</prosody>" +
        '</voice></speak>',
    )
  }

  socket.onmessage = (event) => {
    if (typeof event.data === 'string') {
      textFrames += 1
      if (event.data.includes('turn.end')) {
        sawTurnEnd = true
        finish(true, 'turn.end')
      }
      return
    }

    audioFrames += 1

    // binaryType 可能是 blob 也可能是 arraybuffer，分开量。
    const size = event.data?.byteLength ?? event.data?.size ?? 0
    audioBytes += size
    if (audioFrames <= 2) {
      console.log(
        `  [client] 收到二进制帧 #${audioFrames}: ${event.data?.constructor?.name} ${size} 字节`,
      )
    }
  }

  socket.onerror = () => finish(false, 'onerror（握手被拒）')
  socket.onclose = (event) => {
    finish(
      sawTurnEnd,
      `onclose code=${event.code} reason=${event.reason || '-'}`,
    )
  }
})

console.log(
  `${result.ok ? 'OK  ' : 'FAIL'}  Worker(Miniflare)  ${result.ms}ms  ${result.detail}  ` +
    `文本帧 ${result.textFrames} / 音频 ${result.audioFrames} 帧 ${result.audioBytes} 字节`,
)

await mf.dispose()
process.exit(result.ok ? 0 : 1)
