const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { SkillJobs, LOCK_STALE_MS } = require('../skillsJobs')

const WORKSPACE_ID = 'abc123def456'

/** 每个用例一个独立 storageDir */
async function makeJobs(t) {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dicode-jobs-'))
  t.after(() => fs.rm(storageDir, { recursive: true, force: true }))
  return { jobs: new SkillJobs({ storageDir }), storageDir }
}

/** 构造安装事件 */
const event = (seq, state, extra = {}) => ({
  jobId: 'j1',
  workspaceId: WORKSPACE_ID,
  skillId: 'ns/demo',
  version: '1.0.0',
  state,
  seq,
  retryable: false,
  ...extra,
})

test('事件写入后重放：任务表按 jobId 聚合', async t => {
  const { jobs } = await makeJobs(t)
  await jobs.appendEvent(event(0, 'queued'))
  await jobs.appendEvent(event(1, 'downloading', { progress: 20 }))
  await jobs.appendEvent(event(2, 'verifying'))
  const snapshot = await jobs.snapshot(WORKSPACE_ID)
  assert.equal(snapshot.length, 1)
  assert.equal(snapshot[0].jobId, 'j1')
  assert.equal(snapshot[0].state, 'verifying')
  assert.equal(snapshot[0].seq, 2)
  assert.equal(snapshot[0].progress, 20, '进度字段应保留')
})

test('同一状态下的多条进度事件都生效，重复 seq 被忽略', async t => {
  const { jobs } = await makeJobs(t)
  await jobs.appendEvent(event(0, 'downloading', { progress: 10 }))
  await jobs.appendEvent(event(1, 'downloading', { progress: 55 }))
  const applied = await jobs.appendEvent(event(1, 'downloading', { progress: 99 }))
  assert.equal(applied.applied, false)
  const stale = await jobs.appendEvent(event(0, 'downloading', { progress: 5 }))
  assert.equal(stale.applied, false)
  const [job] = await jobs.snapshot(WORKSPACE_ID)
  assert.equal(job.progress, 55)
})

test('终态任务不再接受后续事件', async t => {
  const { jobs } = await makeJobs(t)
  await jobs.appendEvent(event(0, 'downloading'))
  const done = await jobs.appendEvent(event(1, 'done'))
  assert.equal(done.applied, true)
  assert.ok(done.job.finishedAt)
  assert.equal((await jobs.appendEvent(event(2, 'downloading'))).applied, false)
  assert.equal((await jobs.snapshot(WORKSPACE_ID))[0].state, 'done')
})

test('recover 把非终态任务置为 INTERRUPTED，终态与 seq 不动', async t => {
  const { jobs } = await makeJobs(t)
  await jobs.appendEvent(event(0, 'downloading', { progress: 30 }))
  await jobs.appendEvent({ ...event(0, 'queued'), jobId: 'j2', skillId: 'ns/other' })
  await jobs.appendEvent({ ...event(0, 'done'), jobId: 'j3' })
  const { jobs: recovered, interrupted } = await jobs.recover(WORKSPACE_ID, 1000)
  assert.equal(interrupted, 2)
  const running = recovered.find(job => job.jobId === 'j1')
  assert.equal(running.state, 'failed')
  assert.equal(running.errorCode, 'INTERRUPTED')
  assert.equal(running.retryable, true)
  assert.equal(running.seq, 0, 'seq 不伪造')
  assert.equal(running.finishedAt, 1000)
  assert.equal(recovered.find(job => job.jobId === 'j3').state, 'done')
  // 已收敛的任务再次 recover 不再计数
  assert.equal((await jobs.recover(WORKSPACE_ID)).interrupted, 0)
})

test('任务表损坏时留 .bak 并返回空表', async t => {
  const { jobs } = await makeJobs(t)
  const file = jobs.jobsFile(WORKSPACE_ID)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, '{ not json')
  assert.deepEqual(await jobs.snapshot(WORKSPACE_ID), [])
  assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), '{ not json')
  await jobs.appendEvent(event(0, 'queued'))
  assert.equal((await jobs.snapshot(WORKSPACE_ID)).length, 1)
})

test('不同工作区的任务表互不干扰', async t => {
  const { jobs } = await makeJobs(t)
  await jobs.appendEvent(event(0, 'queued'))
  await jobs.appendEvent({ ...event(0, 'queued'), workspaceId: 'other0000000' })
  assert.equal((await jobs.snapshot(WORKSPACE_ID)).length, 1)
  assert.equal((await jobs.snapshot('other0000000')).length, 1)
})

test('目录锁未失效时二次抢锁超时报 LOCK_TIMEOUT', async t => {
  const { jobs } = await makeJobs(t)
  const held = await jobs.acquireLock(WORKSPACE_ID, 'demo', { heartbeatMs: 0, timeoutMs: 150 })
  await assert.rejects(jobs.acquireLock(WORKSPACE_ID, 'demo', { heartbeatMs: 0, timeoutMs: 150 }), error => error.code === 'LOCK_TIMEOUT')
  await held.release()
})

test('心跳超时的锁可被接管，release 后锁文件消失', async t => {
  const { jobs } = await makeJobs(t)
  const file = jobs.lockFile(WORKSPACE_ID, 'demo')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ owner: 'dead-owner', heartbeatAt: Date.now() - LOCK_STALE_MS * 2 }))
  const taken = await jobs.acquireLock(WORKSPACE_ID, 'demo', { heartbeatMs: 0, timeoutMs: 500 })
  await taken.release()
  assert.equal(await fs.stat(file).then(() => true, () => false), false)
})

test('心跳持续更新时不会被判定失效', async t => {
  const { jobs } = await makeJobs(t)
  let clock = Date.now()
  const now = () => clock
  const held = await jobs.acquireLock(WORKSPACE_ID, 'demo', { heartbeatMs: 0, timeoutMs: 150, staleMs: 1000, now })
  clock += 900
  await held.heartbeat()
  clock += 900
  // 心跳刚更新过，第二次抢锁仍应超时而不是接管
  await assert.rejects(jobs.acquireLock(WORKSPACE_ID, 'demo', { heartbeatMs: 0, timeoutMs: 120, staleMs: 1000, now }), error => error.code === 'LOCK_TIMEOUT')
  await held.release()
})

test('clearStaleLocks 只清失效锁，保留活锁', async t => {
  const { jobs } = await makeJobs(t)
  const held = await jobs.acquireLock(WORKSPACE_ID, 'alive', { heartbeatMs: 0, timeoutMs: 150 })
  const deadFile = jobs.lockFile(WORKSPACE_ID, 'dead')
  await fs.mkdir(path.dirname(deadFile), { recursive: true })
  await fs.writeFile(deadFile, JSON.stringify({ owner: 'x', heartbeatAt: Date.now() - LOCK_STALE_MS * 2 }))
  assert.equal(await jobs.clearStaleLocks(WORKSPACE_ID), 1)
  assert.equal(await fs.stat(jobs.lockFile(WORKSPACE_ID, 'alive')).then(() => true, () => false), true)
  assert.equal(await fs.stat(deadFile).then(() => true, () => false), false)
  await held.release()
})

test('workspaceId 与锁名不能越出存储目录', async t => {
  const { jobs } = await makeJobs(t)
  assert.throws(() => jobs.jobsFile('../evil'), /workspaceId 不合法/)
  assert.throws(() => jobs.jobsFile('a/b'), /workspaceId 不合法/)
  assert.throws(() => jobs.lockFile(WORKSPACE_ID, '../evil'), /锁名称不合法/)
  assert.throws(() => jobs.lockFile(WORKSPACE_ID, '..'), /锁名称不合法/)
  await assert.rejects(jobs.appendEvent(event(-1, 'queued')), /seq/)
  await assert.rejects(jobs.appendEvent({ seq: 0 }), /jobId/)
})
