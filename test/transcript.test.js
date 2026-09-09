/**
 * Handoff skill alignment: the document must let a fresh agent continue
 * the WHOLE job, not just the latest turns.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  buildLlmUserText,
  extractRows,
  selectTranscriptRows,
  writeHandoff,
} from '../index.js'

function userMsg(text, time = 1) {
  return { type: 'user/message', time, data: { content: [{ type: 'text', text }] } }
}

function asstMsg(text, time = 2, extra = []) {
  const content = extra.concat([{ type: 'text', text }])
  return {
    type: 'assistant/message',
    time,
    data: {
      message: {
        content,
        source: { provider: 'p', model: 'm' },
      },
    },
  }
}

function turnStart() {
  return { type: 'turn/start' }
}

function pair(userText, asstText, t0) {
  return [turnStart(), userMsg(userText, t0), asstMsg(asstText, t0 + 1)]
}

function longSession(n) {
  const events = []
  for (let i = 0; i < n; i++) {
    events.push(...pair(
      i === 0 ? 'GOAL_MARKER 修登录超时' : 'later-user-' + i,
      i === 0 ? 'PLAN_MARKER 先复现再改' : 'later-asst-' + i,
      i * 10,
    ))
  }
  return events
}

test('extractRows keeps every user message and only the last assistant text of each turn', () => {
  const events = [
    turnStart(),
    userMsg('目标 A'),
    asstMsg('思考中', 2, [{ type: 'reasoning', text: 'secret-cot' }]),
    asstMsg('最终答复'),
    turnStart(),
    userMsg('改用 B'),
    asstMsg('完成 B'),
  ]
  const rows = extractRows(events)
  assert.deepEqual(rows.map((r) => r.kind + ':' + r.text), [
    '用户:目标 A',
    '助手:最终答复',
    '用户:改用 B',
    '助手:完成 B',
  ])
  assert.equal(rows.some((r) => r.text.includes('secret-cot') || r.text.includes('思考中')), false)
})

test('extractRows redacts secrets in user text', () => {
  const rows = extractRows([userMsg('token sk-abcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwxyz')])
  assert.equal(rows.length, 1)
  assert.match(rows[0].text, /sk-\*\*\*/)
  assert.match(rows[0].text, /ghp_\*\*\*/)
  assert.equal(rows[0].text.includes('sk-abcdefghijklmnop'), false)
})

test('selectTranscriptRows keeps a short session intact', () => {
  const rows = [
    { kind: '用户', text: 'a' },
    { kind: '助手', text: 'b' },
    { kind: '用户', text: 'c' },
  ]
  assert.deepEqual(selectTranscriptRows(rows), rows)
  assert.notEqual(selectTranscriptRows(rows), rows) // copy, not alias
})

test('selectTranscriptRows on a long session keeps original goal, opening plan, and latest status', () => {
  const rows = []
  for (let i = 0; i < 30; i++) {
    rows.push({ kind: '用户', text: i === 0 ? 'GOAL_MARKER 修登录超时' : 'later-user-' + i })
    rows.push({ kind: '助手', text: i === 0 ? 'PLAN_MARKER 先复现再改' : 'later-asst-' + i })
  }
  const selected = selectTranscriptRows(rows, { maxRows: 24 })
  const content = selected.filter((r) => r.kind !== '省略')
  assert.ok(content.length <= 24)
  assert.equal(content[0].text, 'GOAL_MARKER 修登录超时')
  assert.equal(content[1].text, 'PLAN_MARKER 先复现再改')
  assert.equal(content[content.length - 1].text, 'later-asst-29')
  assert.ok(content.some((r) => r.text === 'later-user-29'))
  assert.equal(content.some((r) => r.text === 'later-asst-5'), false)
  assert.ok(selected.some((r) => r.kind === '省略' && /工件/.test(r.text)))
})

test('selectTranscriptRows prefers user redirects over middle assistant walls', () => {
  const rows = []
  for (let i = 0; i < 8; i++) {
    rows.push({ kind: '用户', text: 'user-' + i })
    rows.push({ kind: '助手', text: 'asst-' + i })
  }
  const selected = selectTranscriptRows(rows, { maxRows: 6 })
  const content = selected.filter((r) => r.kind !== '省略')
  assert.equal(content.length, 6)
  const users = content.filter((r) => r.kind === '用户').map((r) => r.text)
  assert.ok(users.includes('user-0'))
  assert.ok(users.includes('user-7'))
  assert.ok(users.length >= 4)
  assert.equal(content.filter((r) => r.kind === '助手' && r.text === 'asst-3').length, 0)
  assert.equal(selected.some((r) => r.kind === '省略' && /中间 1 条/.test(r.text)), false)
})

test('selectTranscriptRows inserts an omission marker for gaps only', () => {
  const rows = [
    { kind: '用户', text: 'u0' },
    { kind: '助手', text: 'a0' },
    { kind: '用户', text: 'u1' },
    { kind: '助手', text: 'a1' },
    { kind: '用户', text: 'u2' },
    { kind: '助手', text: 'a2' },
  ]
  const selected = selectTranscriptRows(rows, { maxRows: 4 })
  const kinds = selected.map((r) => r.kind)
  assert.equal(kinds[0], '用户')
  assert.ok(kinds.includes('省略'))
  assert.equal(selected[selected.length - 1].kind, '助手')
  assert.equal(selected.filter((r) => r.kind === '省略').every((r) => /中间 \d+ 条已省略/.test(r.text)), true)
})

test('buildLlmUserText lists artifacts, used skills, and optional next-session focus', () => {
  const text = buildLlmUserText({
    title: '登录超时',
    cwd: '/proj',
    transcript: '### 用户\nGOAL',
    refs: ['docs/plan.md', 'src/auth.ts'],
    skills: ['tdd', 'diagnosing-bugs'],
    focus: '把重试策略落地',
  })
  assert.match(text, /Session title: 登录超时/)
  assert.match(text, /Next session focus[\s\S]*把重试策略落地/)
  assert.match(text, /docs\/plan\.md/)
  assert.match(text, /src\/auth\.ts/)
  assert.match(text, /tdd/)
  assert.match(text, /do not quote or restate/)
  assert.match(text, /Do not invent omitted work/)
  assert.match(text, /### 用户\nGOAL/)
})

test('buildLlmUserText omits the focus line when none is provided', () => {
  const text = buildLlmUserText({
    title: 't',
    cwd: '/p',
    transcript: 'x',
    refs: [],
    skills: [],
    focus: '',
  })
  assert.equal(text.includes('Next session focus'), false)
  assert.match(text, /\(none extracted\)/)
  assert.match(text, /\(none\)/)
})

function mockWriteCtx({ cwd, title = '登录超时', events }) {
  const calls = { writeText: [] }
  const fs = {
    async resolve(rel, opts) {
      const displayPath = resolve(opts.cwd, rel)
      return { displayPath, targetKey: displayPath }
    },
    async writeText(target, content, expected, signal, policy) {
      calls.writeText.push({ target, content, expected, signal, policy })
      const err = new Error('cannot write: file access denied under workspace-write mode')
      err.code = 'FS_SANDBOX_DENIED'
      throw err
    },
  }
  const sessionQuery = {
    async readTitle() { return { title } },
    async readSession() { return { session: { cwd }, events } },
  }
  return {
    calls,
    ctx: {
      get(name) {
        if (name === 'sessionQuery') return sessionQuery
        if (name === 'fs') return fs
        if (name === 'llm') return null
        if (name === 'agentDefaultModel') return null
        return undefined
      },
    },
  }
}

function silenceConsoleError() {
  const orig = console.error
  console.error = () => {}
  return { restore() { console.error = orig } }
}

test('writeHandoff fallback keeps the first-turn goal instead of only the tail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-handoff-transcript-'))
  const silent = silenceConsoleError()
  try {
    const events = longSession(30)
    events.push({
      type: 'tool/call',
      data: { name: 'skill', arguments: JSON.stringify({ name: 'tdd' }) },
    })
    events.push({
      type: 'tool/call',
      data: { name: 'read', arguments: JSON.stringify({ path: 'docs/plan.md' }) },
    })
    const { ctx } = mockWriteCtx({ cwd: dir, events })
    const result = await writeHandoff(ctx, { sessionId: 'sess-long', focus: '把重试策略落地' })
    assert.equal(result.ok, true, result.error)
    const text = await readFile(join(dir, result.rel), 'utf8')
    assert.match(text, /GOAL_MARKER 修登录超时/)
    assert.match(text, /PLAN_MARKER 先复现再改/)
    assert.match(text, /later-user-29/)
    assert.match(text, /下一会话关注点：把重试策略落地/)
    assert.match(text, /接手方请优先推进：把重试策略落地/)
    assert.match(text, /tdd/)
    assert.match(text, /docs\/plan\.md/)
    assert.equal(text.includes('later-asst-5'), false)
  } finally {
    silent.restore()
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeHandoff redacts secrets in the focus argument', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-handoff-focus-'))
  const silent = silenceConsoleError()
  try {
    const { ctx } = mockWriteCtx({
      cwd: dir,
      events: [userMsg('继续'), asstMsg('好')],
    })
    const result = await writeHandoff(ctx, {
      sessionId: 'sess-focus',
      focus: '用 sk-abcdefghijklmnop 调接口',
    })
    assert.equal(result.ok, true, result.error)
    const text = await readFile(join(dir, result.rel), 'utf8')
    assert.match(text, /sk-\*\*\*/)
    assert.equal(text.includes('sk-abcdefghijklmnop'), false)
  } finally {
    silent.restore()
    await rm(dir, { recursive: true, force: true })
  }
})
