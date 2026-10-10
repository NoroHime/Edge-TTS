/**
 * Edge TTS WebSocket 中转（Cloudflare Worker）。
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么必须要这个代理？
 * ────────────────────────────────────────────────────────────────────
 * 微软的在线合成服务在 **WebSocket 握手阶段强制要求 User-Agent 头**：
 *
 *     带 User-Agent    → HTTP/1.1 101 Switching Protocols
 *     不带 User-Agent  → HTTP/1.1 403 Forbidden
 *
 * 而浏览器的 WebSocket API 不允许页面设置 User-Agent
 * （User-Agent 属于 HTML 规范的 forbidden header name）。
 * 所以：
 *
 *   · 桌面 Edge 能用 —— Edge 自己在握手时带了正确的 User-Agent；
 *   · Chrome / Firefox / Safari / 手机浏览器 / 任何纯 JS 客户端 → 403。
 *
 * GitHub Pages 只能托管静态文件，没法替浏览器补这个头，
 * 因此需要一个服务端中转。这个 Worker 就是干这件事的：
 * 浏览器连 Worker，Worker 补上 User-Agent 后再连微软。
 * 音频繁还是流式的（边收边转发），不会把整段音频缓存在服务端。
 *
 * ────────────────────────────────────────────────────────────────────
 * 部署（免费）
 * ────────────────────────────────────────────────────────────────────
 *   1. 注册 https://dash.cloudflare.com （免费账号）
 *   2. 左侧 Workers & Pages → Create → Worker → 随便起个名字
 *   3. 把本文件的全部内容粘进去，Deploy
 *   4. 记下地址，形如 https://edge-tts-proxy.你的子域.workers.dev
 *   5. 在项目根目录建 .env.local，写入：
 *
 *          VITE_EDGE_TTS_PROXY=wss://edge-tts-proxy.你的子域.workers.dev
 *
 *   6. 重新 build 并推送，GitHub Pages 就会走这个代理
 *
 * 想限制只让自己的站点使用，在 Worker 的 Settings → Variables 里加一个
 * 变量 ALLOWED_ORIGINS，值为你的站点来源，多个用英文逗号分隔，例如：
 *
 *          ALLOWED_ORIGINS = https://norohime.github.io,http://localhost:5173
 *
 * 留空表示不限制（不建议，会被别人白用）。
 */

const UPSTREAM_HOST = 'speech.platform.bing.com'
const UPSTREAM_PATH = '/consumer/speech/synthesize/readaloud/edge/v1'

/** 与 edge-tts 7.2.8 保持一致的 Edge User-Agent。 */
const EDGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  }
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
          usage: 'wss://<this-worker>/edge/v1?TrustedClientToken=...&ConnectionId=...',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        },
      )
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('this endpoint only accepts websocket upgrades', {
        status: 426,
        headers: corsHeaders(origin),
      })
    }

    // 把浏览器带来的查询参数原样转给上游。
    const upstreamUrl = `https://${UPSTREAM_HOST}${UPSTREAM_PATH}${url.search}`

    const upstreamRequest = new Request(upstreamUrl, {
      method: 'GET',
      headers: {
        // 关键：补齐浏览器无法设置的头。
        'User-Agent': EDGE_USER_AGENT,
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        Upgrade: 'websocket',
        Connection: 'Upgrade',
      },
    })

    try {
      const upstreamResponse = await fetch(upstreamRequest)

      // 101 会被 Cloudflare 表示成 webSocket 字段存在。
      if (!upstreamResponse.webSocket) {
        const body = await upstreamResponse.text().catch(() => '')

        return new Response(
          `upstream refused the websocket upgrade (HTTP ${upstreamResponse.status}). ${body.slice(0, 200)}`,
          { status: 502, headers: corsHeaders(origin) },
        )
      }

      upstreamResponse.webSocket.accept()

      return new Response(null, {
        status: 101,
        webSocket: upstreamResponse.webSocket,
        headers: corsHeaders(origin),
      })
    } catch (error) {
      return new Response(`proxy error: ${error?.message ?? error}`, {
        status: 502,
        headers: corsHeaders(origin),
      })
    }
  },
}
