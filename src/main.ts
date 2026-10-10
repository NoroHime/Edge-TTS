/**
 * 程序入口（对应 Python 版的 main()）。
 */

import './styles.css'

import { NovelTtsApp } from './app.ts'
import { renderTemplate } from './template.ts'
import { consolePrint } from './utils.ts'

function main(): void {
  const root = document.getElementById('app')

  if (!root) {
    throw new Error('找不到 #app 容器。')
  }

  renderTemplate(root)

  try {
    new NovelTtsApp()
  } catch (error) {
    consolePrint(`初始化失败：${String(error)}`)

    const notice = document.createElement('div')
    notice.className = 'notice'
    notice.textContent = `初始化失败：${String(error)}`

    root.prepend(notice)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main)
} else {
  main()
}
