/**
 * Edge TTS WebSocket 中转（Cloudflare Worker）。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么必须要这个中转？
 * ────────────────────────────────────────────────────────────────────
 * 微软的在线合成服务在 **WebSocket 握手阶段强制要求 User-Agent 头**：
 *
 *     带 User-Agent    → HTTP/1.1 101 Switching Protocols
 *     不带 User-Agent  → HTTP/1.1 403 Forbidden
 *
 * 而浏览器的 WebSocket API 不允许页面设置 User-Agent
 * （User-Agent 属于 HTML 规范的 forbidden header name）。所以：
 *
 *   · 桌面 Edge 能用 —— Edge 自己在握手时带了正确的 User-Agent；
 *   · Chrome / Firefox / Safari / 手机浏览器 / 任何纯 JS 客户端 → 403。
 *
 * GitHub Pages 只能托管静态文件，没法替浏览器补这个头，
 * 因此需要一个服务端中转。这个 Worker 就是干这件事的。
 *
 * ────────────────────────────────────────────────────────────────────
 * 部署（免费）
 * ────────────────────────────────────────────────────────────────────
 *   1. 注册 https://dash.cloudflare.com （免费账号，不用绑卡）
 *   2. 左侧 Workers & Pages → Create → Worker → 随便起个名字
 *   3. 把本文件的全部内容粘进去，Deploy
 *   4. 记下地址，形如 https://edge-tts-proxy.你的子域.workers.dev
 *      （先在浏览器打开它，应看到 {"ok":true,...} 的 JSON）
 *   5. 项目根目录建 .env.local，写入：
 *
 *          VITE_EDGE_TTS_PROXY=wss://edge-tts-proxy.你的子域.workers.dev
 *
 *   6. 重新 build 并推送，GitHub Pages 就会走这个中转
 *
 * 想限制只让自己的站点使用，在 Worker 的 Settings → Variables and
 * Secrets 里加一个变量 ALLOWED_ORIGINS，值为你的站点来源，多个用逗号分隔：
 *
 *          ALLOWED_ORIGINS = https://norohime.github.io,http://localhost:5173
 *
 * ────────────────────────────────────────────────────────────────────
 * 实现要点（踩过的坑，别改）
 * ────────────────────────────────────────────────────────────────────
 *   1. 连上游时**只能**带 `Upgrade: websocket`，不能自己再发
 *      `Connection: Upgrade` —— 否则运行时会拒绝握手，客户端看到 1006。
 *   2. 上游的 WebSocket 必须用 `双向管道` 手工把消息在两边来回转发，
 *      不能只把 upstream 直接返回给浏览器（那样一个字节都传不过去）。
 */

const UPSTREAM_HOST = 'speech.platform.bing.com'
const UPSTREAM_PATH = '/consumer/speech/synthesize/readaloud/edge/v1'

/** 与 edge-tts 7.2.8 保持一致的 Edge User-Agent。 */
const EDGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.3650.75 Safari/537.36 Edg/143.0.3650.75'

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  }
}

/**
 * 把两个 WebSocket 双向对接起来。
 *
 * ⚠️ 二进制帧必须特别小心：
 * Workers 的 `binaryType` 在不同 compat 日期下默认值不同
 * （新版本默认 `"blob"`），而 `WebSocket.send()` **不接受 `Blob`**。
 * 如果直接把收到的 Blob 转发出去，音频帧会被丢掉，
 * 客户端就会报「Edge TTS 返回了空音频文件」。
 *
 * 所以这里显式把二进制数据统一成 ArrayBuffer 再发送。
 */
function toTransferable(data) {
  // ArrayBuffer / 各种 TypedArray 可以直接发。
  if (data instanceof ArrayBuffer) return data
  if (ArrayBuffer.isView(data)) return data

  // Blob 需要异步读成 ArrayBuffer。
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.arrayBuffer()
  }

  // 其它情况按字符串发（文本帧）。
  return data
}

async function forward(target, data) {
  if (target.readyState !== 1) return

  const payload = toTransferable(data)

  // Blob 会返回 Promise，需要 await；其它类型直接发。
  target.send(payload instanceof Promise ? await payload : payload)
}

function relayPair(a, b) {
  let closed = false

  const shutdown = () => {
    if (closed) return
    closed = true
    for (const socket of [a, b]) {
      try {
        if (socket.readyState <= 1) socket.close()
      } catch {
        /* 忽略 */
      }
    }
  }

  const pipe = (from, to) => {
    from.addEventListener('message', (event) => {
      // 不 await：保持转发顺序，失败时直接断开。
      forward(to, event.data).catch(shutdown)
    })

    from.addEventListener('close', shutdown)
    from.addEventListener('error', shutdown)
  }

  pipe(a, b)
  pipe(b, a)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin')

    // 来源白名单（可选）。
    const allowed = (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)

    if (allowed.length > 0 && origin && !allowed.includes(origin)) {
      return new Response(`origin not allowed: ${origin}`, {
        status: 403,
        headers: corsHeaders(origin),
      })
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    // 健康检查，方便部署后自测。
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          ok: true,
          service: 'edge-tts websocket proxy',
          upstream: `wss://${UPSTREAM_HOST}${UPSTREAM_PATH}`,
          usage: `wss://<this-worker>/edge/v1?TrustedClientToken=...`,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(origin),
          },
        },
      )
    }

    if (url.pathname !== '/edge/v1' && url.pathname !== '/edge/v1/') {
      return new Response('not found, use /edge/v1', {
        status: 404,
        headers: corsHeaders(origin),
      })
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('this endpoint only accepts websocket upgrades', {
        status: 426,
        headers: corsHeaders(origin),
      })
    }

    // 把浏览器带来的查询参数原样转给上游。
    const upstreamUrl = `https://${UPSTREAM_HOST}${UPSTREAM_PATH}${url.search}`

    let upstreamResponse

    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: 'GET',
        headers: {
          // 关键：补齐浏览器无法设置的头。
          'User-Agent': EDGE_USER_AGENT,
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
          // 只带 Upgrade，不要再带 Connection。
          Upgrade: 'websocket',
        },
      })
    } catch (error) {
      return new Response(`proxy fetch failed: ${error?.message ?? error}`, {
        status: 502,
        headers: corsHeaders(origin),
      })
    }

    if (!upstreamResponse.webSocket) {
      const body = await upstreamResponse.text().catch(() => '')

      return new Response(
        `upstream refused the websocket upgrade (HTTP ${upstreamResponse.status}). ${body.slice(0, 200)}`,
        { status: 502, headers: corsHeaders(origin) },
      )
    }

    // 浏览器这一侧的 WebSocket 配对。
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    // 显式要求 ArrayBuffer，避免拿到 Blob 后转发时把音频帧丢掉。
    server.binaryType = 'arraybuffer'
    upstreamResponse.webSocket.binaryType = 'arraybuffer'

    server.accept()
    upstreamResponse.webSocket.accept()

    relayPair(server, upstreamResponse.webSocket)

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: corsHeaders(origin),
    })
  },
}
