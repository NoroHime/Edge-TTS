/**
 * 界面模板。
 *
 * 对应 Python 版 MainWindow._build_ui()：
 *   设置 / 文本 / 进度 / 片段 / 播放 / 日志
 */

export function renderTemplate(root: HTMLElement): void {
  root.innerHTML = `
    <header class="app-header">
      <h1>novel-tts Web</h1>
      <span class="tag">Edge TTS</span>
      <p class="subtitle">小说分段朗读：边生成边播放，可导出完整 WAV</p>
      <span class="links">
        <a href="https://github.com/NoroHime/Edge-TTS" target="_blank" rel="noopener noreferrer">GitHub</a>
      </span>
    </header>

    <div class="notice">
      合成由微软 Edge 在线接口完成，需要联网；这是非公开接口，随时可能变更。
      首次使用建议点右侧「获取全部」载入完整音色列表。
    </div>

    <section class="layout-top">
      <div class="panel">
        <h2>设置</h2>
        <div class="form-grid">
          <label for="engine">引擎</label>
          <select id="engine">
            <option value="edge" selected>Edge TTS（在线）</option>
          </select>

          <label for="voice-filter">音色</label>
          <div class="field-row">
            <select id="voice"></select>
            <button id="fetch-voices" class="icon" type="button" title="从微软接口拉取完整音色列表（HTTPS 页面请求 HTTP 接口时可能被浏览器拦截）">获取全部</button>
          </div>

          <label for="voice-search">搜索音色</label>
          <div class="field-row">
            <input id="voice-search" type="search" placeholder="如 zh-CN、Xiaoxiao、晓晓" autocomplete="off" value="zh">
          </div>

          <label for="rate">语速</label>
          <div class="field-row">
            <select id="rate">
              <option value="-50%">-50%</option>
              <option value="-25%">-25%</option>
              <option value="-10%">-10%</option>
              <option value="+0%" selected>+0%（默认）</option>
              <option value="+10%">+10%</option>
              <option value="+20%">+20%</option>
              <option value="+35%">+35%</option>
              <option value="+50%">+50%</option>
              <option value="+75%">+75%</option>
              <option value="+100%">+100%</option>
            </select>
          </div>

          <label for="pitch">音调</label>
          <div class="field-row">
            <select id="pitch">
              <option value="-50Hz">-50Hz</option>
              <option value="-25Hz">-25Hz</option>
              <option value="+0Hz" selected>+0Hz（默认）</option>
              <option value="+25Hz">+25Hz</option>
              <option value="+50Hz">+50Hz</option>
            </select>
          </div>

          <label for="volume">音量</label>
          <select id="volume">
            <option value="-50%">-50%</option>
            <option value="-25%">-25%</option>
            <option value="+0%" selected>+0%（默认）</option>
            <option value="+25%">+25%</option>
            <option value="+50%">+50%</option>
          </select>

          <label for="instruction">自定义指令</label>
          <div class="field-row">
            <input id="instruction" type="text" placeholder="可选；当前引擎不支持，仅作记录" autocomplete="off">
          </div>

          <label for="max-chars">每段最大长度</label>
          <div class="field-row">
            <input id="max-chars" type="number" min="60" max="500" step="10" value="500">
            <span style="color: var(--text-faint); font-size: 12px;">字/段</span>
          </div>

          <label for="min-chars">每段最少长度</label>
          <div class="field-row">
            <input id="min-chars" type="number" min="0" max="500" step="10" value="480">
            <span style="color: var(--text-faint); font-size: 12px;">字/段</span>
          </div>

          <label for="pause">片段间停顿</label>
          <div class="field-row">
            <input id="pause" type="number" min="0" max="2000" step="10" value="80">
            <span style="color: var(--text-faint); font-size: 12px;">ms</span>
          </div>

          <span></span>
          <label class="inline nowrap" for="auto-play">
            <input id="auto-play" type="checkbox" checked>
            <span>生成完第一段自动播放</span>
          </label>

          <span></span>
          <label class="inline nowrap" for="auto-export">
            <input id="auto-export" type="checkbox">
            <span>全部完成后自动导出 WAV</span>
          </label>

          <span></span>
          <div class="inline">
            <button id="start" class="primary" type="button">开始生成</button>
            <button id="stop-generate" type="button" disabled>停止生成</button>
            <button id="reset-settings" type="button" title="清除 localStorage 里保存的设置，并恢复所有默认值">恢复默认</button>
          </div>
        </div>
      </div>

      <div class="panel">
        <h2>待朗读文本</h2>
        <div class="textarea-wrap">
          <textarea id="source-text" placeholder="把小说粘贴到这里。按句号、问号、感叹号等标点自动分段，过短的片段会与相邻内容合并。"></textarea>
          <div class="text-toolbar">
            <button id="open-txt" type="button">打开 TXT</button>
            <button id="clear-text" type="button">清空</button>
            <input id="txt-input" type="file" accept=".txt,text/plain" hidden>
            <span class="counter" id="char-count">0 字</span>
          </div>
        </div>
      </div>
    </section>

    <div class="progress-row">
      <div class="progress-track" id="progress-track">
        <div class="progress-bar" id="progress-bar"></div>
      </div>
      <span class="status-line" id="status">状态：就绪。粘贴文本后点「开始生成」。</span>
    </div>

    <section class="layout-bottom">
      <div class="panel">
        <h2>片段 <span class="hint" id="segment-summary"></span></h2>
        <ul class="segment-list" id="segment-list"></ul>
      </div>

      <div class="panel">
        <h2>播放 <span class="hint">自动接续，播完最后一段停止</span></h2>

        <div class="playback-controls">
          <button id="play-all" type="button">播放全部</button>
          <button id="play-pause" type="button">播放</button>
          <button id="previous" type="button">上一段</button>
          <button id="next" type="button">下一段</button>
          <button id="stop-play" type="button">停止</button>
          <span class="spacer"></span>
          <button id="export-wav" type="button" disabled>导出 WAV</button>
        </div>

        <div class="player-row">
          <span class="time" id="time-current">00:00</span>
          <input id="progress-seek" type="range" min="0" max="1000" value="0" step="1">
          <span class="time" id="time-total">00:00</span>
        </div>

        <div class="slider-row">
          <span>播放音量</span>
          <input id="play-volume" type="range" min="0" max="100" value="100">
          <span class="value" id="play-volume-value">100%</span>
        </div>

        <div class="slider-row">
          <span>播放速度</span>
          <input id="play-rate" type="range" min="50" max="200" value="110" step="5">
          <span class="value" id="play-rate-value">1.10x</span>
        </div>

        <div class="player-row" style="margin-bottom: 0;">
          <span id="now-playing">当前片段：—</span>
        </div>
      </div>
    </section>

    <section class="panel log-panel">
      <h2>日志</h2>
      <pre class="log-view" id="log"></pre>
    </section>

    <footer class="app-footer">
      novel-tts Web · Edge TTS &nbsp;|&nbsp; 移植自 Python 版
      <code>GUI_QWENv6.pyw</code>
    </footer>
  `
}
