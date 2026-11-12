const { test } = require('node:test')
const assert = require('node:assert/strict')
const { unifiedDiff } = require('../unifiedDiff')
const { historicalDiff } = require('../diff')

test('earlier file edit reconstructs both sides after later edits to the same file', () => {
  const first = unifiedDiff('a.txt', 'one\n', 'two\n')
  const second = unifiedDiff('a.txt', 'two\n', 'three\n')
  const turns = [{ id: 'turn', items: [
    { id: 'first', type: 'fileChange', raw: { changes: [{ path: 'a.txt', diff: first }] } },
    { id: 'second', type: 'fileChange', raw: { changes: [{ path: 'a.txt', diff: second }] } },
  ] }]
  assert.deepEqual(historicalDiff('three\n', turns, { turnId: 'turn', itemId: 'first', changeIndex: 0, path: 'a.txt' }), { before: 'one\n', after: 'two\n' })
  assert.deepEqual(historicalDiff('three\n', turns, { turnId: 'turn', itemId: 'second', changeIndex: 0, path: 'a.txt' }), { before: 'two\n', after: 'three\n' })
})
