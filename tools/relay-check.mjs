/**
 * 端到端验证：走「本地 WebSocket 中转」时，应用的合成代码能不能成功。
 *
 * 这个脚本模拟 Cloudflare Worker 的行为：
 *   · 对浏览器：普通的 WebSocket 服务端（客户端不需要任何特殊请求头）；
 *   · 对上游：自己发起握手，并补上 User-Agent。
 *
 * 然后用**应用真实的 URL 拼接方式**（WSS_URL + 查询参数）去连接，
 * 证明「配好代理之后，浏览器端代码就能正常工作」。
 *
 * 运行：node tools/relay-check.mjs
 */

import { createServer } from 'node:http'
import { WebSocketServer, WebSocket as WsClient } from 'ws'

const UPSTREAM_WSS =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'

const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.3650.75 Safari/537.36 Edg/143.0.3650.75'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const WIN_EPOCH_SECONDS = 11_644_473_600
const SEC_MS_GEC_VERSION = '1-143.0.3650.75'

const PORT = 8801

/* ------------------------------------------------------------------ */
/* 中转服务端：对客户端开放，对上游补 User-Agent                        */
/* ------------------------------------------------------------------ */

function startRelay() {
  const server = createServer()
  // decodeBase64: false —— 保持标准 WebSocket 语义：
  // 文本帧是普通字符串（不是 base64），二进制帧是 Buffer。
  // 默认值会把文本帧里的 base64 内容解码，导致上游收到乱码。
  const wss = new WebSocketServer({ server, path: '/edge/v1', decodeBase64: false })

  wss.on('connection', (clientSocket, request) => {
    const url = new URL(request.url, `http://127.0.0.1:${PORT}`)
    const upstreamUrl = `${UPSTREAM_WSS}${url.search}`

    console.log('[relay] 客户端已连接，正在连接上游 ...')

    // 关键：服务端在这里补上浏览器无法提供的请求头。
    const upstream = new WsClient(upstreamUrl, {
      headers: {
        'User-Agent': EDGE_UA,
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
      },
    })

    const pending = []

    upstream.on('open', () => {
      console.log(`[relay] 上游已连接，补发 ${pending.length} 条缓存消息`)
      for (const message of pending) {
        upstream.send(message.payload, { binary: message.isBinary })
      }
      pending.length = 0
    })

    // 浏览器 → 上游
    //
    // 注意：ws 库即使对**文本帧**也会给出 Buffer。如果直接把 Buffer
    // 交给 up.send()，它会被当成**二进制帧**发出去，上游会回
    // 1007 "Binary message has invalid header size"。
    // 所以文本帧必须先转回字符串。
    // （Cloudflare Workers 的 WebSocket API 文本帧本来就是 string，不存在这个问题。）
    clientSocket.on('message', (data, isBinary) => {
      const payload = isBinary
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(data)

      if (upstream.readyState === WsClient.OPEN) {
        upstream.send(payload, { binary: isBinary })
      } else {
        pending.push({ payload, isBinary })
      }
    })

    // 上游 → 浏览器（原样转发，包括二进制音频帧）
    upstream.on('message', (data, isBinary) => {
      const size = Array.isArray(data) ? data[0]?.length : data.length
      console.log(`[relay] 上游 → 客户端：${isBinary ? 'binary' : 'text'} ${size} 字节`)
      if (clientSocket.readyState === clientSocket.OPEN) {
        clientSocket.send(data, { binary: isBinary })
      }
    })

    upstream.on('error', (error) => {
      console.log(`[relay] 上游错误：${error.message}`)
      clientSocket.close(1011, `upstream error: ${error.message}`)
    })

    upstream.on('close', (code, reason) => {
      console.log(`[relay] 上游关闭：code=${code} reason=${reason?.toString() || '-'}`)
    })

    const teardown = () => {
      try {
        upstream.close()
      } catch {
        /* ignore */
      }
      try {
        clientSocket.close()
      } catch {
        /* ignore */
      }
    }

    clientSocket.on('close', teardown)
    clientSocket.on('error', teardown)
  })

  return new Promise((resolve) =>
    server.listen(PORT, '127.0.0.1', () => resolve({ server, wss })),
  )
}

/* ------------------------------------------------------------------ */
/* 复刻应用里的 URL 拼接与请求内容                                      */
/* ------------------------------------------------------------------ */

async function secMsGec() {
  const rounded = Math.floor(Date.now() / 1000) + WIN_EPOCH_SECONDS
  const ticks = (rounded - (rounded % 300)) * 10_000_000

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${ticks}${TRUSTED_CLIENT_TOKEN}`),
  )

  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  )
    .join('')
    .toUpperCase()
}

const connectId = () => crypto.randomUUID().replace(/-/g, '')

/** 与 src/edgeTts.ts 里 synthesizePiece 的拼接方式完全一致。 */
async function buildUrl(wssUrl) {
  const token = await secMsGec()
  const separator = wssUrl.includes('?') ? '&' : '?'

  return (
    `${wssUrl}${separator}TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&ConnectionId=${connectId()}` +
    `&Sec-MS-GEC=${token}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
  )
}

/** 复刻应用发出的 speech.config 与 SSML。 */
function speak(socket) {
  socket.send(
    `X-Timestamp:${new Date().toUTCString()}\r\n` +
      'Content-Type:application/json; charset=utf-8\r\n' +
      'Path:speech.config\r\n\r\n' +
      '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
      '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"' +
      '},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n',
  )

  socket.send(
    `X-RequestId:${connectId()}\r\nContent-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${new Date().toUTCString()}\r\nPath:ssml\r\n\r\n` +
      "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
      "<voice name='zh-CN-XiaoxiaoNeural'>" +
      "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>你好，这是中转测试。</prosody>" +
      '</voice></speak>',
  )
}

/** 用「浏览器会看到的行为」连接：不设置任何自定义请求头。 */
function runClient(label, wssUrl) {
  return new Promise(async (resolve) => {
    const url = await buildUrl(wssUrl)
    const socket = new WsClient(url)

    let audioBytes = 0
    let audioFrames = 0
    let sawTurnEnd = false
    const started = Date.now()

    const done = (ok, detail) => {
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      resolve({ label, ok, detail, audioBytes, audioFrames, ms: Date.now() - started })
    }

    setTimeout(() => done(sawTurnEnd, sawTurnEnd ? 'turn.end' : 'timeout'), 20_000)

    socket.on('open', () => speak(socket))

    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        if (data.toString().includes('turn.end')) {
          sawTurnEnd = true
          done(true, 'turn.end')
        }
        return
      }

      // 二进制帧：前两字节是大端头部长度。
      audioFrames += 1
      const headerLength = (data[0] << 8) | data[1]
      let start = 2 + headerLength
      if (
        data[start] === 0x0d &&
        data[start + 1] === 0x0a &&
        data[start + 2] === 0x0d &&
        data[start + 3] === 0x0a
      ) {
        start += 4
      }
      audioBytes += Math.max(0, data.length - start)
    })

    socket.on('error', (error) => done(false, `error: ${error.message}`))
    socket.on('close', (code, reason) => {
      if (sawTurnEnd) done(true, 'turn.end（连接随后关闭）')
      else done(false, `close code=${code} reason=${reason?.toString() || '-'}`)
    })
  })
}

/* ------------------------------------------------------------------ */

const { server, wss } = await startRelay()

console.log(`本地中转已启动：ws://127.0.0.1:${PORT}/edge/v1`)
console.log('（服务端会补上 User-Agent；客户端不需要任何特殊请求头）\n')

// A) 客户端直接连上游 —— 模拟浏览器直连，必然失败
const direct = await runClient('A) 直连上游（无 User-Agent）', UPSTREAM_WSS)
console.log(
  `${direct.ok ? 'OK  ' : 'FAIL'}  ${direct.label.padEnd(30)} ${String(direct.ms).padStart(6)}ms  ${direct.detail}`,
)

// B) 客户端连中转 —— 模拟配置 VITE_EDGE_TTS_PROXY 之后
const relayed = await runClient(
  'B) 走本地中转（服务端补 UA）',
  `ws://127.0.0.1:${PORT}/edge/v1`,
)
console.log(
  `${relayed.ok ? 'OK  ' : 'FAIL'}  ${relayed.label.padEnd(30)} ${String(relayed.ms).padStart(6)}ms  ${relayed.detail}  ` +
    `音频 ${relayed.audioFrames} 帧 / ${relayed.audioBytes} 字节`,
)

wss.close()
server.close()

console.log(
  `\n结论：${
    !direct.ok && relayed.ok
      ? '直连被拒、走中转成功 —— 与 Cloudflare Worker 方案一致，配好代理即可在任意浏览器使用。'
      : '结果与预期不同，需要继续排查。'
  }`,
)
