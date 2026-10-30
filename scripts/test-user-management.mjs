#!/usr/bin/env node
// Isolated browser tests: real CSP/sendFile code, sample users, mocked mutations.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

assert.ok(process.argv[2], 'Usage: node scripts/test-user-management.mjs <fixtures.json>')
const fixtures = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const script = readFileSync(new URL('../overrides/user-management.js', import.meta.url), 'utf8')
const template = readFileSync(new URL('../overrides/manage_users.pug', import.meta.url), 'utf8')
function setupFixture() {
  const state = window.testState = {
    requests: [], clipboard: [], confirms: [], listeners: [], errors: [],
    responses: {}, rejectNext: false, confirm: true, atDcl: null, holdClipboard: false,
  }
  const add = EventTarget.prototype.addEventListener
  EventTarget.prototype.addEventListener = function (type, ...args) {
    if (['user-search', 'filter-role', 'users-tbody', 'register-form'].includes(this.id)) {
      state.listeners.push({ id: this.id, type, ready: document.readyState })
    }
    return add.call(this, type, ...args)
  }
  window.addEventListener('error', e => state.errors.push(e.message))
  window.addEventListener('unhandledrejection', e => state.errors.push(String(e.reason)))
  window.confirm = message => { state.confirms.push(message); return state.confirm }
  const clipboardWaiters = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: async text => {
      state.clipboard.push(text)
      if (state.holdClipboard) await new Promise(resolve => clipboardWaiters.push(resolve))
    } },
  })
  window.releaseClipboard = () => {
    state.holdClipboard = false
    clipboardWaiters.splice(0).forEach(resolve => resolve())
  }
  document.execCommand = () => {
    state.clipboard.push(document.querySelector('textarea')?.value)
    return true
  }
  window.fetch = async (url, options) => {
    if (options?.method !== 'POST' || !/^\/admin\//.test(url)) throw new Error('Unexpected fixture request')
    state.requests.push({ url, headers: options.headers, body: JSON.parse(options.body) })
    if (state.rejectNext) { state.rejectNext = false; throw new Error('Fixture network failure') }
    const response = state.responses[url]
    if (!response) throw new Error(`No mock response for ${url}`)
    return { json: async () => response }
  }
  document.addEventListener('DOMContentLoaded', () => {
    state.atDcl = { total: document.querySelector('#stat-total')?.textContent, listeners: state.listeners.length }
  })
}

// Run Express and the installed CSP middleware on container loopback only.
// Extract only serveJs, avoiding controller imports that initialize databases.
async function checkDelivery() {
  const fs = require('node:fs')
  const Path = require('node:path')
  const vm = require('node:vm')
  const assert = require('node:assert/strict')
  const express = require('/overleaf/node_modules/express')
  const CSP = (await import('/overleaf/services/web/app/src/infrastructure/CSP.mjs')).default
  const input = JSON.parse(fs.readFileSync(0, 'utf8'))
  const directory = '/overleaf/services/web/modules/user-activate/app/src'
  const source = fs.readFileSync(`${directory}/UserActivateController.mjs`, 'utf8')
  const match = source.match(/async function serveJs\(req, res\) \{[\s\S]*?\n\}/)
  assert.ok(match, 'Existing script handler must be present')
  const serveJs = new vm.Script(`(${match[0]})`).runInNewContext({ Path, __dirname: directory })
  assert.equal(fs.readFileSync(`${directory}/user-management.js`, 'utf8'), input.script,
    'Mounted external implementation differs from repository')
  assert.equal(fs.readFileSync(`${directory}/../views/user/manage_users.pug`, 'utf8'), input.template,
    'Mounted template differs from repository; recreate the web container to refresh its mount')
  const app = express()
  app.use((req, res, next) => {
    res.render = (filename, options = {}) => {
      const nonce = res.locals.scriptNonce
      let tag = input.managementScriptTag.replace('fixture-nonce', nonce)
      if (options.negative) tag = tag.replace(` nonce="${nonce}"`, '')
      res.send(`<!doctype html><html><head><meta charset="utf-8">
        ${input.styles.map(href => `<link rel="stylesheet" href="${href}">`).join('')}
        <script nonce="${nonce}">(${input.setup})()</script>
        </head><body data-theme="default">${options.empty ? input.manageEmpty : input.manageAfter}${tag}</body></html>`)
    }
    next()
  })
  app.use(CSP({ reportPercentage: 0 }))
  app.get('/fixture', (req, res) => res.render(`${directory}/../views/user/manage_users.pug`, {
    negative: req.query.negative === '1', empty: req.query.empty === '1',
  }))
  app.get('/admin/user-management.js', serveJs)
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const capture = async url => {
      const r = await fetch(base + url)
      return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() }
    }
    const js = await capture(input.managementScriptUrl)
    assert.equal(js.status, 200)
    assert.match(js.headers['content-type'], /application\/javascript/)
    assert.equal(js.body, input.script)
    assert.match(js.headers['cache-control'], /max-age=0/)
    assert.ok(js.headers.etag && js.headers['last-modified'])
    // Node fetch adds Cache-Control: no-cache to conditional requests, which
    // intentionally bypasses Express's freshness check. Use a raw HTTP request.
    const conditionalStatus = await new Promise((resolve, reject) => {
      require('node:http').get(base + input.managementScriptUrl, {
        headers: { 'If-None-Match': js.headers.etag },
      }, response => {
        response.resume()
        resolve(response.statusCode)
      }).on('error', reject)
    })
    assert.equal(conditionalStatus, 304)
    process.stdout.write(JSON.stringify({
      js, page: await capture('/fixture'), empty: await capture('/fixture?empty=1'),
      negative: await capture('/fixture?negative=1'),
    }))
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

const base = 'http://127.0.0.1:6778'
const login = await fetch(`${base}/login`)
const styles = Array.from((await login.text()).matchAll(/<link\b[^>]*href="([^"]*\/stylesheets\/[^"]+)"/g),
  m => m[1])
assert.ok(styles.length >= 2, 'Live base and custom stylesheets are available')
const unauthorized = await fetch(base + fixtures.managementScriptUrl, { redirect: 'manual' })
assert.equal(unauthorized.status, 302, 'Live script route must remain protected')
assert.equal(unauthorized.headers.get('location'), '/login')
const result = spawnSync('docker', ['exec', '-i', 'sharelatex', 'node', '-e',
  `(${checkDelivery.toString()})().catch(e => { console.error(e); process.exit(1) })`], {
  input: JSON.stringify({ ...fixtures, script, template, styles, setup: setupFixture.toString() }),
  encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
})
if (result.error) throw result.error
assert.equal(result.status, 0, result.stderr)
const delivery = JSON.parse(result.stdout)
assert.match(delivery.page.headers['content-security-policy'], /'strict-dynamic'/)
console.log('PASS: existing admin route protection; actual sendFile 200/304 and CSP middleware.')

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
  const interceptionErrors = []
  let deliveredScripts = 0
  socket.addEventListener('message', async ({ data }) => {
    const message = JSON.parse(data)
    if (message.method !== 'Fetch.requestPaused') return
    const { requestId, request } = message.params
    try {
      const url = new URL(request.url)
      let response
      if (request.method !== 'GET') {
        interceptionErrors.push(`A real mutation escaped the fixture: ${request.method} ${url.pathname}`)
        response = { status: 500, headers: {}, body: '' }
      } else if (url.pathname === '/admin/user') {
        response = url.searchParams.has('negative') ? delivery.negative
          : url.searchParams.has('empty') ? delivery.empty : delivery.page
      } else if (url.pathname === '/admin/user-management.js') {
        assert.equal(url.pathname + url.search, fixtures.managementScriptUrl)
        await new Promise(resolve => setTimeout(resolve, 150))
        deliveredScripts++
        response = delivery.js
      } else if (/^\/(?:stylesheets|fonts|img|images)\//.test(url.pathname)) {
        await call('Fetch.continueRequest', { requestId })
        return
      } else response = { status: 204, headers: {}, body: '' }
      await call('Fetch.fulfillRequest', {
        requestId, responseCode: response.status,
        responseHeaders: Object.entries(response.headers)
          .filter(([name]) => !['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(name))
          .map(([name, value]) => ({ name, value })),
        body: Buffer.from(response.body).toString('base64'),
      })
    } catch (error) {
      interceptionErrors.push(String(error))
      await call('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {})
    }
  })
  await call('Fetch.enable', { patterns: [{ urlPattern: `${base}/*`, requestStage: 'Request' }] })
  const waitFor = async expression => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(expression)) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Fixture timeout: ${expression}`)
  }
  const load = async suffix => {
    await call('Page.navigate', { url: `${base}/admin/user?fixture=1${suffix || ''}` })
    await waitFor(`document.readyState === 'complete' && !!window.testState?.atDcl`)
  }
  const state = () => evaluate('window.testState')
  const stats = () => evaluate(`['total','active','pending','admins'].map(id =>
    Number(document.querySelector('#stat-' + id).textContent))`)
  const visible = () => evaluate(`Array.from(document.querySelectorAll('#users-tbody tr[data-user-id]'))
    .filter(row => row.style.display !== 'none').map(row => row.dataset.userId)`)
  const search = async (text, role = 'all') => {
    await evaluate(`document.querySelector('#user-search').value = ${JSON.stringify(text)};
      document.querySelector('#filter-role').value = ${JSON.stringify(role)};
      document.querySelector('#user-search').dispatchEvent(new Event('input'));
      document.querySelector('#filter-role').dispatchEvent(new Event('change'));`)
  }
  const mock = (url, data) => evaluate(`window.testState.responses[${JSON.stringify(url)}] = ${JSON.stringify(data)}`)
  const click = async selector => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await waitFor(`!Array.from(document.querySelectorAll('#users-tbody button, #btn-register')).some(b => b.disabled)`)
  }
  const register = async emails => {
    await evaluate(`document.querySelector('#register-emails').value = ${JSON.stringify(emails)};
      document.querySelector('#register-form').requestSubmit()`)
    await waitFor(`!document.querySelector('#btn-register').disabled`)
  }
  await load()
  const initialized = await state()
  assert.deepEqual(initialized.atDcl, { total: '3', listeners: 4 })
  assert.equal(initialized.listeners.length, 4, 'Exactly one set of event listeners')
  assert.ok(initialized.listeners.every(l => l.ready === 'interactive'), 'defer executes after parsing, before DCL')
  assert.deepEqual(await stats(), [3, 2, 1, 1])
  for (const [text, role, ids] of [
    [' ada ', 'all', ['current']], ['ACTIVE@', 'all', ['active']],
    ['', 'admin', ['current']], ['', 'user', ['active', 'pending']],
    ['', 'active', ['current', 'active']], ['', 'pending', ['pending']],
    ['no-match', 'all', []],
  ]) {
    await search(text, role)
    assert.deepEqual(await visible(), ids)
    assert.equal(await evaluate(`Number(document.querySelector('#filtered-count').textContent)`), ids.length)
    assert.equal(await evaluate(`document.querySelector('#no-users-message').classList.contains('d-none')`), !!ids.length)
  }
  await search('')
  const resetUrl = '/admin/user/active/reset-password'
  const link = `${base}/user/password/set?fixture-token=sample`
  await mock(resetUrl, { success: true, email: 'active@example.test', setNewPasswordUrl: link })
  // Inspect the banner before successful copying replaces it with a notification.
  await evaluate('window.testState.holdClipboard = true')
  await click('#user-row-active .btn-reset-link .material-symbols')
  assert.equal(await evaluate(`document.querySelector('#flash-container input').value`), link)
  assert.deepEqual((await state()).clipboard, [link])
  await click('#flash-container .btn-copy-inline')
  assert.deepEqual((await state()).clipboard, [link, link])
  await evaluate('window.releaseClipboard()')
  await waitFor(`document.querySelector('#flash-container').textContent.includes('Link copied to clipboard!')`)
  await evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })`)
  await click('#user-row-active .btn-reset-link')
  assert.deepEqual((await state()).clipboard, [link, link, link], 'Fallback copying works without Clipboard API')
  const toggleUrl = '/admin/user/active/toggle-admin'
  for (const isAdmin of [true, false]) {
    await mock(toggleUrl, { success: true, isAdmin })
    await click('#user-row-active .btn-toggle-admin')
    assert.equal(await evaluate(`document.querySelector('#user-row-active').dataset.isAdmin`), String(isAdmin))
    assert.equal((await stats())[3], isAdmin ? 2 : 1)
    assert.equal(await evaluate(`document.querySelector('#user-row-active .role-badge').textContent`), isAdmin ? 'Admin' : 'User')
  }
  await evaluate('window.testState.confirm = false')
  const countBeforeCancel = (await state()).requests.length
  await click('#user-row-active .btn-toggle-admin')
  assert.equal((await state()).requests.length, countBeforeCancel)
  await evaluate('window.testState.confirm = true')
  await mock('/admin/register', { results: [
    { _id: 'new-a', email: 'new-a@example.test', success: true, emailSent: true, setNewPasswordUrl: link },
    { _id: 'new-b', email: 'new-b@example.test', success: true, emailError: 'Fixture SMTP error', setNewPasswordUrl: link },
    { _id: 'active', email: 'active@example.test', success: true, setNewPasswordUrl: link },
    { email: 'invalid@example.test', success: false, error: 'Fixture registration failure' },
  ] })
  await register('new-a@example.test, new-b@example.test, active@example.test, invalid@example.test')
  assert.deepEqual(await stats(), [5, 2, 3, 1])
  assert.equal(await evaluate(`document.querySelectorAll('#register-results-body tr').length`), 4)
  assert.equal(await evaluate(`document.querySelectorAll('#user-row-active').length`), 1, 'No duplicate row')
  assert.equal(await evaluate(`document.querySelector('#register-emails').value`), '')
  assert.equal(await evaluate(`document.querySelector('#register-spinner').classList.contains('d-none')`), true)
  await click('#register-results-body .btn-copy-link')
  assert.equal((await state()).clipboard.at(-1), link)
  await search('new-a')
  assert.deepEqual(await visible(), ['new-a'], 'Dynamically inserted rows are searchable')
  await search('')
  await mock('/admin/user/new-a/reset-password', { success: true, setNewPasswordUrl: link })
  await click('#user-row-new-a .btn-reset-link')
  assert.equal((await state()).clipboard.at(-1), link, 'Delegated actions work on newly inserted rows')
  await evaluate('window.testState.confirm = false')
  const beforeDeleteCancel = (await state()).requests.length
  await click('#user-row-new-a .btn-delete-user')
  assert.equal((await state()).requests.length, beforeDeleteCancel)
  await evaluate('window.testState.confirm = true')
  await mock('/admin/user/new-a/delete', { success: false, error: 'Fixture deletion denied' })
  await click('#user-row-new-a .btn-delete-user')
  assert.equal(await evaluate(`!!document.querySelector('#user-row-new-a')`), true)
  await mock('/admin/user/new-a/delete', { success: true })
  await click('#user-row-new-a .btn-delete-user')
  assert.equal(await evaluate(`!!document.querySelector('#user-row-new-a')`), false)
  assert.deepEqual(await stats(), [4, 2, 2, 1])
  await mock(toggleUrl, { success: false, error: 'Fixture promotion denied' })
  await click('#user-row-active .btn-toggle-admin')
  assert.equal((await stats())[3], 1)
  await mock(resetUrl, { success: false, error: 'Fixture link denied' })
  await click('#user-row-active .btn-reset-link')
  assert.match(await evaluate(`document.querySelector('#flash-container').textContent`), /Fixture link denied/)
  await evaluate('window.testState.rejectNext = true')
  await click('#user-row-active .btn-reset-link')
  assert.match(await evaluate(`document.querySelector('#flash-container').textContent`), /Fixture network failure/)
  await mock('/admin/register', { error: 'Fixture registration denied' })
  await register('failed@example.test')
  assert.match(await evaluate(`document.querySelector('#flash-container').textContent`), /Fixture registration denied/)
  const actions = await state()
  assert.deepEqual(actions.errors, [])
  assert.ok(actions.requests.length > 10)
  assert.ok(actions.requests.every(r =>
    r.headers['X-Csrf-Token'] === 'fixture-csrf' && r.body._csrf === 'fixture-csrf' &&
    r.headers['Content-Type'] === 'application/json'), 'CSRF header/body preserved on every action')
  console.log('PASS: filtering, registration, links/copy, promotion/demotion, deletion, cancellation/errors, CSRF, and dynamic rows.')
  await load('&empty=1')
  assert.deepEqual(await stats(), [0, 0, 0, 0])
  await search('')
  assert.deepEqual(await visible(), [])
  assert.deepEqual((await state()).errors, [])
  const violations = () => events.filter(e => e.method === 'Log.entryAdded' &&
    /content security policy|refused to load|refused to apply/i.test(e.params.entry.text))
  assert.deepEqual(violations(), [], 'No CSP violations for nonced external scripts')
  assert.equal(deliveredScripts, 2, 'One script load per valid page')
  await load('&negative=1')
  assert.equal((await state()).listeners.length, 0, 'Unnonced same-origin script is blocked')
  assert.equal(deliveredScripts, 2)
  assert.ok(violations().some(e => /user-management\.js/.test(e.params.entry.text)), 'Negative CSP control')
  assert.deepEqual(interceptionErrors, [], 'No admin mutation reached the live application')
  console.log('PASS: actual nonce/strict-dynamic CSP, defer/DCL timing, one-time initialization, empty table, and negative nonce control.')
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
