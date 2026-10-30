#!/usr/bin/env node
// Read-only checks using the Pug/PostCSS packages in the running web container.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const root = new URL('../', import.meta.url)
const read = name => readFileSync(new URL(name, root), 'utf8')
const payload = {
  before: read('overrides/cloverleaf-overrides-v1.css'),
  after: read('overrides/cloverleaf-overrides-v2.css'),
  current: read('overrides/cloverleaf-overrides-v3.css'),
  latest: read('overrides/cloverleaf-overrides-v4.css'),
  template: read('overrides/manage_users.pug'),
  managementScript: read('overrides/user-management.js'),
}
payload.managementScriptUrl = `/admin/user-management.js?v=${createHash('sha256')
  .update(payload.managementScript).digest('hex').slice(0, 12)}`
assert.ok(read('overrides/manage_users.pug').includes(`src='${payload.managementScriptUrl}'`))
assert.match(read('overrides/UserActivateRouter.mjs'),
  /'\/admin\/user-management\.js',\s+AuthorizationMiddleware\.ensureUserIsSiteAdmin,\s+UserActivateController\.serveJs/)
assert.match(read('overrides/_metadata.pug'), /stylesheets\/cloverleaf-overrides-v4\.css/)
for (const version of ['v1', 'v2', 'v3', 'v4']) {
  assert.ok(read('overrides/docker-compose.override.yml').includes(
    `cloverleaf-overrides-${version}.css:/overleaf/services/web/public/stylesheets/cloverleaf-overrides-${version}.css:ro`))
}

function checkInContainer() {
  const fs = require('node:fs')
  const assert = require('node:assert/strict')
  const vm = require('node:vm')
  const pug = require('/overleaf/node_modules/pug')
  const postcss = require('/overleaf/node_modules/postcss')
  const moment = require('/overleaf/node_modules/moment')
  const { before, after, current, latest, template, managementScript, managementScriptUrl } =
    JSON.parse(fs.readFileSync(0, 'utf8'))
  const parseRules = css => {
    const rules = []
    postcss.parse(css).walkRules(rule => rules.push(rule))
    return rules
  }
  const oldRules = parseRules(before)
  const newRules = parseRules(after)
  assert.equal(newRules.length, oldRules.length)
  let scopedSelectors = 0
  const pageOnly = /\.card-(?:header|footer)\b|#users-table\b|\.btn-outline-secondary\b|\.btn-admin-nav\b|\.user-avatar\b|\.role-badge\b|\.status-badge\b|\.badge(?:\.bg-secondary|\.bg-light|\.bg-info\.bg-opacity-10|\.text-info-emphasis)|\.badge-you\b|\.font-monospace a\b|\.card\.shadow-sm\b/
  for (let i = 0; i < oldRules.length; i++) {
    const oldRule = oldRules[i]
    const newRule = newRules[i]
    assert.equal(newRule.nodes.map(n => n.toString()).join('\n'),
      oldRule.nodes.map(n => n.toString()).join('\n'), `Declarations changed in rule ${i}`)
    assert.equal(newRule.selectors.length, oldRule.selectors.length)
    for (let j = 0; j < newRule.selectors.length; j++) {
      const selector = newRule.selectors[j]
      assert.equal(selector.replace(/\s*:where\(\.manage-users-page\)/g, ''),
        oldRule.selectors[j], `Unexpected selector change: ${selector}`)
      if (pageOnly.test(selector)) {
        assert.ok(selector.includes(':where(.manage-users-page)'), `Unscoped page rule: ${selector}`)
        scopedSelectors++
      } else {
        assert.equal(selector, oldRule.selectors[j], `Shared selector changed: ${selector}`)
      }
    }
  }
  assert.ok(scopedSelectors > 40)
  const currentRules = parseRules(current)
  const sessionRules = currentRules.filter(rule => rule.selector.includes('.clear-user-sessions'))
  assert.equal(sessionRules.length, 1, 'Expected one targeted session stripe fix')
  assert.equal(sessionRules[0].selector,
    "body:not([data-theme='light']) .clear-user-sessions .table-striped")
  assert.deepEqual(sessionRules[0].nodes.map(n => [n.prop, n.value, n.important]), [
    ['--bs-table-striped-bg', '#27313f', true],
    ['--bs-table-striped-color', '#e8ecef', true],
  ])
  assert.deepEqual(currentRules.filter(rule => !sessionRules.includes(rule)).map(r => r.toString()),
    newRules.map(r => r.toString()), 'Non-session rules must remain unchanged in v3')
  const latestRules = parseRules(latest)
  const titleRules = latestRules.filter(rule => rule.selector.includes('.project-list-title'))
  assert.equal(titleRules.length, 1, 'Expected one targeted project-title fix')
  assert.equal(titleRules[0].selector,
    "body:not([data-theme='light']) .project-list-header-row #main-content.project-list-title")
  assert.deepEqual(titleRules[0].nodes.map(n => [n.prop, n.value, n.important]), [
    ['background-color', 'transparent', true],
  ])
  assert.deepEqual(latestRules.filter(rule => !titleRules.includes(rule)).map(r => r.toString()),
    currentRules.map(r => r.toString()), 'Non-title rules must remain unchanged in v4')
  const titleSource = fs.readFileSync(
    '/overleaf/services/web/frontend/js/features/project-list/components/title/project-list-title.tsx', 'utf8')
  assert.match(titleSource, /<h1\s+id="main-content"\s+tabIndex=\{-1\}/)
  assert.match(titleSource, /classnames\('project-list-title', className\)/)
  const filename = '/overleaf/services/web/modules/user-activate/app/views/user/manage_users.pug'
  // Compile the complete template, including inherited layout dependencies.
  pug.compile(template, { filename })
  const content = source => source.replace(/^extends .*\n/m, '').split('block append foot-scripts')[0]
  const render = pug.compile(content(template), { filename, doctype: 'html' })
  const users = [
    { _id: 'current', email: 'admin@example.test', first_name: 'Ada', isAdmin: true, loginCount: 3 },
    { _id: 'active', email: 'active@example.test', first_name: 'Alan', loginCount: 1 },
    { _id: 'pending', email: 'pending@example.test', loginCount: 0 },
  ].map(u => ({ ...u, signUpDate: '2026-01-01', projectCount: 2 }))
  const locals = { users, currentUser: users[0], csrfToken: 'fixture-csrf', moment }
  const html = render(locals)
  assert.match(html, /<div(?=[^>]*id="main-content")(?=[^>]*class="[^"]*\bmanage-users-page\b)[^>]*>/)
  assert.equal((html.match(/<tr[^>]*data-user-id=/g) || []).length, 3)
  for (const [id, value] of [['total', 3], ['active', 2], ['pending', 1], ['admins', 1]]) {
    assert.match(html, new RegExp(`id="stat-${id}">${value}<`))
  }
  assert.ok(!render({ ...locals, users: [] }).includes('data-user-id='))
  const inlineCss = html.match(/<style>([\s\S]*?)<\/style>/)[1]
  for (const rule of parseRules(inlineCss)) {
    assert.ok(rule.selectors.every(s => s.includes(':where(.manage-users-page)')),
      `Unscoped inline rule: ${rule.selector}`)
  }
  const foot = template.split('block append foot-scripts\n')[1]
    .split('\n').map(line => line.startsWith('\t') ? line.slice(1) : line).join('\n')
  const scriptHtml = pug.render(foot, { scriptNonce: 'fixture-nonce' })
  assert.equal((scriptHtml.match(/<script\b/g) || []).length, 1)
  assert.ok(scriptHtml.includes(`src="${managementScriptUrl}"`))
  assert.match(scriptHtml, /nonce="fixture-nonce"/)
  assert.match(scriptHtml, /\sdefer(?:="defer")?(?:\s|>)/)
  assert.match(scriptHtml, /><\/script>$/, 'Management tag must contain no inline code')
  new vm.Script(managementScript)
  // Reconstruct the old scopes solely for before/after browser comparisons.
  const oldTemplate = template.replace('.content-alt.manage-users-page', '.content-alt')
    .replace(/^(\t*):where\(\.manage-users-page\) /gm, '$1')
    .replace(/:where\(\.manage-users-page\)/g, '')
  const oldHtml = pug.compile(content(oldTemplate), { filename, doctype: 'html' })(locals)
  const renderPage = (file, pageLocals) => pug.compile(content(fs.readFileSync(file, 'utf8')),
    { filename: file, doctype: 'html' })(pageLocals)
  const fixtures = {
    manageBefore: oldHtml,
    manageAfter: html,
    manageEmpty: render({ ...locals, users: [] }),
    managementScriptTag: scriptHtml,
    managementScriptUrl,
    admin: renderPage('/overleaf/services/web/app/views/admin/index.pug', {
      hasFeature: () => false, systemMessages: [], openSockets: {}, csrfToken: 'fixture-csrf',
    }),
    sessions: renderPage('/overleaf/services/web/app/views/user/sessions.pug', {
      currentSession: { ip_address: '127.0.0.1', session_created: '2026-01-01' },
      sessions: Array.from({ length: 4 }, (_, i) => ({
        ip_address: `127.0.0.${i + 2}`, session_created: `2026-01-0${i + 2}`,
      })),
      translate: key => key, csrfToken: 'fixture-csrf', moment,
    }),
  }
  const sharedOnly = postcss.parse(before)
  sharedOnly.walkRules(rule => {
    const shared = rule.selectors.filter(selector => !pageOnly.test(selector))
    if (shared.length) rule.selectors = shared
    else rule.remove()
  })
  fixtures.sharedCss = sharedOnly.toString()
  process.stdout.write(JSON.stringify({
    message: `PASS: ${newRules.length} rules retain declarations; ${scopedSelectors} page selectors are contained; v3/v4 changes remain isolated. Pug, inline CSS, empty/populated rows, statistics, and external script nonce/defer/hash/syntax pass.`,
    fixtures,
  }))
}

const result = spawnSync('docker', ['exec', '-i', 'sharelatex', 'node', '-e',
  `(${checkInContainer.toString()})()`], {
  input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
})
if (result.error) throw result.error
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout)
  process.exit(result.status || 1)
}
const checked = JSON.parse(result.stdout)
console.log(checked.message)
if (process.argv[2]) {
  writeFileSync(process.argv[2], JSON.stringify({
    ...checked.fixtures, cssBefore: payload.before, cssAfter: payload.after, cssCurrent: payload.current,
    cssLatest: payload.latest, assetName: 'cloverleaf-overrides-v4.css',
  }))
}
