import 'fake-indexeddb/auto'
import { db } from './src/utils/db.ts'
import { submitWorkspace, repairSheet, resolveConflict, readMasterSlice } from './src/utils/commitService.ts'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

function patchOp(label, payload, beforePatch) {
  return { type: 'sheet.patch', label, payload, beforePatch }
}

async function main() {
  // 等待种子数据与基线就绪
  await db.open()
  const sheetId = 'sheet-bp-jia-3'
  const masterBefore = await readMasterSlice(sheetId)
  const yearBefore = masterBefore.sheet.year
  const statusBefore = masterBefore.sheet.status
  console.log('基线：', yearBefore, statusBefore)

  console.log('\n[1] 两个页签基于同一提交点(seq=0)暂存不同改动')
  const yearOp = patchOp('改年代', { year: 1910 }, { year: yearBefore })
  const statusOp = patchOp('改状态', { status: '已编' }, { status: statusBefore })

  console.log('\n[2] 页签A先提交（改年代）')
  const a = await submitWorkspace({
    sheetId, tabId: 'tabA', tabLabel: '页签A', message: 'A改年代',
    baseSeq: 0, ops: [yearOp],
  })
  check('A提交序号为1', a.commit.seq === 1, `seq=${a.commit.seq}`)
  check('A无冲突', a.conflicts.length === 0)
  let master = await readMasterSlice(sheetId)
  check('主档年代=1910', master.sheet.year === 1910)

  console.log('\n[3] 页签B后提交（改状态，字段不同，应干净合并）')
  const b = await submitWorkspace({
    sheetId, tabId: 'tabB', tabLabel: '页签B', message: 'B改状态',
    baseSeq: 0, ops: [statusOp],
  })
  check('B提交序号为2', b.commit.seq === 2)
  check('B无冲突（不同字段合并）', b.conflicts.length === 0, `conflicts=${b.conflicts.length}`)
  master = await readMasterSlice(sheetId)
  check('主档年代仍=1910（保留A）', master.sheet.year === 1910)
  check('主档状态=已编（合并B）', master.sheet.status === '已编')

  console.log('\n[4] 两页签同改同字段（年代）→ 后提交者冲突进待核，主档保留先到值')
  const a2 = await submitWorkspace({
    sheetId, tabId: 'tabA', tabLabel: '页签A', message: 'A改年代1911',
    baseSeq: 2, ops: [patchOp('A年代1911', { year: 1911 }, { year: 1910 })],
  })
  check('A2无冲突', a2.conflicts.length === 0)
  const b2 = await submitWorkspace({
    sheetId, tabId: 'tabB', tabLabel: '页签B', message: 'B改年代1999',
    baseSeq: 2, ops: [patchOp('B年代1999', { year: 1999 }, { year: 1910 })],
  })
  check('B2有1处冲突', b2.conflicts.length === 1)
  check('B2提交记录仍保留其步骤', b2.commit.ops.length === 1)
  check('B2冲突下标=[0]', JSON.stringify(b2.commit.conflictIndexes) === '[0]')
  master = await readMasterSlice(sheetId)
  check('主档年代停在上一提交点=1911（B的1999不落主档）', master.sheet.year === 1911, `year=${master.sheet.year}`)
  check('主档状态仍=已编（互不依赖改动保留）', master.sheet.status === '已编')
  const pending = await db.pendingConflicts.where('status').equals('待核').toArray()
  check('待核库有1条待核', pending.length === 1, `count=${pending.length}`)
  check('待核字段记录三方值', pending[0]?.fields[0]?.ours === 1999 && pending[0]?.fields[0]?.theirs === 1911 && pending[0]?.fields[0]?.base === 1910)

  console.log('\n[5] 采纳待核（B的1999）→ 主档更新为1999')
  await resolveConflict({ conflictId: pending[0].id, resolution: '采纳', tabId: 'tabC', tabLabel: '裁定页签' })
  master = await readMasterSlice(sheetId)
  check('采纳后主档年代=1999', master.sheet.year === 1999)

  console.log('\n[6] 新增类操作并发：两页签各补扫描件，双方都保留')
  const scanCountBefore = (await readMasterSlice(sheetId)).scans.length
  await submitWorkspace({
    sheetId, tabId: 'tabA', tabLabel: '页签A', message: 'A补扫描件', baseSeq: 5,
    ops: [{ type: 'scan.add', label: '扫描X', payload: { id: 'scanX', sheetId, fileName: 'X.tif', resolutionDpi: 600, colorMode: '彩色', pieces: 1, quality: '清晰', storageNote: '柜1', importedAt: '2026-01-01', isPrimary: false } }],
  })
  await submitWorkspace({
    sheetId, tabId: 'tabB', tabLabel: '页签B', message: 'B补扫描件', baseSeq: 5,
    ops: [{ type: 'scan.add', label: '扫描Y', payload: { id: 'scanY', sheetId, fileName: 'Y.tif', resolutionDpi: 300, colorMode: '黑白', pieces: 2, quality: '偏淡', storageNote: '柜2', importedAt: '2026-01-02', isPrimary: false } }],
  })
  master = await readMasterSlice(sheetId)
  check('两件扫描件都在', master.scans.some((s) => s.id === 'scanX') && master.scans.some((s) => s.id === 'scanY'))
  check('扫描件总数+2', master.scans.length === scanCountBefore + 2, `count=${master.scans.length}`)

  console.log('\n[7] 故障演练：提交中途失败 → 整笔回滚，主档与工作区停在上一提交点')
  const yearNow = (await readMasterSlice(sheetId)).sheet.year
  let rolledBack = false
  try {
    await submitWorkspace({
      sheetId, tabId: 'tabD', tabLabel: '故障页签', message: '应回滚', baseSeq: 7,
      ops: [patchOp('改年代2001', { year: 2001 }, { year: yearNow })],
      failBeforeCommit: true,
    })
  } catch {
    rolledBack = true
  }
  check('提交抛错', rolledBack)
  master = await readMasterSlice(sheetId)
  check('失败后主档年代不变', master.sheet.year === yearNow, `year=${master.sheet.year}`)
  const commitsCount = (await db.commits.where('sheetId').equals(sheetId).toArray()).length

  console.log('\n[8] 从上一提交点修复（主档被外力改坏后可恢复）')
  await db.sheets.update(sheetId, { year: 1234 })
  await repairSheet(sheetId)
  master = await readMasterSlice(sheetId)
  check('修复后主档年代回到提交点值', master.sheet.year === 1999, `year=${master.sheet.year}`)

  void commitsCount
  console.log(failures === 0 ? '\n全部断言通过 ✅' : `\n${failures} 条断言失败 ❌`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
