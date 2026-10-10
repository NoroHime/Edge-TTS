/**
 * 直接把手工构造的握手请求写到上游，并打印服务端的原始响应。
 *
 * 目的：搞清楚「直连成功」和「经过代理失败」到底差在哪里。
 *
 * 运行：node tools/handshake-debug.mjs
 */

import { connect as tlsConnect } from 'node:tls'
import { randomBytes, createHash } from 'node:crypto'

const HOST = 'speech.platform.bing.com'
const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const WIN_EPOCH_SECONDS = 11_644_473_600
const SEC_MS_GEC_VERSION = '1-143.0.3650.75'

const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'

async function secMsGec() {
  const rounded = Math.floor(Date.now() / 1000) + WIN_EPOCH_SECONDS
  const ticks = (rounded - (rounded % 300)) * 10_000_000

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${ticks}${TOKEN}`),
  )

  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  )
    .join('')
    .toUpperCase()
}

function handshake({ userAgent, origin, acceptEncoding, acceptLanguage }) {
  return new Promise(async (resolve) => {
    const token = await secMsGec()
    const connectionId = randomBytes(16).toString('hex')

    const path =
      `/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}` +
      `&ConnectionId=${connectionId}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`

    const key = randomBytes(16).toString('base64')

    const headers = [
      `GET ${path} HTTP/1.1`,
      `Host: ${HOST}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ]

    if (userAgent) headers.push(`User-Agent: ${userAgent}`)
    if (origin) headers.push(`Origin: ${origin}`)
    if (acceptEncoding) headers.push(`Accept-Encoding: ${acceptEncoding}`)
    if (acceptLanguage) headers.push(`Accept-Language: ${acceptLanguage}`)

    headers.push('Pragma: no-cache', 'Cache-Control: no-cache')

    const request = headers.join('\r\n') + '\r\n\r\n'

    const socket = tlsConnect({ host: HOST, port: 443, servername: HOST }, () => {
      socket.write(request)
    })

    let response = ''
    const finish = (label) => {
      socket.destroy()
      resolve({ label, response: response.split('\r\n').slice(0, 6).join(' | ') })
    }

    socket.on('data', (chunk) => {
      response += chunk.toString('latin1')
      if (response.includes('\r\n\r\n')) finish('got response')
    })

    socket.on('error', (error) => resolve({ label: 'error', response: error.message }))
    socket.on('close', () => {
      if (!response) resolve({ label: 'closed', response: '(服务端直接断开，无响应)' })
    })

    setTimeout(() => finish('timeout'), 10_000)
  })
}

const cases = [
  ['① 只带 User-Agent', { userAgent: EDGE_UA }],
  [
    '② User-Agent + Origin',
    { userAgent: EDGE_UA, origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold' },
  ],
  ['③ 什么都不带', {}],
  ['④ User-Agent + Accept-*', { userAgent: EDGE_UA, acceptEncoding: 'gzip, deflate, br, zstd', acceptLanguage: 'en-US,en;q=0.9' }],
]

for (const [label, options] of cases) {
  const result = await handshake(options)
  console.log(`${label.padEnd(26)} -> ${result.response}`)
}
