/**
 * Edge TTS WebSocket 中转（Node 版，可直接跑在任何能常驻运行的地方）。
 *
 * 和 proxy/cloudflare-worker.js 等价，区别是：
 *   · 本文件用 Node 的 http + ws，可以在自己电脑 / 云服务器 / Docker 上跑；
 *   · Worker 版部署到 Cloudflare，不用自己维护机器。
 *
 * 为什么需要中转：见 README 开头「必读」一节
 * （微软在握手阶段强制要求 User-Agent，而浏览器不允许网页设置该头）。
 *
 * ────────────────────────────────────────────────────────────────────
 * 用法
 * ────────────────────────────────────────────────────────────────────
 *   pnpm add -D ws          # 或者 npm i ws
 *   node proxy/node-proxy.mjs
 *
 * 默认监听 0.0.0.0:8787，浏览器端把地址填成：
 *
 *   VITE_EDGE_TTS_PROXY=ws://127.0.0.1:8787
 *
 * 如果你的页面是 https，浏览器不允许连 ws://（混合内容），
 * 这时需要放在反向代理（Nginx / Caddy）后面套一层 TLS，或者改用
 * Cloudflare Worker 版。
 *
 * 环境变量：
 *   PORT           监听端口（默认 8787）
 *   ALLOWED_ORIGINS 允许的来源，逗号分隔；留空表示不限制
 */

import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'

const PORT = Number(process.env.PORT ?? 8787)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

const UPSTREAM_WSS =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'

/** 与 edge-tts 7.2.8 保持一致的 Edge User-Agent。 */
const EDGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.3650.75 Safari/537.36 Edg/143.0.3650.75'

const server = createServer((request, response) => {
  if (request.url === '/' || request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        ok: true,
        service: 'edge-tts websocket proxy (node)',
        upstream: UPSTREAM_WSS,
        usage: 'ws://<this-host>/edge/v1?TrustedClientToken=...',
      }),
    )
    return
  }

  response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end('this endpoint only accepts websocket upgrades on /edge/v1')
})

const wss = new WebSocketServer({ server, path: '/edge/v1', decodeBase64: false })

wss.on('connection', (clientSocket, request) => {
  const origin = request.headers.origin

  if (ALLOWED_ORIGINS.length > 0 && origin && !ALLOWED_ORIGINS.includes(origin)) {
    clientSocket.close(1008, 'origin not allowed')
    return
  }

  const query = new URL(request.url ?? '/', 'http://localhost').search
  const upstreamUrl = `${UPSTREAM_WSS}${query}`

  // 关键：在这里补上浏览器无法设置的请求头。
  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      'User-Agent': EDGE_USER_AGENT,
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
    },
  })

  // 上游还没连上时先缓存浏览器发来的消息，避免丢帧。
  const pending = []

  upstream.on('open', () => {
    for (const message of pending) {
      upstream.send(message.data, { binary: message.isBinary })
    }
    pending.length = 0
  })

  clientSocket.on('message', (data, isBinary) => {
    // 注意：ws 库对**文本帧**也给 Buffer。直接转发会被当成二进制帧，
    // 上游会回 1007 "Binary message has invalid header size"。
    const payload = isBinary
      ? data
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : String(data)

    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(payload, { binary: isBinary })
    } else {
      pending.push({ data: payload, isBinary })
    }
  })

  upstream.on('message', (data, isBinary) => {
    if (clientSocket.readyState === clientSocket.OPEN) {
      clientSocket.send(data, { binary: isBinary })
    }
  })

  upstream.on('error', (error) => {
    if (clientSocket.readyState === clientSocket.OPEN) {
      clientSocket.close(1011, `upstream error: ${error.message}`)
    }
  })

  const shutdown = () => {
    for (const socket of [upstream, clientSocket]) {
      try {
        if (socket.readyState <= 1) socket.close()
      } catch {
        /* 忽略 */
      }
    }
  }

  clientSocket.on('close', shutdown)
  clientSocket.on('error', shutdown)
  upstream.on('close', shutdown)
})

server.listen(PORT, () => {
  console.log(`Edge TTS 中转已启动：ws://127.0.0.1:${PORT}/edge/v1`)
  console.log(`健康检查：http://127.0.0.1:${PORT}/`)
  console.log(
    ALLOWED_ORIGINS.length > 0
      ? `允许的来源：${ALLOWED_ORIGINS.join(', ')}`
      : '来源限制：未开启（建议设置 ALLOWED_ORIGINS）',
  )
  console.log('\n浏览器端配置：VITE_EDGE_TTS_PROXY=ws://127.0.0.1:' + PORT)
})
