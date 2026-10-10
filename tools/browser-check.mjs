/**
 * 用真实 Edge（headless + CDP）跑一遍应用，抓控制台错误和实际发出的 WebSocket 请求。
 *
 * 用途：不再靠推理判断「页面到底能不能合成」，直接看真实浏览器行为。
 *
 * 运行：node tools/browser-check.mjs <页面地址>
 *   例：node tools/browser-check.mjs http://localhost:5173/Edge-TTS/
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const targetUrl = process.argv[2] ?? 'http://localhost:5173/Edge-TTS/'
const PORT = 9333

const profile = mkdtempSync(join(tmpdir(), 'dsh-edge-'))

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getWsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      const json = await res.json()
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  throw new Error('Edge 调试端口没起来')
}

const browserWs = await getWsUrl()
const socket = new WebSocket(browserWs)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})

let id = 0
const pending = new Map()
const events = []

socket.onmessage = (raw) => {
  const msg = JSON.parse(raw.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
    return
  }
  events.push(msg)
}

function send(method, params = {}, sessionId) {
  id += 1
  const payload = { id, method, params }
  if (sessionId) payload.sessionId = sessionId
  socket.send(JSON.stringify(payload))
  return new Promise((resolve) => pending.set(id, resolve))
}

// 新建一个标签页并 attach
const { result: target } = await send('Target.createTarget', { url: 'about:blank' })
const { result: attached } = await send('Target.attachToTarget', {
  targetId: target.targetId,
  flatten: true,
})
const session = attached.sessionId

await send('Runtime.enable', {}, session)
await send('Log.enable', {}, session)
await send('Network.enable', {}, session)
await send('Page.enable', {}, session)

const consoleLines = []
const wsCreations = []
const wsFailures = []

// 收集事件
const collector = setInterval(() => {
  while (events.length > 0) {
    const event = events.shift()

    if (event.method === 'Runtime.consoleAPICalled') {
      const text = (event.params.args ?? [])
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ')
      consoleLines.push(`[console.${event.params.type}] ${text}`)
    }

    if (event.method === 'Log.entryAdded') {
      consoleLines.push(`[log.${event.params.entry.level}] ${event.params.entry.text}`)
    }

    if (event.method === 'Network.webSocketCreated') {
      wsCreations.push(event.params.url)
    }

    if (event.method === 'Network.webSocketFrameError') {
      wsFailures.push(event.params.errorMessage)
    }

    if (event.method === 'Network.webSocketClosed') {
      wsFailures.push(`closed: ${JSON.stringify(event.params)}`)
    }

    if (event.method === 'Runtime.exceptionThrown') {
      consoleLines.push(
        `[exception] ${event.params.exceptionDetails?.exception?.description ?? event.params.exceptionDetails?.text}`,
      )
    }
  }
}, 50)

// 打开页面
await send('Page.navigate', { url: targetUrl }, session)
await sleep(6000)

// 往文本框里塞文字并点击「开始生成」
const script = `
(() => {
  const text = document.querySelector('#source-text')
  if (!text) return 'no textarea'
  text.value = '你好，这是一次自动化测试。'
  text.dispatchEvent(new Event('input', { bubbles: true }))
  const start = document.querySelector('#start')
  if (!start) return 'no start button'
  start.click()
  return 'clicked'
})()
`
/**
 * 取 CDP Runtime.evaluate 的结果。
 *
 * 注意：CDP 返回的是 { result: { type, value } }，
 * 也就是「我们脚本返回的对象」本身还要再取一层 .value。
 */
function unwrap(response) {
  return response?.result?.value ?? response?.result?.description ?? ''
}

const { result: clickResult } = await send(
  'Runtime.evaluate',
  { expression: script, returnByValue: true, awaitPromise: true },
  session,
)

console.log('页面:', targetUrl)
console.log('点击结果:', unwrap(clickResult) || JSON.stringify(clickResult))

// 等合成结束
await sleep(30000)

// 读页面状态
const { result: statusResult } = await send(
  'Runtime.evaluate',
  {
    expression: `JSON.stringify({
      status: document.querySelector('#status')?.textContent ?? '',
      segments: document.querySelector('#segment-summary')?.textContent ?? '',
      voiceCount: document.querySelector('#voice')?.options.length ?? 0,
      voiceValue: document.querySelector('#voice')?.value ?? '',
      voiceSearch: document.querySelector('#voice-search')?.value ?? '',
      autoPlay: document.querySelector('#auto-play')?.checked ?? null,
      title: document.querySelector('h1')?.textContent ?? '',
      nowPlaying: document.querySelector('#now-playing')?.textContent ?? '',
      segmentItems: [...document.querySelectorAll('.segment-item')].map(
        (el) => el.querySelector('.dur')?.textContent ?? '',
      ),
      // 检查设置面板有没有横向溢出（长标签被挤出去的表现）
      panelOverflow: (() => {
        const panel = document.querySelector('.layout-top .panel')
        if (!panel) return null
        const grid = panel.querySelector('.form-grid')
        return {
          panelScrollW: panel.scrollWidth,
          panelClientW: panel.clientWidth,
          gridScrollW: grid?.scrollWidth ?? 0,
          gridClientW: grid?.clientWidth ?? 0,
          bodyScrollW: document.body.scrollWidth,
          bodyClientW: document.body.clientWidth,
        }
      })(),
      log: (document.querySelector('#log')?.textContent ?? '').slice(-2000),
    })`,
    returnByValue: true,
    awaitPromise: true,
  },
  session,
)

clearInterval(collector)

console.log('\n=== 页面状态 ===')
const state = JSON.parse(unwrap(statusResult) || '{}')
console.log('状态栏    :', state.status)
console.log('标题      :', state.title)
console.log('片段      :', state.segments)
console.log('音色数量  :', state.voiceCount)
console.log('当前音色  :', state.voiceValue)
console.log('音色搜索  :', JSON.stringify(state.voiceSearch))
console.log('自动播放  :', state.autoPlay)
console.log('当前播放  :', state.nowPlaying)
console.log('片段时长  :', JSON.stringify(state.segmentItems))

if (state.panelOverflow) {
  const o = state.panelOverflow
  const overflow = o.panelScrollW > o.panelClientW || o.bodyScrollW > o.bodyClientW
  console.log(
    `布局溢出  : ${overflow ? '❌ 有横向溢出' : '✅ 无横向溢出'}  ` +
      `panel ${o.panelScrollW}/${o.panelClientW}  grid ${o.gridScrollW}/${o.gridClientW}  ` +
      `body ${o.bodyScrollW}/${o.bodyClientW}`,
  )
}

console.log('\n=== WebSocket 连接 ===')
for (const url of wsCreations) console.log('  ' + url.slice(0, 120))

console.log('\n=== WebSocket 错误 ===')
if (wsFailures.length === 0) console.log('  (无)')
for (const f of wsFailures.slice(0, 5)) console.log('  ' + f.slice(0, 200))

console.log('\n=== 控制台输出（尾部） ===')
for (const line of consoleLines.slice(-25)) console.log('  ' + line.slice(0, 220))

console.log('\n=== 页面日志区（尾部） ===')
console.log(
  (state.log ?? '')
    .split('\n')
    .slice(-16)
    .map((l) => '  ' + l)
    .join('\n'),
)

socket.close()
edge.kill()
await sleep(500)
rmSync(profile, { recursive: true, force: true })
process.exit(0)
