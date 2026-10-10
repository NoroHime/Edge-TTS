/**
 * 一键本地开发：同时启动 Node 中转 + Vite 开发服务器。
 *
 * 等价于 proxy/dev.ps1，但跨平台（Windows / macOS / Linux 都能用）。
 *
 * 用法：
 *   node proxy/dev.mjs
 *
 * 然后打开 http://localhost:5173/Edge-TTS/
 */

import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PROXY_PORT = 8787

function run(command, args, options = {}) {
  return spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })
}

/* 1) 确认 ws 依赖 */

if (!existsSync(join(root, 'node_modules', 'ws'))) {
  console.log('安装 ws（中转需要）...')
  const install = run('pnpm', ['add', '-D', 'ws'])
  await new Promise((resolve) => install.on('exit', resolve))
}

/* 2) 写 .env.local（已在 .gitignore 里） */

writeFileSync(
  join(root, '.env.local'),
  `VITE_EDGE_TTS_PROXY=ws://127.0.0.1:${PROXY_PORT}\n`,
  'utf8',
)
console.log('已写入 .env.local')

/* 3) 启动中转 */

console.log(`启动本地中转 ws://127.0.0.1:${PROXY_PORT} ...`)
const proxy = run('node', [join(root, 'proxy', 'node-proxy.mjs')])

await new Promise((resolve) => setTimeout(resolve, 2000))

try {
  const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/`)

  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  console.log('中转就绪')
} catch (error) {
  console.error(`中转启动失败：${error.message}（${PROXY_PORT} 端口可能被占用）`)
  proxy.kill()
  process.exit(1)
}

/* 4) 启动 dev server，退出时一并收尾 */

const dev = run('pnpm', ['dev'])

const shutdown = () => {
  proxy.kill()
  dev.kill()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
dev.on('exit', shutdown)

console.log('\n=== 打开这个地址 ===')
console.log('  http://localhost:5173/Edge-TTS/\n')
