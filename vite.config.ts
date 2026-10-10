import { defineConfig } from 'vite'

/**
 * GitHub Pages 项目站点会部署到：
 *
 *     https://<用户名>.github.io/<仓库名>/
 *
 * 所以 base 必须是仓库名。如果你的仓库名不是 Edge-TTS，
 * 请把下面这一行改成 `'/<你的仓库名>/'`。
 *
 * 如果部署到用户站点仓库（norohime.github.io）的子目录，
 * 则改成 `'/Edge-TTS/'` 也是一样的写法。
 */
const REPO_NAME = 'Edge-TTS'

export default defineConfig({
  base: `/${REPO_NAME}/`,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
  },
  server: {
    port: 5173,
    open: false,
  },
})
