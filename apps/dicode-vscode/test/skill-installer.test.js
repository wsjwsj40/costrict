const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { SkillJobs } = require('../skillsJobs')
const { createInstaller, InstallerError, decideConflict, zipDigest } = require('../skillInstaller')
const { upsertRecord, readRegistry } = require('../skillsRegistry')
const marketStub = require('../marketStub')
const { fetchSkillDetail, fetchDownload } = require('../skillMarket')
const { JOBS_DIR, LOCKS_DIR } = require('../skillsJobs')

/** 每个用例独立 workspace + storageDir，桩 transport 端到端驱动（7.2：桩只给数据，安装走真实管道） */
async function makeInstaller(t, overrides = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dicode-ws-'))
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dicode-store-'))
  t.after(() => Promise.all([
    fs.rm(workspace, { recursive: true, force: true }),
    fs.rm(storageDir, { recursive: true, force: true }),
  ]))
  const state = overrides.stubState || marketStub.createStubState()
  const transport = marketStub.createTransport(state)
  const events = []
  const installer = createInstaller({
    workspace,
    storageDir,
    jobs: new SkillJobs({ storageDir }),
    transportFactory: overrides.transportFactory || (async () => transport),
    fetchDetail: fetchSkillDetail,
    download: fetchDownload,
    upsertRecord,
    reloadIndex: overrides.reloadIndex || (async () => true),
    postEvent: event => events.push(event),
    onFinished: overrides.onFinished,
    tuning: { lockTimeoutMs: 500, ...(overrides.tuning || {}) },
  })
  return { installer, workspace, storageDir, events, state, transport }
}

/** 轮询等待该 skillId 的任务进入期望状态（终态后从快照消失 → 用事件与登记兜底） */
async function waitFor(installer, skillId, predicate, timeoutMs = 5000) {
  const started = Date.now()
  for (;;) {
    const jobs = await installer.snapshot()
    const job = jobs.find(item => item.skillId === skillId)
    if (job && predicate(job)) return job
    if (!job) {
      // 快照口径不含 done：可能已经终态，查事件确认
      return null
    }
    if (Date.now() - started > timeoutMs) throw new Error(`等待任务超时：${skillId} 当前 ${job.state}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function waitForEvent(events, spec, timeoutMs = 5000) {
  const started = Date.now()
  for (;;) {
    const event = events.find(item =>
      (!spec.jobId || item.jobId === spec.jobId)
      && (!spec.skillId || item.skillId === spec.skillId)
      && (!spec.version || item.version === spec.version)
      && (!spec.state || item.state === spec.state))
    if (event) return event
    if (Date.now() - started > timeoutMs) throw new Error(`等待事件超时：${spec.skillId || spec.jobId} ${spec.state}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('正常包端到端：门禁→下载→校验→解压→登记→done，事件 seq 单调，临时文件清理', async t => {
  const { installer, workspace, storageDir, events } = await makeInstaller(t)
  const { jobId } = await installer.install('global/sql-explain', '1.0.3')
  await waitForEvent(events, { jobId, state: 'done' })

  // 事件序列：每阶段至少一条，seq 严格递增（downloading 内的进度事件算同阶段）
  const mine = events.filter(event => event.jobId === jobId)
  assert.deepEqual([...new Set(mine.map(event => event.state))], ['queued', 'downloading', 'verifying', 'extracting', 'registering', 'done'])
  for (let index = 1; index < mine.length; index++) assert.ok(mine[index].seq > mine[index - 1].seq, 'seq 严格递增')

  // 登记：source market + zip sha256 digest + 目录摘要
  const { skills } = await readRegistry(workspace)
  const record = skills.find(item => item.skillId === 'global/sql-explain')
  assert.ok(record, '登记应写入')
  assert.equal(record.version, '1.0.3')
  assert.equal(record.source, 'market')
  assert.match(record.digest, /^sha256:[0-9a-f]{64}$/)
  assert.match(record.dirDigest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(record.dir, '.agents/skills/sql-explain')
  assert.equal(record.indexStale, undefined)

  // 目录落盘 + 包内容可读
  const skillMd = await fs.readFile(path.join(workspace, '.agents', 'skills', 'sql-explain', 'SKILL.md'), 'utf8')
  assert.match(skillMd, /name: sql-explain/)

  // 清理：downloads 目录空、无 .tmp-* 残留
  assert.deepEqual(await fs.readdir(path.join(storageDir, 'downloads')), [])
  const skillDirEntries = await fs.readdir(path.join(workspace, '.agents', 'skills'))
  assert.ok(!skillDirEntries.some(name => name.startsWith('.tmp-')), '暂存目录应清理')

  // done 后快照不再包含该任务
  assert.equal((await installer.snapshot()).find(job => job.jobId === jobId), undefined)
})

test('连续三次安装同一版本只产生一个 jobId，第二个窗口同样命中在跑任务', async t => {
  const { installer, events } = await makeInstaller(t, {
    // transport 延迟，让任务有可观窗口（三次 install 串行发起，间隔内任务必须仍在跑）
    transportFactory: async () => {
      const inner = marketStub.createTransport(marketStub.createStubState())
      return async request => { await new Promise(resolve => setTimeout(resolve, 300)); return inner(request) }
    },
  })
  const first = await installer.install('global/pdf-tools', '1.2.0')
  assert.equal(first.reused, false)
  const second = await installer.install('global/pdf-tools', '1.2.0')
  const third = await installer.install('global/pdf-tools', '1.2.0')
  assert.equal(second.jobId, first.jobId, '去重复用原 jobId')
  assert.equal(third.jobId, first.jobId)
  assert.equal(second.reused, true)
  await waitForEvent(events, { skillId: 'global/pdf-tools', state: 'done' })
  const related = events.filter(event => event.skillId === 'global/pdf-tools')
  assert.equal(new Set(related.map(event => event.jobId)).size, 1, '全程只有一个 jobId')
})

test('CRC 损坏桩包触发可重试 ARCHIVE_CORRUPT，重试换正确包后成功', async t => {
  const { installer, workspace, events } = await makeInstaller(t)
  const { jobId } = await installer.install('global/api-mocker', '0.5.0')
  const failed = await waitForEvent(events, { skillId: 'global/api-mocker', state: 'failed' })
  assert.equal(failed.errorCode, 'ARCHIVE_CORRUPT')
  assert.equal(failed.retryable, true)
  assert.equal(failed.jobId, jobId)
  assert.equal((await readRegistry(workspace)).skills.length, 0, '失败不写登记')

  const retry = await installer.retry(jobId)
  assert.notEqual(retry.jobId, jobId, '重试用新 jobId，不复用旧 ID')
  await waitForEvent(events, { jobId: retry.jobId, state: 'done' })
  const { skills } = await readRegistry(workspace)
  assert.equal(skills.find(item => item.skillId === 'global/api-mocker')?.version, '0.5.0', '重试成功后登记写入')
})

test('来源校验失败/缺 SKILL.md/超限三类失败均不写登记且目录不动', async t => {
  const cases = [
    ['global/verify-mismatch', 'SOURCE_VERIFY_FAILED', false],
    ['global/broken-pkg', 'ARCHIVE_INVALID', false],
    ['global/heavy-pkg', 'ARCHIVE_TOO_LARGE', false],
  ]
  const { installer, workspace, events } = await makeInstaller(t)
  for (const [skillId, code, retryable] of cases) {
    const slug = skillId.split('/')[1]
    await installer.install(skillId, '1.0.0')
    const failed = await waitForEvent(events, { skillId, state: 'failed' })
    assert.equal(failed.errorCode, code, `${slug} 应报 ${code}`)
    assert.equal(failed.retryable, retryable)
    assert.equal((await readRegistry(workspace)).skills.find(item => item.skillId === skillId), undefined, `${slug} 不写登记`)
    const dirExists = await fs.stat(path.join(workspace, '.agents', 'skills', slug)).then(() => true, () => false)
    assert.equal(dirExists, false, `${slug} 不落目录`)
  }
})

test('不兼容与组织限制在提交时拒绝，不产生任务', async t => {
  const { installer } = await makeInstaller(t)
  await assert.rejects(installer.install('global/legacy-export', '1.0.0'), error => error.code === 'INCOMPATIBLE_CLIENT')
  await assert.rejects(installer.install('global/org-report', '0.9.0'), error => error.code === 'ORG_RESTRICTED')
  assert.deepEqual(await installer.snapshot(), [], '无任务产生')
})

test('目标目录被未登记目录占用报 DIR_CONFLICT：不写入、不改名、不覆盖原内容', async t => {
  const { installer, workspace, events } = await makeInstaller(t)
  const target = path.join(workspace, '.agents', 'skills', 'changelog-writer')
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(path.join(target, '手工文件.txt'), '手工放置的内容', 'utf8')
  await installer.install('global/changelog-writer', '1.1.0')
  const failed = await waitForEvent(events, { skillId: 'global/changelog-writer', state: 'failed' })
  assert.equal(failed.errorCode, 'DIR_CONFLICT')
  assert.equal(failed.retryable, false)
  assert.equal((await readRegistry(workspace)).skills.length, 0)
  assert.equal(await fs.readFile(path.join(target, '手工文件.txt'), 'utf8'), '手工放置的内容', '原内容原样保留')
})

test('目标目录被其他 skillId 的登记占用报 DIR_CONFLICT', async t => {
  const { installer, workspace, events } = await makeInstaller(t)
  const target = path.join(workspace, '.agents', 'skills', 'sql-explain')
  await fs.mkdir(target, { recursive: true })
  await upsertRecord(workspace, { skillId: 'ns/other-skill', name: '其他技能', version: '0.0.0-local', digest: null, dirDigest: 'sha256:x', dir: '.agents/skills/sql-explain', source: 'import', origin: 'sql-explain', installedAt: 1 })
  await installer.install('global/sql-explain', '1.0.3')
  const failed = await waitForEvent(events, { skillId: 'global/sql-explain', state: 'failed' })
  assert.equal(failed.errorCode, 'DIR_CONFLICT')
  // 他人登记保持不变
  const { skills } = await readRegistry(workspace)
  assert.equal(skills.length, 1)
  assert.equal(skills[0].skillId, 'ns/other-skill')
})

test('覆盖安装换版本成功，目录内容更新且无 .bak 残留', async t => {
  const { installer, workspace, events } = await makeInstaller(t)
  await installer.install('global/web-scraper', '1.2.2')
  await waitForEvent(events, { skillId: 'global/web-scraper', version: '1.2.2', state: 'done' })
  const oldContent = await fs.readFile(path.join(workspace, '.agents', 'skills', 'web-scraper', 'reference.txt'), 'utf8')
  assert.match(oldContent, /v1\.2\.2/)

  await installer.install('global/web-scraper', '1.2.3')
  await waitForEvent(events, { skillId: 'global/web-scraper', version: '1.2.3', state: 'done' })
  const newContent = await fs.readFile(path.join(workspace, '.agents', 'skills', 'web-scraper', 'reference.txt'), 'utf8')
  assert.match(newContent, /v1\.2\.3/, '目录内容换到新版本')

  const { skills } = await readRegistry(workspace)
  const records = skills.filter(item => item.skillId === 'global/web-scraper')
  assert.equal(records.length, 1, '同 skillId 单条登记')
  assert.equal(records[0].version, '1.2.3')
  const entries = await fs.readdir(path.join(workspace, '.agents', 'skills'))
  assert.ok(!entries.some(name => name.includes('.bak')), '无 .bak 残留')
})

test('登记写入失败时任务 failed 可重试，登记保持旧版本', async t => {
  let failUpsert = false
  const { installer, workspace, events } = await makeInstaller(t, {})
  // 先装旧版本
  await installer.install('global/web-scraper', '1.2.2')
  await waitForEvent(events, { skillId: 'global/web-scraper', version: '1.2.2', state: 'done' })

  // 用一个独立 installer 注入 upsertRecord 失败来模拟登记并发冲突
  const failInstaller = createInstaller({
    workspace,
    storageDir: await fs.mkdtemp(path.join(os.tmpdir(), 'dicode-store2-')),
    jobs: new SkillJobs({ storageDir: await (async () => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dicode-jobs2-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir })() }),
    transportFactory: async () => marketStub.createTransport(marketStub.createStubState()),
    fetchDetail: fetchSkillDetail,
    download: fetchDownload,
    upsertRecord: async (...args) => {
      if (failUpsert) throw Object.assign(new Error('并发写冲突'), { code: 'VERSION_CONFLICT' })
      return upsertRecord(...args)
    },
    reloadIndex: async () => true,
    postEvent: event => events.push(event),
    tuning: { lockTimeoutMs: 500 },
  })
  failUpsert = true
  await failInstaller.install('global/web-scraper', '1.2.3')
  const failed = await waitForEvent(events, { skillId: 'global/web-scraper', version: '1.2.3', state: 'failed' })
  assert.equal(failed.errorCode, 'VERSION_CONFLICT')
  assert.equal(failed.retryable, true)
  const { skills } = await readRegistry(workspace)
  assert.equal(skills.find(item => item.skillId === 'global/web-scraper')?.version, '1.2.2', '登记保持旧版本')
})

test('每工作区并发上限 2，第三个任务进 queued，完成后推进', async t => {
  const { installer, events } = await makeInstaller(t, {
    transportFactory: async () => {
      const inner = marketStub.createTransport(marketStub.createStubState())
      return async request => { await new Promise(resolve => setTimeout(resolve, 80)); return inner(request) }
    },
  })
  const [a, b, c] = await Promise.all([
    installer.install('global/pdf-tools', '1.2.0'),
    installer.install('global/code-review', '2.0.1'),
    installer.install('global/sql-explain', '1.0.3'),
  ])
  assert.notEqual(a.jobId, b.jobId)
  const sawQueued = events.some(event => event.jobId === c.jobId && event.state === 'queued')
  assert.ok(sawQueued, '第三个任务应经历 queued')
  // 等全部终态
  await waitForEvent(events, { skillId: 'global/pdf-tools', state: 'done' })
  await waitForEvent(events, { skillId: 'global/code-review', state: 'done' })
  await waitForEvent(events, { skillId: 'global/sql-explain', state: 'done' })
  const registered = (await installer.snapshot()).length
  assert.equal(registered, 0, '全部终态后快照为空')
})

test('同一技能不同版本串行：第二个任务等第一个终态后才启动', async t => {
  const { installer, events } = await makeInstaller(t, {
    transportFactory: async () => {
      const inner = marketStub.createTransport(marketStub.createStubState())
      return async request => { await new Promise(resolve => setTimeout(resolve, 70)); return inner(request) }
    },
  })
  const first = await installer.install('global/web-scraper', '1.2.2')
  const second = await installer.install('global/web-scraper', '1.2.3')
  assert.notEqual(first.jobId, second.jobId, '不同版本不去重')
  await waitForEvent(events, { jobId: first.jobId, state: 'done' })
  await waitForEvent(events, { jobId: second.jobId, state: 'done' })
  // 第二个任务首条事件是 queued（串行等待）
  const secondEvents = events.filter(event => event.jobId === second.jobId)
  assert.equal(secondEvents[0]?.state, 'queued')
})

test('扩展重启恢复：非终态转 INTERRUPTED 可重试，临时目录与下载 zip 清理', async t => {
  const { installer, workspace, storageDir, events } = await makeInstaller(t)
  // 预置中断现场：downloading 任务 + 残留暂存目录 + 残留 zip
  const jobs = new SkillJobs({ storageDir })
  await jobs.appendEvent({ jobId: 'old-1', workspaceId: installer.workspaceId, skillId: 'global/sql-explain', version: '1.0.3', state: 'downloading', seq: 3, progress: 40, retryable: false, startedAt: 1 })
  const staging = path.join(workspace, '.agents', 'skills', '.tmp-old-1')
  await fs.mkdir(staging, { recursive: true })
  await fs.writeFile(path.join(staging, 'junk.txt'), 'x', 'utf8')
  await fs.mkdir(path.join(storageDir, 'downloads'), { recursive: true })
  const zipPath = path.join(storageDir, 'downloads', 'old-1.zip')
  await fs.writeFile(zipPath, Buffer.from('PK\x05\x06'), 'binary')

  const recovered = await installer.recover()
  assert.equal(recovered.interrupted, 1)
  assert.ok(recovered.cleaned >= 2, '暂存目录与 zip 都应清理')
  const [job] = await jobs.snapshot(installer.workspaceId)
  assert.equal(job.state, 'failed')
  assert.equal(job.errorCode, 'INTERRUPTED')
  assert.equal(job.retryable, true)
  assert.equal(job.seq, 3, 'seq 不伪造')
  const stagingGone = await fs.stat(staging).then(() => false, () => true)
  assert.ok(stagingGone)
  const zipGone = await fs.stat(zipPath).then(() => false, () => true)
  assert.ok(zipGone)

  // 重试中断任务 → 新 jobId → 成功
  const retry = await installer.retry('old-1')
  assert.notEqual(retry.jobId, 'old-1')
  await waitForEvent(events, { jobId: retry.jobId, state: 'done' })
  assert.equal((await readRegistry(workspace)).skills.find(item => item.skillId === 'global/sql-explain')?.version, '1.0.3')
})

test('快照含失败任务；done 不含', async t => {
  const { installer, events } = await makeInstaller(t)
  await installer.install('global/api-mocker', '0.5.0') // crc-corrupt，首次必失败
  await waitForEvent(events, { skillId: 'global/api-mocker', state: 'failed' })
  const failed = (await installer.snapshot()).find(job => job.skillId === 'global/api-mocker')
  assert.ok(failed, '失败任务在快照里')
  assert.equal(failed.errorCode, 'ARCHIVE_CORRUPT')
  await installer.retry(failed.jobId)
  await waitForEvent(events, { skillId: 'global/api-mocker', state: 'done' })
  assert.equal((await installer.snapshot()).find(job => job.skillId === 'global/api-mocker'), undefined, 'done 后不在快照')
})

test('索引刷新失败标 indexStale 且安装仍成功；refreshIndex 重试后清除', async t => {
  let indexOk = false
  const { installer, workspace, events } = await makeInstaller(t, { reloadIndex: async () => indexOk })
  await installer.install('global/sql-explain', '1.0.3')
  const done = await waitForEvent(events, { skillId: 'global/sql-explain', state: 'done' })
  assert.ok(done, '索引失败不影响安装成功')
  let { skills } = await readRegistry(workspace)
  assert.equal(skills.find(item => item.skillId === 'global/sql-explain')?.indexStale, true)

  indexOk = true
  const result = await installer.refreshIndex('global/sql-explain')
  assert.equal(result.ok, true)
  assert.equal(result.indexStale, false)
  ;({ skills } = await readRegistry(workspace))
  assert.equal(skills.find(item => item.skillId === 'global/sql-explain')?.indexStale, false)
})

test('锁未失效时等待超时报 LOCK_TIMEOUT；心跳过期后可被接管', async t => {
  const { installer, workspace, storageDir, events } = await makeInstaller(t)
  const lockDir = path.join(storageDir, LOCKS_DIR, installer.workspaceId)
  await fs.mkdir(lockDir, { recursive: true })
  const lockFile = path.join(lockDir, 'sql-explain.lock')
  // 活锁：心跳刚刚更新
  await fs.writeFile(lockFile, JSON.stringify({ owner: 'other', pid: 1, heartbeatAt: Date.now() }), 'utf8')
  await installer.install('global/sql-explain', '1.0.3')
  const failed = await waitForEvent(events, { skillId: 'global/sql-explain', state: 'failed' })
  assert.equal(failed.errorCode, 'LOCK_TIMEOUT')
  assert.equal(failed.retryable, true)

  // 心跳过期 30 秒 → 接管成功
  await fs.writeFile(lockFile, JSON.stringify({ owner: 'other', pid: 1, heartbeatAt: Date.now() - 31_000 }), 'utf8')
  const { jobId } = await installer.install('global/sql-explain', '1.0.3')
  assert.ok(jobId)
  await waitForEvent(events, { skillId: 'global/sql-explain', state: 'done' })
})

test('decideConflict 与 zipDigest 纯函数口径', () => {
  const records = [
    { skillId: 'ns/a', dir: '.agents/skills/demo', source: 'market', version: '1.0.0' },
    { skillId: 'ns/b', dir: '.agents/skills/other', source: 'import', version: '0.0.0-local' },
  ]
  assert.deepEqual(decideConflict(records, 'fresh-dir', 'ns/c'), { mode: 'fresh' })
  assert.deepEqual(decideConflict(records, 'demo', 'ns/a'), { mode: 'upgrade', previous: { dir: '.agents/skills/demo', version: '1.0.0' } })
  assert.deepEqual(decideConflict(records, 'other-dir', 'ns/a').mode, 'new-dir-for-known-skill')
  assert.throws(() => decideConflict(records, 'demo', 'ns/c'), error => error.code === 'DIR_CONFLICT')
  assert.throws(() => decideConflict(records, 'other', 'ns/c'), error => error.code === 'DIR_CONFLICT')
  assert.match(zipDigest(Buffer.from('x')), /^sha256:[0-9a-f]{64}$/)
})

test('未配置 transport 时安装提交报网络错误且无任务', async t => {
  const { installer } = await makeInstaller(t, { transportFactory: async () => null })
  await assert.rejects(installer.install('global/sql-explain', '1.0.3'), error => error.code === 'NETWORK')
  assert.deepEqual(await installer.snapshot(), [])
})
