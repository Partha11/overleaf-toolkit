#!/usr/bin/env node
// Read-only Chromium/CDP checks against live assets, sample tables, and project titles.
// Generate the input with: node scripts/test-ui-scopes.mjs /tmp/cloverleaf-ui-fixtures.json
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

assert.ok(process.argv[2], 'Usage: node scripts/test-session-theme.mjs <fixtures.json>')
const fixtures = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const profile = mkdtempSync(join(tmpdir(), 'cloverleaf-session-browser-'))
const browser = spawn('chromium', [
  '--headless', '--disable-gpu', '--disable-dev-shm-usage',
  '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
const browserFinished = new Promise(resolve => {
  browser.once('exit', resolve)
  browser.once('error', resolve)
})
let socket
let closeBrowser
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error('Browser startup timeout')), 20000)
    browser.once('error', error => { clearTimeout(timeout); reject(error) })
    browser.once('exit', code => {
      clearTimeout(timeout)
      reject(new Error(`Browser exited: ${code}\n${output}`))
    })
    browser.stderr.on('data', chunk => {
      output += chunk
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    })
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let id = 0
  let sessionId
  const pending = new Map()
  const events = []
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (!message.id) { events.push(message); return }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timeout)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
  const call = (method, params = {}, attached = true) => new Promise((resolve, reject) => {
    const requestId = ++id
    const timeout = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`CDP timeout: ${method}`))
    }, 20000)
    pending.set(requestId, { resolve, reject, timeout })
    socket.send(JSON.stringify({
      id: requestId, method, params, ...(attached && sessionId ? { sessionId } : {}),
    }))
  })
  closeBrowser = () => call('Browser.close', {}, false)
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' }, false)
  ;({ sessionId } = await call('Target.attachToTarget', { targetId, flatten: true }, false))
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Network.enable')
  await call('Log.enable')
  await call('Network.setBlockedURLs', { urls: ['https://*'] })
  await call('Network.setCacheDisabled', { cacheDisabled: true })
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
  })
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Page did not become ready: ${expression}`)
  }
  const snapshot = selector => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
    .map(el => {
      const c = getComputedStyle(el);
      return Object.fromEntries(['color', 'background-color', 'box-shadow', 'border-bottom-color',
        'border-bottom-width', 'width', 'height', 'font-size', 'font-weight', 'display']
        .map(p => [p, c.getPropertyValue(p)]));
    })`)
  const setCss = css => evaluate(`document.querySelector('#test-overrides').textContent = ${JSON.stringify(css)}`)
  const install = html => evaluate(`(async () => {
    document.querySelector('#main-content')?.remove();
    document.querySelector('#test-host')?.remove();
    const host = document.createElement('div');
    host.id = 'test-host';
    host.innerHTML = ${JSON.stringify(html)};
    document.body.append(host);
    await document.fonts.ready;
  })()`)
  const contrast = (foreground, background) => {
    const luminance = rgb => rgb.map(v => v / 255)
      .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
    const a = luminance(foreground)
    const b = luminance(background)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }
  for (const [saved, theme] of [['', 'default'], ['light-', 'light']]) {
    await call('Page.navigate', { url: 'http://127.0.0.1:6778/login' })
    await waitFor(`location.pathname === '/login' && document.readyState === 'complete'`)
    await evaluate(`localStorage.setItem('overallTheme', JSON.stringify(${JSON.stringify(saved)}))`)
    await call('Page.reload')
    await waitFor(`document.readyState === 'complete' && document.body?.dataset.theme === '${theme}' &&
      Array.from(document.styleSheets).some(s => s.href?.endsWith(${JSON.stringify(fixtures.assetName)}) && s.cssRules.length > 100)`)
    await evaluate(`(async () => {
      await document.fonts.ready;
      const style = document.createElement('style');
      style.id = 'test-overrides';
      style.textContent = ${JSON.stringify(fixtures.cssAfter)};
      document.querySelector('link[href$="${fixtures.assetName}"]').replaceWith(style);
      const stable = document.createElement('style');
      stable.textContent = '* { transition: none !important; animation: none !important; }';
      document.head.append(stable);
    })()`)
    const login = await snapshot('#main-content *')
    await setCss(fixtures.cssLatest)
    assert.deepEqual(await snapshot('#main-content *'), login, `${theme}: login unchanged`)
    for (const [name, html] of [
      ['Manage Users', fixtures.manageAfter], ['admin', fixtures.admin],
      ['outside session wrapper', fixtures.sessions.replace('clear-user-sessions', 'outside-sessions')],
    ]) {
      await install(html)
      await setCss(fixtures.cssAfter)
      const before = await snapshot('#test-host *:not(style)')
      await setCss(fixtures.cssLatest)
      assert.deepEqual(await snapshot('#test-host *:not(style)'), before, `${theme}: ${name} unchanged`)
    }
    await install(fixtures.sessions)
    await setCss(fixtures.cssAfter)
    const before = await snapshot('#test-host *')
    await setCss(fixtures.cssLatest)
    if (theme === 'light') {
      assert.deepEqual(await snapshot('#test-host *'), before, 'Entire light session page unchanged')
    } else {
      // Only the cells in even tbody rows should visibly change. This also
      // checks the current session's unusual data row inside thead.
      await setCss(fixtures.cssAfter)
      const unchanged = await snapshot('.clear-user-sessions thead *, .clear-user-sessions tbody tr:nth-child(odd) *')
      const oldEven = await snapshot('.clear-user-sessions tbody tr:nth-child(even) td')
      assert.equal(oldEven.length, 4, 'Two even rows with two cells each')
      assert.ok(oldEven.every(c => c['box-shadow'].startsWith('rgb(244, 245, 246)')),
        'Reproduce near-white Bootstrap stripes in v2')
      await setCss(fixtures.cssLatest)
      assert.deepEqual(await snapshot('.clear-user-sessions thead *, .clear-user-sessions tbody tr:nth-child(odd) *'),
        unchanged, 'Headers, current session, and odd rows unchanged')
      const even = await snapshot('.clear-user-sessions tbody tr:nth-child(even) td')
      assert.ok(even.every(c => c['box-shadow'] === 'rgb(39, 49, 63) 0px 0px 0px 9999px inset'),
        'Even rows use dark Bootstrap stripe shadows')
      assert.ok(even.every(c => c.color === 'rgb(232, 236, 239)'), 'Readable session text')
      for (const background of [[31, 39, 51], [39, 49, 63], [22, 28, 36]]) {
        assert.ok(contrast([232, 236, 239], background) >= 4.5, 'Session text contrast exceeds 4.5:1')
      }
      const dark = await snapshot('.clear-user-sessions td')
      await evaluate(`document.body.removeAttribute('data-theme')`)
      assert.deepEqual(await snapshot('.clear-user-sessions td'), dark, 'Pre-theme dark fallback works')
      await evaluate(`document.body.dataset.theme = 'default'`)
    }
    console.log(`PASS: ${theme} session rows, current session, and outside-page isolation.`)
    const project = `<div class="project-ds-nav-page website-redesign"><div class="project-list-wrapper">
      <div class="project-list-sidebar-wrapper-react d-none d-md-flex"><nav><ul class="list-unstyled project-list-filters">
        <li class="active"><button type="button">All projects</button></li>
        <li><button type="button">Your projects</button></li>
      </ul></nav></div>
      <div class="project-ds-nav-content-and-messages"><div class="project-ds-nav-content"><div class="project-ds-nav-main">
        <main aria-labelledby="main-content"><div class="project-list-header-row">
          <h1 id="main-content" tabindex="-1" class="project-list-title text-truncate d-none d-md-block">All projects</h1>
          <div class="project-tools"><button class="btn btn-secondary">Sample project tool</button></div>
        </div><div class="project-ds-nav-project-list">
          <table class="table"><tbody><tr><td>Sample project</td></tr></tbody></table>
        </div></main>
      </div></div></div></div></div>`
    for (const width of [1440, 768, 375]) {
      await call('Emulation.setDeviceMetricsOverride', {
        width, height: 1000, deviceScaleFactor: 1, mobile: false,
      })
      await install(project)
      await setCss(fixtures.cssCurrent)
      const before = await snapshot('#test-host *')
      const titleBefore = await snapshot('#main-content')
      await setCss(fixtures.cssLatest)
      const after = await snapshot('#test-host *')
      const titleAfter = await snapshot('#main-content')
      if (theme === 'default') {
        assert.equal(titleBefore[0]['background-color'], 'rgb(23, 29, 37)', 'Reproduce old title rectangle')
        assert.equal(titleAfter[0]['background-color'], 'rgba(0, 0, 0, 0)', 'Title blends with page')
        before.forEach((styles, i) => {
          if (JSON.stringify(styles) !== JSON.stringify(after[i])) {
            assert.deepEqual(after[i], { ...styles, 'background-color': 'rgba(0, 0, 0, 0)' },
              'Only the heading background changes')
            assert.deepEqual(styles, titleBefore[0], 'Changed element is the project heading')
          }
        })
        for (const name of ['Your projects', 'Shared with you', 'Archived projects', 'Trashed projects', 'Sample tag']) {
          await evaluate(`document.querySelector('.project-list-title').textContent = ${JSON.stringify(name)}`)
          assert.equal((await snapshot('#main-content'))[0]['background-color'], 'rgba(0, 0, 0, 0)',
            'Filter/tag titles also blend with page')
        }
        await evaluate(`document.body.removeAttribute('data-theme')`)
        assert.equal((await snapshot('#main-content'))[0]['background-color'], 'rgba(0, 0, 0, 0)',
          'Project title pre-theme dark fallback')
        await evaluate(`document.body.dataset.theme = 'default'`)
      } else {
        assert.deepEqual(after, before, 'Entire light project fixture unchanged')
      }
    }
    await call('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
    })
    console.log(`PASS: ${theme} project title at desktop/tablet/mobile widths; sidebar, tools, and table unchanged.`)
  }
  const violations = events.filter(e => e.method === 'Log.entryAdded' &&
    /content security policy|refused to load|refused to apply/i.test(e.params.entry.text))
  assert.equal(violations.length, 0, JSON.stringify(violations))
  console.log('PASS: No browser CSP violations; no real sessions or projects were accessed or changed.')
} finally {
  // Close Chromium gracefully so its cache subprocesses stop before cleanup.
  const killTimeout = setTimeout(() => browser.kill('SIGTERM'), 5000)
  try {
    if (browser.pid && browser.exitCode === null && browser.signalCode === null) {
      if (closeBrowser) await closeBrowser().catch(() => browser.kill('SIGTERM'))
      else browser.kill('SIGTERM')
    }
    await browserFinished
  } finally {
    clearTimeout(killTimeout)
    socket?.close()
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
