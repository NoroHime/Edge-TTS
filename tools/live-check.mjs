/**
 * 用 Python 版 edge-tts 7.2.8 的**完全相同**参数与请求头连接，
 * 用来判断 403 是「参数不对」还是「环境限制」。
 *
 * 运行：node tools/live-check.mjs
 */

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud'
const WIN_EPOCH_SECONDS = 11_644_473_600

// 与 edge-tts 7.2.8 / edge-tts-universal 当前版本一致
const CHROMIUM_FULL_VERSION = '143.0.3650.75'
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`

async function secMsGec(now = Date.now()) {
  const rounded = Math.floor(now / 1000) + WIN_EPOCH_SECONDS
  const fiveMinutes = rounded - (rounded % 300)
  const ticks = fiveMinutes * 10_000_000

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
const muid = () => crypto.randomUUID().replace(/-/g, '').toUpperCase()

const SSML =
  "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
  "<voice name='zh-CN-XiaoxiaoNeural'>" +
  "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>你好</prosody>" +
  '</voice></speak>'

function probe(label, { url, headers }) {
  return new Promise((resolve) => {
    let settled = false
    const started = Date.now()
    let socket

    const done = (ok, detail) => {
      if (settled) return
      settled = true
      try {
        socket?.close()
      } catch {
        /* ignore */
      }
      resolve({ label, ok, detail, ms: Date.now() - started })
    }

    try {
      socket = new WebSocket(url, { headers })
    } catch (error) {
      done(false, `ctor threw: ${error.message}`)
      return
    }

    setTimeout(() => done(false, 'timeout 12s'), 12_000)

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
          `X-Timestamp:${new Date().toUTCString()}\r\nPath:ssml\r\n\r\n${SSML}`,
      )
    }

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        if (event.data.includes('turn.end')) done(true, 'turn.end 收到')
      } else {
        done(true, `音频帧 ${event.data.byteLength ?? event.data.size ?? '?'} 字节`)
      }
    }

    socket.onerror = () => done(false, 'onerror（握手被拒）')
    socket.onclose = (e) =>
      done(false, `onclose code=${e.code} reason=${e.reason || '-'}`)
  })
}

const token = await secMsGec()
const base = `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`

const exactHeaders = {
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'Sec-WebSocket-Version': '13',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: `muid=${muid()};`,
}

const cases = [
  {
    label: '完全照抄 Python 的头 + 143 版本号',
    url: `${base}&ConnectionId=${connectId()}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`,
    headers: exactHeaders,
  },
  {
    label: '只带 Origin + Cookie',
    url: `${base}&ConnectionId=${connectId()}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`,
    headers: {
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      Cookie: `muid=${muid()};`,
    },
  },
  {
    label: '只带 Origin',
    url: `${base}&ConnectionId=${connectId()}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`,
    headers: { Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold' },
  },
  {
    label: '只带 Cookie',
    url: `${base}&ConnectionId=${connectId()}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`,
    headers: { Cookie: `muid=${muid()};` },
  },
  {
    label: '只带 User-Agent',
    url: `${base}&ConnectionId=${connectId()}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
    },
  },
]

console.log(`Sec-MS-GEC-Version = ${SEC_MS_GEC_VERSION}`)
console.log(`Sec-MS-GEC         = ${token}\n`)

for (const testCase of cases) {
  const result = await probe(testCase.label, testCase)
  console.log(
    `${result.ok ? 'OK  ' : 'FAIL'}  ${result.label.padEnd(32)} ${String(result.ms).padStart(6)}ms  ${result.detail}`,
  )
}
