/**
 * 验证「音色列表缓存到 localStorage」+「搜索词被记住」。
 *
 * 做法：用真实 Edge 打开页面，注入一份假的完整音色列表 + 搜索词，
 * 刷新后检查列表是否直接从缓存恢复。
 *
 * 运行：node tools/voices-cache-check.mjs http://localhost:4173/Edge-TTS/
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const targetUrl = process.argv[2] ?? 'http://localhost:4173/Edge-TTS/'
const PORT = 9334
const profile = mkdtempSync(join(tmpdir(), 'dsh-edge-cache-'))

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getWsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const json = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl
    } catch {
      /* 等 */
    }
    await sleep(250)
  }
  throw new Error('Edge 调试端口没起来')
}

const socket = new WebSocket(await getWsUrl())
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})

let id = 0
const pending = new Map()
socket.onmessage = (raw) => {
  const msg = JSON.parse(raw.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}

function send(method, params = {}, sessionId) {
  id += 1
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((resolve) => pending.set(id, resolve))
}

function unwrap(response) {
  return response?.result?.value ?? response?.result?.description ?? ''
}

const { result: target } = await send('Target.createTarget', { url: 'about:blank' })
const { result: attached } = await send('Target.attachToTarget', {
  targetId: target.targetId,
  flatten: true,
})
const session = attached.sessionId

await send('Runtime.enable', {}, session)
await send('Page.enable', {}, session)

/* ---------- 第一次打开：注入假的完整音色列表 ---------- */

await send('Page.navigate', { url: targetUrl }, session)
await sleep(5000)

const seed = `
(() => {
  const voices = []
  for (let i = 0; i < 322; i++) {
    voices.push({
      id: 'zh-CN-Test' + String(i).padStart(3, '0') + 'Neural',
      name: '测试音色' + i,
      gender: i % 2 ? '女' : '男',
    })
  }
  localStorage.setItem(
    'edge-tts-web.voices.v1',
    JSON.stringify({ fetchedAt: Date.now(), voices }),
  )
  const s = JSON.parse(localStorage.getItem('edge-tts-web.settings.v1') || '{}')
  s.voiceSearch = 'zh-CN-Test01'
  s.voice = 'zh-CN-Test007Neural'
  localStorage.setItem('edge-tts-web.settings.v1', JSON.stringify(s))
  return voices.length
})()
`
const { result: seedResult } = await send(
  'Runtime.evaluate',
  { expression: seed, returnByValue: true, awaitPromise: true },
  session,
)
console.log('注入缓存条数:', unwrap(seedResult))

/* ---------- 刷新，看是否从缓存恢复 ---------- */

await send('Page.navigate', { url: targetUrl }, session)
await sleep(5000)

const read = `
JSON.stringify({
  voiceCount: document.querySelector('#voice')?.options.length ?? 0,
  voiceValue: document.querySelector('#voice')?.value ?? '',
  voiceSearch: document.querySelector('#voice-search')?.value ?? '',
  firstOption: document.querySelector('#voice')?.options[0]?.textContent ?? '',
  autoPlay: document.querySelector('#auto-play')?.checked ?? null,
  log: (document.querySelector('#log')?.textContent ?? '').slice(-300),
})
`
const { result: readResult } = await send(
  'Runtime.evaluate',
  { expression: read, returnByValue: true, awaitPromise: true },
  session,
)
const state = JSON.parse(unwrap(readResult) || '{}')

console.log('\n=== 刷新后的状态 ===')
console.log('音色数量  :', state.voiceCount, state.voiceCount > 6 ? '✅ 用的是缓存的完整列表' : '❌ 还是内置 6 个')
console.log('当前音色  :', state.voiceValue, state.voiceValue.includes('Test007') ? '✅ 记住了上次选的' : '❌ 没记住')
console.log('搜索词    :', JSON.stringify(state.voiceSearch), state.voiceSearch === 'zh-CN-Test01' ? '✅ 记住了' : '❌ 没记住')
console.log('首项文案  :', state.firstOption)
console.log('自动播放  :', state.autoPlay)

/* ---------- 再验证「恢复默认」会清掉缓存 ---------- */

await send(
  'Runtime.evaluate',
  { expression: `document.querySelector('#reset-settings').click()`, returnByValue: true },
  session,
)
await sleep(1500)

const { result: afterReset } = await send(
  'Runtime.evaluate',
  {
    expression: `JSON.stringify({
      voiceSearch: document.querySelector('#voice-search')?.value ?? '',
      voiceCount: document.querySelector('#voice')?.options.length ?? 0,
      autoPlay: document.querySelector('#auto-play')?.checked ?? null,
      cache: localStorage.getItem('edge-tts-web.voices.v1') ? 'still-there' : 'cleared',
    })`,
    returnByValue: true,
    awaitPromise: true,
  },
  session,
)
console.log('\n=== 点「恢复默认」之后 ===')
console.log(unwrap(afterReset))

socket.close()
edge.kill()
await sleep(500)
rmSync(profile, { recursive: true, force: true })
process.exit(0)
