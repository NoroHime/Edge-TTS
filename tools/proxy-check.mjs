/**
 * 本地验证：微软的合成服务是否**要求** User-Agent 头。
 *
 * 背景：浏览器出于安全考虑，不允许页面在 WebSocket 握手里设置 User-Agent。
 * 如果服务端校验 User-Agent，那么纯前端实现（Chrome / Firefox / 手机浏览器）
 * 必然失败，而桌面 Edge 自带正确的 User-Agent 所以能用。
 *
 * 这个脚本起两个本地 TCP 隧道代理，指向同一个上游：
 *   A) 转发时**删掉** User-Agent
 *   B) 转发时**补上** Edge 的 User-Agent
 * 其他一切都完全相同，用来做 A/B 对照。
 *
 * 运行：node tools/proxy-check.mjs
 */

import { createServer } from 'node:http'
import { connect } from 'node:net'

const UPSTREAM_HOST = 'speech.platform.bing.com'
const UPSTREAM_PORT = 443

const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'

/**
 * 极简 TCP 隧道代理：改掉握手请求头，然后双向对拷字节。
 *
 * @param {number} port
 * @param {boolean} withUserAgent
 */
function startProxy(port, withUserAgent, withOrigin) {
  const server = createServer((_req, res) => {
    res.writeHead(400)
    res.end('websocket only')
  })

  server.on('upgrade', (req, clientSocket, head) => {
    const upstream = connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
      const headers = { ...req.headers }

      // 统一成 Edge 客户端的样子，只留两个变量：User-Agent 与 Origin。
      headers['host'] = UPSTREAM_HOST
      headers['pragma'] = 'no-cache'
      headers['cache-control'] = 'no-cache'
      headers['connection'] = 'Upgrade'
      headers['upgrade'] = 'websocket'

      if (withUserAgent) {
        headers['user-agent'] = EDGE_UA
      } else {
        delete headers['user-agent']
      }

      if (withOrigin) {
        headers['origin'] =
          'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
      } else {
        delete headers['origin']
      }

      const lines = [`GET ${req.url} HTTP/1.1`]
      for (const [key, value] of Object.entries(headers)) {
        lines.push(`${key}: ${value}`)
      }

      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head?.length) upstream.write(head)

      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })

    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })

  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve(server)),
  )
}

/* ------------------------------------------------------------------ */

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const WIN_EPOCH_SECONDS = 11_644_473_600
const SEC_MS_GEC_VERSION = '1-143.0.3650.75'

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

async function synth(host) {
  const token = await secMsGec()

  const path =
    `/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&ConnectionId=${connectId()}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`

  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://${host}${path}`)
    let bytes = 0
    let sawTurnEnd = false
    const started = Date.now()

    const done = (ok, detail) => {
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      resolve({ ok, detail, bytes, ms: Date.now() - started })
    }

    setTimeout(() => done(sawTurnEnd, sawTurnEnd ? 'turn.end' : 'timeout'), 15_000)

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
        `X-RequestId:${connectId()}\r\nContent-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${new Date().toUTCString()}\r\nPath:ssml\r\n\r\n` +
          "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
          "<voice name='zh-CN-XiaoxiaoNeural'>" +
          "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>你好，这是代理测试。</prosody>" +
          '</voice></speak>',
      )
    }

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        if (event.data.includes('turn.end')) {
          sawTurnEnd = true
          done(true, '收到 turn.end（合成成功）')
        }
      } else {
        bytes += event.data.byteLength ?? event.data.size ?? 0
      }
    }

    socket.onerror = () => done(false, 'onerror（握手被拒）')
    socket.onclose = (e) => {
      if (sawTurnEnd) done(true, '收到 turn.end（合成成功）')
      else done(false, `onclose code=${e.code}${e.reason ? ` reason=${e.reason}` : ''}`)
    }
  })
}

/* ------------------------------------------------------------------ */

const PORT_NO_UA = 8791
const PORT_UA_ONLY = 8792
const PORT_UA_ORIGIN = 8794

const serverA = await startProxy(PORT_NO_UA, false, true)
const serverB = await startProxy(PORT_UA_ONLY, true, false)
const serverC = await startProxy(PORT_UA_ORIGIN, true, true)

console.log('三个本地代理已启动，指向同一个上游 speech.platform.bing.com:443\n')

const results = []

const withoutUa = await synth(`127.0.0.1:${PORT_NO_UA}`)
results.push(['A) 不带 User-Agent（带 Origin）', withoutUa])
console.log(
  `${withoutUa.ok ? 'OK  ' : 'FAIL'}  A) 不带 User-Agent（带 Origin）  ${String(withoutUa.ms).padStart(6)}ms  ${withoutUa.detail}`,
)

const uaOnly = await synth(`127.0.0.1:${PORT_UA_ONLY}`)
results.push(['B) 只带 User-Agent', uaOnly])
console.log(
  `${uaOnly.ok ? 'OK  ' : 'FAIL'}  B) 只带 User-Agent              ${String(uaOnly.ms).padStart(6)}ms  ${uaOnly.detail}  音频 ${uaOnly.bytes} 字节`,
)

const uaOrigin = await synth(`127.0.0.1:${PORT_UA_ORIGIN}`)
results.push(['C) User-Agent + Origin', uaOrigin])
console.log(
  `${uaOrigin.ok ? 'OK  ' : 'FAIL'}  C) User-Agent + Origin          ${String(uaOrigin.ms).padStart(6)}ms  ${uaOrigin.detail}  音频 ${uaOrigin.bytes} 字节`,
)

serverA.close()
serverB.close()
serverC.close()

const uaWorks = uaOnly.ok || uaOrigin.ok

console.log(
  `\n结论：${
    !withoutUa.ok && uaWorks
      ? '服务端强制要求 User-Agent —— 浏览器无法设置该头，所以纯前端方案在非 Edge 浏览器里注定失败。'
      : 'A/B 结果与预期不同，需要继续排查。'
  }`,
)
