/**
 * dsh-handoff-button — Host half (static bundle).
 *
 * Registers an exact HTTP route `POST /handoff/write` on the DSH web server.
 * The browser client bundle fetches this route when the user clicks the
 * handoff button. The handler:
 *   1. reads the session title and log (sessionQuery),
 *   2. builds a compact handoff document with the LLM (summarizes, per the
 *      original handoff skill: no raw transcript, reference by path, redact
 *      secrets, suggest skills), falling back to a heuristic digest when the
 *      model call is unavailable,
 *   3. writes it to `<workspace>/handoff/handoff-{yyyymmddhhmmss}-{title}.md`
 *      (parent dir auto-created by the fs backend).
 *
 * The write is a trusted UI action (the user clicked the button), not a
 * model tool call. The per-call fs policy is therefore pinned to the
 * SESSION cwd as `workspace-write`. Calling `sandboxPolicy.resolve()` with
 * no session stamps the HOST fallback workspaceRoot — typically a different
 * directory — and workspace-write then denies `<cwd>/handoff/...` with
 * `file access denied under workspace-write mode`. Approval-never sessions
 * cannot escalate, so the stamped policy must already allow the write; if
 * the sandboxed backend still refuses, we fall back to a direct host write
 * of the same path.
 *
 * References are rebased to the workspace root before writing, so the
 * handoff document lists files as paths relative to `cwd` — readable on any
 * machine, not just the one that generated it. Only workspace-internal
 * paths are kept: system dirs, /tmp, the harness home, and other projects
 * are dropped as machine-specific noise.
 *
 * Conversation extraction follows the handoff skill: summarize the CURRENT
 * conversation so a FRESH agent can continue THIS work — not merely the
 * latest turns. User messages keep their full text (original goal, later
 * redirects). Assistant messages are grouped per turn (turn/start
 * boundaries) and only the LAST assistant message of each turn contributes
 * its text blocks — with reasoning-model traces, earlier steps contain
 * thinking, so taking the final message avoids leaking chain-of-thought.
 * When the session is long, the LLM transcript keeps the opening goal/plan
 * and the latest status, preferring user messages; omitted middle assistant
 * turns are assumed to live in referenced artifacts (specs/plans/ADRs).
 * Optional `focus` (skill arguments) is treated as the next session's
 * concentration, not as a replacement for the original goal.
 *
 * Unlike the agent-invoked skill, this plugin writes into the session
 * workspace (`handoff/`) rather than the OS temp directory: the user clicked
 * a button and needs a durable file that `openWorkspacePath` can open.
 *
 * Deliberately dependency-free: only Node built-ins (node:fs, node:url) are
 * imported, so the bundle profile needs nothing beyond this package — safe
 * for cross-device installs.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const name = 'dsh-handoff-button'

export const inject = ['webServer']

/** Absolute path of this package directory (location of the icon asset). */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

export function apply(ctx) {
  // Serves the button icon (assets/write.png) as a same-origin HTTP resource,
  // so the client bundle can render it via CSS mask without any base64 blob.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/handoff/icon',
    handler: async (req, res) => {
      try {
        const bytes = await readFile(join(PACKAGE_DIR, 'assets', 'write.png'))
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=86400',
        })
        res.end(bytes)
      } catch (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('icon not found')
      }
    },
  }))
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/handoff/write',
    handler: async (req, res) => {
      let result
      try {
        const raw = await readBody(req)
        const args = JSON.parse(raw || '{}')
        result = await writeHandoff(ctx, args)
      } catch (err) {
        console.error('[dsh-handoff-button] request failed:', err)
        result = { ok: false, error: String((err && err.message) || err) }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
    },
  }))
  // Read-only route: serves a generated handoff file. Kept as a fallback
  // inspector; the client opens files through session.openWorkspacePath.
  // `path` must be a bare handoff/xxx.md relative path; `sessionId` selects
  // the workspace (cwd).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/handoff/read',
    handler: async (req, res) => {
      let status = 500
      let body = ''
      let contentType = 'application/json; charset=utf-8'
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId') || ''
        const rel = url.searchParams.get('path') || ''
        if (!/^handoff\/[^/]+\.md$/.test(rel)) {
          status = 400
          body = JSON.stringify({ ok: false, error: '非法路径' })
        } else {
          const cwd = await resolveWorkspaceCwd(ctx, sessionId)
          if (!cwd) throw new Error('无法确定工作区根目录')
          const fs = ctx.get('fs')
          if (!fs) throw new Error('fs 服务不可用')
          const target = await fs.resolve(rel, { cwd })
          const text = await fs.readText(target)
          status = 200
          contentType = 'text/markdown; charset=utf-8'
          body = text
        }
      } catch (err) {
        status = 500
        body = JSON.stringify({ ok: false, error: String((err && err.message) || err) })
      }
      res.writeHead(status, { 'content-type': contentType })
      res.end(body)
    },
  }))
}

/** Resolve the workspace root (cwd) for a session, mirroring writeHandoff. */
async function resolveWorkspaceCwd(ctx, sessionId) {
  const sessionQuery = ctx.get('sessionQuery')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  let cwd = ''
  let events = []
  if (sessionQuery) {
    try {
      const log = await sessionQuery.readSession(sessionId)
      const header = log && log.session
      if (header && typeof header.cwd === 'string' && header.cwd) cwd = header.cwd
      if (log && Array.isArray(log.events)) events = log.events
    } catch (err) { console.error('[dsh-handoff-button] readSession failed:', err) }
  }
  if (!cwd) {
    for (const ev of events) {
      if (!ev || ev.type !== 'request/header' || !ev.data) continue
      const d = ev.data
      const candidate = typeof d.cwd === 'string' && d.cwd
        ? d.cwd
        : (d.header && typeof d.header.cwd === 'string' && d.header.cwd ? d.header.cwd : '')
      if (candidate) { cwd = candidate; break }
    }
  }
  if (!cwd && sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string') cwd = sandboxPolicy.workspaceRoot
  return cwd
}

/** Read the session event list (best-effort). */
async function readSessionEvents(ctx, sessionId) {
  const sessionQuery = ctx.get('sessionQuery')
  if (!sessionQuery) return []
  try {
    const log = await sessionQuery.readSession(sessionId)
    return log && Array.isArray(log.events) ? log.events : []
  } catch (err) {
    console.error('[dsh-handoff-button] readSession failed:', err)
    return []
  }
}

export async function writeHandoff(ctx, args) {
  const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : null
  if (!sessionId) return { ok: false, error: '缺少 sessionId' }

  const sessionQuery = ctx.get('sessionQuery')
  const fs = ctx.get('fs')
  if (!sessionQuery) return { ok: false, error: 'sessionQuery 服务不可用' }
  if (!fs) return { ok: false, error: 'fs 服务不可用' }

  // 1. Session title.
  let title = ''
  try {
    const snap = await sessionQuery.readTitle(sessionId)
    if (snap && typeof snap.title === 'string') title = snap.title.trim()
  } catch (err) { console.error('[dsh-handoff-button] readTitle failed:', err) }
  if (!title) title = 'untitled'

  // 2. Session log + workspace root (cwd).
  const cwd = await resolveWorkspaceCwd(ctx, sessionId)
  if (!cwd) return { ok: false, error: '无法确定工作区根目录' }
  const events = await readSessionEvents(ctx, sessionId)

  // 3. Extract per-turn rows (user messages + final assistant reply per turn)
  //    and tool-derived references. Optional `focus` is the skill argument:
  //    what the next session should concentrate on.
  const rows = extractRows(events)
  const { refs, skills } = extractReferences(events)
  const relRefs = relativizeRefs(cwd, refs)
  const focus = readFocus(args)

  // 4. Summarize the whole job (original goal + current state), not just the
  //    last few turns. LLM first; heuristic digest as fallback.
  const selected = selectTranscriptRows(rows)
  const transcript = buildTranscript(selected)
  let body
  let mode = 'fallback'
  let llmNote = ''
  try {
    body = await summarizeWithLlm(ctx, sessionId, { title, cwd, transcript, refs: relRefs, skills, focus })
    mode = 'llm'
  } catch (err) {
    llmNote = String((err && err.message) || err)
    console.error('[dsh-handoff-button] LLM summary failed, using heuristic digest:', err)
    body = heuristicSummary(title, rows, skills, focus)
  }

  // 5. Compose the document.
  const now = new Date()
  const stamp = fmtStamp(now)
  const safeTitle = sanitize(title)
  const filename = 'handoff-' + stamp + '-' + safeTitle + '.md'
  const rel = 'handoff/' + filename
  const content = composeDocument({ title, sessionId, cwd, rel, body, refs: relRefs, mode, llmNote, focus })

  // 6. Write into the session workspace. Pin the sandbox root to THAT cwd —
  //    never the host fallback from resolve()-without-session.
  const target = await fs.resolve(rel, { cwd })
  const policy = handoffWritePolicy(cwd)
  try {
    await fs.writeText(target, content, undefined, undefined, policy)
  } catch (err) {
    if (!isSandboxDenied(err)) throw err
    // Trusted UI write. Approval-never cannot escalate; write the same path
    // through the host process so the click still produces a file.
    console.error('[dsh-handoff-button] sandboxed write denied, falling back to host fs:', err)
    const dest = join(cwd, rel)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, content, 'utf8')
  }

  return { ok: true, filename, rel, path: join(cwd, rel), mode, llmNote }
}

/**
 * Per-call fs policy for a user-clicked handoff write.
 *
 * `sandboxPolicy.resolve()` without a session stamps the HOST fallback
 * workspaceRoot. That root is typically a different directory than this
 * conversation's cwd, so a workspace-write fence denies the handoff file
 * with `file access denied under workspace-write mode`.
 *
 * @param cwd - the session workspace root the document is written under.
 * @param standing - optional already-resolved standing policy (mode only).
 * @returns a policy whose workspaceRoot is `cwd`.
 */
export function handoffWritePolicy(cwd, standing) {
  const workspaceRoot = resolve(cwd)
  if (standing && standing.mode === 'danger-full-access') {
    return { mode: 'danger-full-access', workspaceRoot }
  }
  return { mode: 'workspace-write', workspaceRoot }
}

function isSandboxDenied(err) {
  if (!err) return false
  if (err.code === 'FS_SANDBOX_DENIED') return true
  return /file access denied under/i.test(String(err.message || err))
}

/* ------------------------------------------------------------------ *
 * Row extraction: per turn, keep user messages and the LAST assistant  *
 * message's text blocks (reasoning/tool-call blocks are skipped).     *
 * ------------------------------------------------------------------ */

export function extractRows(events) {
  const rows = []
  let pending = null // last assistant message of the current turn
  const flush = () => {
    if (pending) {
      rows.push(pending)
      pending = null
    }
  }
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'turn/start') {
      flush()
    } else if (ev.type === 'user/message') {
      flush()
      const text = redact(extractText(ev.data))
      if (text) rows.push({ kind: '用户', text, time: fmtTime(ev.time) })
    } else if (ev.type === 'assistant/message') {
      const m = ev.data && ev.data.message
      const text = redact(extractText(m))
      if (!text) continue
      const src = m && m.source
      const model = src && typeof src.provider === 'string' ? src.provider + '/' + (typeof src.model === 'string' ? src.model : '') : ''
      pending = { kind: '助手', text, time: fmtTime(ev.time), model } // later steps overwrite
    }
  }
  flush()
  return rows
}

/**
 * Pick rows so a fresh agent can continue the WHOLE job, not just the tail.
 *
 * User messages carry the original goal and later redirects — keep them
 * preferentially. Assistant messages keep the opening plan and the latest
 * status; middle assistant turns are assumed to live in referenced artifacts.
 * Gaps become an explicit omission marker so the summarizer does not invent
 * the skipped work.
 *
 * @param rows - extractRows() output, chronological.
 * @param options.maxRows - max content rows (omission markers extra). Default 24.
 */
export function selectTranscriptRows(rows, options) {
  const maxRows = options && Number.isFinite(options.maxRows) && options.maxRows > 0
    ? Math.floor(options.maxRows)
    : 24
  if (!Array.isArray(rows) || rows.length === 0) return []
  if (rows.length <= maxRows) return rows.slice()

  const userIdx = []
  const otherIdx = []
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].kind === '用户') userIdx.push(i)
    else otherIdx.push(i)
  }

  const chosen = new Set()
  // Original goal.
  if (userIdx.length) chosen.add(userIdx[0])
  else chosen.add(0)
  // Current state.
  chosen.add(rows.length - 1)
  // Opening plan (first assistant / non-user), if distinct.
  if (otherIdx.length) chosen.add(otherIdx[0])

  // Remaining user messages from the tail (latest redirects first).
  for (let k = userIdx.length - 1; k >= 0; k--) {
    if (chosen.size >= maxRows) break
    chosen.add(userIdx[k])
  }
  // Remaining other messages from the tail (latest status first).
  for (let k = otherIdx.length - 1; k >= 0; k--) {
    if (chosen.size >= maxRows) break
    chosen.add(otherIdx[k])
  }

  const ordered = [...chosen].sort((a, b) => a - b)
  return stitchWithOmissions(rows, ordered)
}

function stitchWithOmissions(rows, indices) {
  const out = []
  let prev = -1
  for (const i of indices) {
    // A one-row hole is usually the assistant reply between two kept user
    // messages — not worth a marker. Larger holes are the omitted middle.
    if (prev >= 0 && i - prev > 2) {
      out.push({
        kind: '省略',
        text: '（中间 ' + (i - prev - 1) + ' 条已省略。中段进展以 References 中的工件为准，不要臆造。）',
      })
    }
    out.push(rows[i])
    prev = i
  }
  return out
}

/* ------------------------------------------------------------------ *
 * LLM summarization (dependency-free: hand-rolled message + chunks).  *
 * ------------------------------------------------------------------ */

export function buildLlmUserText({ title, cwd, transcript, refs, skills, focus }) {
  const lines = []
  lines.push('Session title: ' + title)
  lines.push('Workspace: ' + cwd)
  if (focus) {
    lines.push('Next session focus (treat as what the continuation should concentrate on): ' + focus)
  }
  lines.push('')
  lines.push('Artifacts already on disk (reference by relative path or URL; do not quote or restate them):')
  if (refs && refs.length) {
    for (const r of refs) lines.push('- ' + r)
  } else {
    lines.push('- (none extracted)')
  }
  lines.push('')
  lines.push('Skills already used in this session (hint for Suggested Skills; suggest what the NEXT agent should load):')
  if (skills && skills.length) {
    for (const s of skills) lines.push('- ' + s)
  } else {
    lines.push('- (none)')
  }
  lines.push('')
  lines.push('Conversation transcript (text only). Opening goal/plan and latest turns are included; middle assistant turns may be omitted when they should already live in the artifacts above. Do not invent omitted work.')
  lines.push(transcript)
  return lines.join('\n')
}

async function summarizeWithLlm(ctx, sessionId, { title, cwd, transcript, refs, skills, focus }) {
  const llm = ctx.get('llm')
  const modelService = ctx.get('agentDefaultModel')
  if (!llm || !modelService) throw new Error('llm 服务不可用')
  const selection = modelService.currentSelection()
  if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    throw new Error('无可用默认模型')
  }

  const system = [
    'You are writing a handoff document so a fresh AI agent with no prior context can continue the current work.',
    'Write a markdown document containing exactly these sections:',
    '## Status',
    '## Goal',
    '## Progress',
    '## Next Steps',
    '## Suggested Skills',
    'Rules:',
    '- Status: one short line (in progress / blocked / done, with a reason).',
    '- Goal: the original objective and any explicit later restatements or constraints. Take this from the start of the conversation; do not replace it with a merely recent sub-task unless the user clearly changed the goal.',
    '- Progress: a COMPACT summary of what was done, decided, and the current state. Never paste raw conversation text — summarize it.',
    '- Next Steps: concrete ordered actions for the continuation agent.',
    '- Suggested Skills: 2-5 skills the next agent should load with the skill tool, or "none" if not needed. Include already-used skills when they are still relevant.',
    '- Do not duplicate content already captured in files or other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by relative path or URL instead of quoting.',
    '- The transcript may omit middle assistant turns. Treat omitted turns as recorded in the listed artifacts. Do not invent work that is not in the transcript or artifact list.',
    '- If a Next session focus is provided, treat it as what the next session should concentrate on: keep the overall Goal accurate, and bias Next Steps toward that focus.',
    '- Redact any sensitive information: API keys, passwords, tokens, personally identifiable information.',
    '- Use the language of the conversation.',
    '- Keep the whole document under 500 words.',
  ].join('\n')

  const userText = buildLlmUserText({ title, cwd, transcript, refs, skills, focus })
  const options = {
    provider: selection.provider,
    model: selection.model,
    messages: [{
      id: 'handoff-llm-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      role: 'user',
      content: [{ type: 'text', text: userText }],
      source: { kind: 'plugin', plugin: 'dsh-handoff-button' },
    }],
    system,
    maxTokens: 4096,
    sessionId,
    purpose: 'handoff',
  }

  let text = ''
  let finishKind = null
  let finishFailure = null
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && chunk.reason) {
      finishKind = chunk.reason.kind
      finishFailure = chunk.reason.failure || null
    }
  }
  if (finishKind === 'error' || finishKind === 'aborted') {
    const detail = finishFailure && (finishFailure.message || finishFailure.code)
    throw new Error('LLM 调用失败: ' + finishKind + (detail ? ' — ' + detail : ''))
  }
  const trimmed = text.trim()
  if (!trimmed) throw new Error('LLM 未产生文本')
  // Strip accidental code fences around the body.
  return trimmed.replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```$/, '')
}

/* ------------------------------------------------------------------ *
 * Heuristic fallback digest (no model available).                     *
 * ------------------------------------------------------------------ */

function heuristicSummary(title, rows, skills, focus) {
  const firstUser = rows.find((row) => row && row.kind === '用户')
  const selected = selectTranscriptRows(rows, { maxRows: 12 })
  const lines = []
  lines.push('## Status')
  lines.push('')
  lines.push('- 进行中（模型总结不可用，以下为启发式摘要）')
  lines.push('')
  lines.push('## Goal')
  lines.push('')
  lines.push('- ' + title)
  if (firstUser) lines.push('- ' + clamp(firstUser.text, 400))
  if (focus) lines.push('- 下一会话关注点：' + focus)
  lines.push('')
  lines.push('## Progress')
  lines.push('')
  for (const row of selected) {
    lines.push('### ' + row.kind + (row.model ? '（' + row.model + '）' : '') + (row.time ? ' · ' + row.time : ''))
    lines.push('')
    lines.push(clamp(row.text, 240))
    lines.push('')
  }
  lines.push('## Next Steps')
  lines.push('')
  if (focus) {
    lines.push('- 接手方请优先推进：' + focus)
    lines.push('- 需要完整上下文时请查阅原会话与 References 中的工件。')
  } else {
    lines.push('- 接手方请基于 Goal 与上方进展继续推进；需要完整上下文时请查阅原会话与 References 中的工件。')
  }
  lines.push('')
  lines.push('## Suggested Skills')
  lines.push('')
  if (skills && skills.length > 0) {
    for (const s of skills) lines.push('- ' + s)
  } else {
    lines.push('- 未指定')
  }
  return lines.join('\n')
}

function buildTranscript(rows) {
  const parts = []
  for (const row of rows) {
    parts.push('### ' + row.kind + (row.model ? '（' + row.model + '）' : '') + (row.time ? ' · ' + row.time : ''))
    const max = row.kind === '用户' ? 2000 : row.kind === '省略' ? 200 : 800
    parts.push(clamp(row.text, max))
  }
  return parts.join('\n\n')
}

/* ------------------------------------------------------------------ *
 * References: paths touched by tools + skills actually used.          *
 * ------------------------------------------------------------------ */

/** System / transient prefixes that are never project references. */
const NON_PROJECT_PREFIXES = [
  '/usr', '/opt', '/Applications', '/System', '/bin', '/sbin',
  '/Library', '/private', '/etc', '/var', '/dev', '/tmp',
]

/** Probe / temp file names that are never references (e.g. .write-test). */
const NOISE_PATH_RE = /(^|[\\/])(\.write-test|\.probe-test|_tmp_|\.tmp)([\\/]|$)/

/** PATH-style entries that are never references. */
const NOISE_PATH_SEGMENTS = ['node_modules/.bin', '/bin/', '/sbin/']

function isNoisePath(v) {
  if (typeof v !== 'string' || !v) return true
  for (const prefix of NON_PROJECT_PREFIXES) {
    if (v === prefix || v.startsWith(prefix + '/')) return true
  }
  if (NOISE_PATH_RE.test(v)) return true
  for (const segment of NOISE_PATH_SEGMENTS) {
    if (v.includes(segment)) return true
  }
  return false
}

function extractReferences(events) {
  const refs = new Set()
  const skills = new Set()
  const pathKeys = ['path', 'file_path', 'target']
  for (const ev of events) {
    if (!ev || ev.type !== 'tool/call' || !ev.data) continue
    const name = ev.data.name
    let args = {}
    try { args = JSON.parse(typeof ev.data.arguments === 'string' ? ev.data.arguments : '{}') } catch { /* ignore */ }
    if (name === 'skill') {
      if (typeof args.name === 'string' && args.name) skills.add(args.name)
      continue
    }
    for (const k of pathKeys) {
      const v = args[k]
      if (typeof v === 'string' && v && looksLikePath(v) && !isNoisePath(v)) refs.add(v)
    }
    if (typeof args.workdir === 'string' && args.workdir && !isNoisePath(args.workdir)) refs.add(args.workdir)
    if (name === 'bash' && typeof args.command === 'string') {
      for (const m of args.command.matchAll(/(?:^|\s)((?:\/[\w.\-]+){2,}|\.\.?\/[\w.\-/]+|\/[\w.\-/]+\.[\w]+)/g)) {
        const p = m[1].trim()
        if (looksLikePath(p) && !isNoisePath(p)) refs.add(p)
      }
    }
  }
  return { refs: [...refs].slice(0, 30), skills: [...skills].slice(0, 15) }
}

function looksLikePath(v) {
  if (!v.includes('/')) return false
  if (/^https?:\/\//i.test(v)) return false
  if (/^www\./i.test(v)) return false
  if (/^[a-z0-9-]+(\.[a-z]{2,})+\//i.test(v)) return false
  return true
}

/**
 * Rebase references onto the workspace root so the handoff document stays
 * meaningful across machines. Only paths INSIDE the workspace are kept —
 * they become relative to `cwd`, the same root the next agent will open.
 * Everything outside the workspace (system dirs, /tmp, the harness home,
 * other projects) is dropped: it has no shared anchor and is pure noise
 * for a handoff reader. Deduplicates after rebasing — the same file may be
 * touched both as an absolute path and as a `./`-relative one.
 * @param cwd - the workspace root the document is written under.
 * @param refs - raw references extracted from tool calls.
 * @returns workspace-internal references as cwd-relative paths.
 */
function relativizeRefs(cwd, refs) {
  if (!refs || refs.length === 0) return refs
  const root = (cwd || '').replace(/[\\/]+$/, '')
  const seen = new Set()
  const out = []
  for (const ref of refs) {
    if (isNoisePath(ref)) continue
    let display
    if (root && isAbsolute(ref)) {
      const rel = relative(root, ref)
      // Keep only paths inside the workspace: rel is plain, does not escape with ..
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
      display = rel.split(sep).join('/')
    } else if (ref.startsWith('..')) {
      continue // relative path escaping the workspace — no shared anchor
    } else {
      display = ref
    }
    if (display === '.' || display === '') continue
    if (seen.has(display)) continue
    seen.add(display)
    out.push(display)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Document composition.                                               *
 * ------------------------------------------------------------------ */

function composeDocument({ title, sessionId, cwd, rel, body, refs, mode, llmNote, focus }) {
  const lines = []
  lines.push('# Handoff：' + title)
  lines.push('')
  lines.push('> 由 DSH Handoff 插件自动生成' + (mode === 'llm' ? '（模型总结）' : '（降级摘要）'))
  lines.push('> 生成时间：' + new Date().toISOString())
  lines.push('> 会话：' + sessionId)
  if (focus) lines.push('> 下一会话关注点：' + focus)
  lines.push('')
  lines.push(body)
  lines.push('')
  lines.push('## References（参考资料）')
  lines.push('')
  lines.push('- 工作区根目录：' + cwd + '（以下相对路径均相对于该目录）')
  lines.push('- 本文件：' + rel)
  for (const r of refs) lines.push('- ' + r)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('*敏感信息已按规则脱敏。*')
  if (llmNote) lines.push('<!-- LLM 总结失败原因：' + llmNote.replace(/-->/g, '→') + ' -->')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * Utilities.                                                          *
 * ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function extractText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (!block || typeof block !== 'object') continue
    // Only real text blocks: skip reasoning / tool-call / image content.
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function redact(text) {
  return text
    .replace(/sk-[A-Za-z0-9]{12,}/g, 'sk-***')
    .replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_***')
    .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA***')
    .replace(/(api[_-]?key|apikey)\s*[:=]\s*(['"]?)[^\s'"]{8,}\2/gi, '$1: ***')
    .replace(/(password|passwd|secret|bearer\s+token)\s*[:=]\s*(['"]?)[^\s'"]{8,}\2/gi, '$1: ***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/g, 'Bearer ***')
}

/** Skill argument: what the next session should concentrate on. */
function readFocus(args) {
  if (!args || typeof args.focus !== 'string') return ''
  const trimmed = redact(args.focus.trim())
  if (!trimmed) return ''
  return trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : trimmed
}

function clamp(text, max) {
  return text.length > max ? text.slice(0, max) + '\n…（截断）' : text
}

function fmtTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function fmtStamp(d) {
  return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
}

function pad(n) { return String(n).padStart(2, '0') }

function sanitize(s) {
  let out = String(s)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
  out = out.slice(0, 60)
  return out || 'untitled'
}
