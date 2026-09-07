/**
 * Regression: clicking Handoff must write into the SESSION workspace even when
 * the host fallback workspaceRoot is a different directory.
 *
 * Repro from production:
 *   cannot write "C:\Users\scw\project\exp\workflow-flow\handoff\handoff-20260907171810-视频节点Agent化与剧本学习.md":
 *   file access denied under workspace-write mode
 *
 * Cause: `sandboxPolicy.resolve()` with no session stamps the HOST fallback
 * root. fs-sandbox then denies `<session-cwd>/handoff/...`. Approval-never
 * sessions cannot escalate, so the policy passed to writeText must already
 * allow the write.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { handoffWritePolicy, writeHandoff } from '../index.js'

const HOST_ROOT = resolve('C:/Users/scw/project/exp/dsh-handoff-button')
const SESSION_CWD = resolve('C:/Users/scw/project/exp/workflow-flow')
const REPRO_REL = 'handoff/handoff-20260907171810-视频节点Agent化与剧本学习.md'
const REPRO_TARGET = join(SESSION_CWD, ...REPRO_REL.split('/'))

function isLexicallyUnder(path, root) {
  const target = resolve(path)
  const base = resolve(root)
  const comparableTarget = process.platform === 'win32' ? target.toLowerCase() : target
  const comparableRoot = process.platform === 'win32' ? base.toLowerCase() : base
  if (comparableTarget === comparableRoot) return true
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep
  return comparableTarget.startsWith(prefix)
}

function sandboxDeny(displayPath, mode = 'workspace-write') {
  const err = new Error(`cannot write "${displayPath}": file access denied under ${mode} mode`)
  err.code = 'FS_SANDBOX_DENIED'
  return err
}

/** Mirror of fs-sandbox checkedTarget: workspace-write requires containment. */
function wouldDeny(policy, displayPath) {
  if (!policy) return true
  if (policy.mode === 'danger-full-access') return false
  if (policy.mode === 'read-only') return true
  if (policy.mode !== 'workspace-write') return true
  return !isLexicallyUnder(displayPath, policy.workspaceRoot)
}

function mockCtx({ cwd = SESSION_CWD, title = '视频节点Agent化与剧本学习', writeText, resolvePolicy } = {}) {
  const calls = { writeText: [] }
  const fs = {
    async resolve(rel, opts) {
      const displayPath = resolve(opts.cwd, rel)
      return { displayPath, targetKey: displayPath }
    },
    async writeText(target, content, expected, signal, policy) {
      calls.writeText.push({ target, content, expected, signal, policy })
      if (writeText) return writeText(target, content, expected, signal, policy)
      if (wouldDeny(policy, target.displayPath)) throw sandboxDeny(target.displayPath, policy && policy.mode)
      return { operation: 'create', version: 'v1', before: null, after: content }
    },
  }
  const sessionQuery = {
    async readTitle() { return { title } },
    async readSession() {
      return { session: { cwd }, events: [] }
    },
  }
  const sandboxPolicy = {
    resolve(request = {}) {
      if (resolvePolicy) return resolvePolicy(request)
      return {
        mode: 'workspace-write',
        workspaceRoot: request.session && request.session.header && request.session.header.cwd
          ? request.session.header.cwd
          : HOST_ROOT,
      }
    },
  }
  return {
    calls,
    fs,
    sandboxPolicy,
    ctx: {
      get(name) {
        if (name === 'sessionQuery') return sessionQuery
        if (name === 'fs') return fs
        if (name === 'sandboxPolicy') return sandboxPolicy
        if (name === 'llm') return null
        if (name === 'agentDefaultModel') return null
        if (name === 'sessions') return { get() { return undefined } }
        return undefined
      },
    },
  }
}

test('host fallback workspaceRoot does not contain the session handoff path (the production denial)', () => {
  const standing = { mode: 'workspace-write', workspaceRoot: HOST_ROOT }
  assert.equal(wouldDeny(standing, REPRO_TARGET), true, 'old resolve()-without-session policy must deny the repro path')
})

test('handoffWritePolicy pins workspace-write to the session cwd so the repro path is allowed', () => {
  const policy = handoffWritePolicy(SESSION_CWD)
  assert.equal(policy.mode, 'workspace-write')
  assert.equal(policy.workspaceRoot, SESSION_CWD)
  assert.equal(wouldDeny(policy, REPRO_TARGET), false)
})

test('handoffWritePolicy upgrades read-only: the user clicked the button', () => {
  const policy = handoffWritePolicy(SESSION_CWD, { mode: 'read-only', workspaceRoot: SESSION_CWD })
  assert.equal(policy.mode, 'workspace-write')
  assert.equal(wouldDeny(policy, REPRO_TARGET), false)
})

test('handoffWritePolicy keeps danger-full-access', () => {
  const policy = handoffWritePolicy(SESSION_CWD, { mode: 'danger-full-access', workspaceRoot: HOST_ROOT })
  assert.equal(policy.mode, 'danger-full-access')
  assert.equal(wouldDeny(policy, REPRO_TARGET), false)
})

test('handoffWritePolicy strips a trailing separator so prefix checks match', () => {
  const policy = handoffWritePolicy(SESSION_CWD + sep)
  assert.equal(policy.workspaceRoot, SESSION_CWD)
  assert.equal(wouldDeny(policy, REPRO_TARGET), false)
})

test('writeHandoff stamps the session cwd, not the host fallback, onto writeText', async () => {
  const silent = silenceConsoleError()
  const { ctx, calls } = mockCtx()
  let result
  try {
    result = await writeHandoff(ctx, { sessionId: 'sess-repro' })
  } finally {
    silent.restore()
  }
  assert.equal(result.ok, true, result.error)
  assert.equal(calls.writeText.length, 1)
  const { target, policy } = calls.writeText[0]
  assert.equal(wouldDeny(policy, target.displayPath), false)
  assert.ok(isLexicallyUnder(target.displayPath, SESSION_CWD))
  assert.equal(resolve(policy.workspaceRoot), SESSION_CWD)
  assert.equal(policy.mode, 'workspace-write')
  assert.match(result.rel, /^handoff\/handoff-\d{14}-.+?\.md$/)
  assert.match(result.rel, /视频节点Agent化与剧本学习/)
  assert.equal(resolve(result.path), resolve(SESSION_CWD, result.rel))
})

function silenceConsoleError() {
  const orig = console.error
  console.error = () => {}
  return { restore() { console.error = orig } }
}

test('writeHandoff still writes when ctx.fs throws the production sandbox denial (approval-never cannot escalate)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-handoff-'))
  const silent = silenceConsoleError()
  try {
    const { ctx, calls } = mockCtx({
      cwd: dir,
      writeText(target) {
        throw sandboxDeny(target.displayPath)
      },
    })
    const result = await writeHandoff(ctx, { sessionId: 'sess-fallback' })
    assert.equal(result.ok, true, result.error)
    assert.equal(calls.writeText.length, 1)
    const dest = join(dir, result.rel)
    const text = await readFile(dest, 'utf8')
    assert.match(text, /^# Handoff：/)
    assert.match(text, /sess-fallback/)
  } finally {
    silent.restore()
    await rm(dir, { recursive: true, force: true })
  }
})

