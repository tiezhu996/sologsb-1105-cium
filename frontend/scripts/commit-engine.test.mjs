/* eslint-disable */
// 关键提交语义的集成验证（fake-indexeddb + 真实应用模块）：
// 1) 旧数据 v2 → v3 升级：现有记录重放为每图幅首个提交点，行版本置 1
// 2) 两页签并发：干净步骤合并、撞车步骤进待核、主档停在上一提交点
// 3) 同组操作任一条撞车 → 整组挂起，不写一半
// 4) 同提交内互相依赖（地名+沿革）→ 双双挂起，无孤记录
// 5) 待核采纳后重放 / 行版本推进
// 6) 链上提交点已被推进时写入失败 → 事务回滚，主档不变
await import('fake-indexeddb/auto')
const DexieModule = await import('dexie')
const Dexie = DexieModule.default

let passed = 0
function assert(condition, message) {
  if (!condition) {
    console.error(`✗ ${message}`)
    process.exitCode = 1
    throw new Error(message)
  }
  passed += 1
  console.log(`✓ ${message}`)
}

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = resolve
    req.onerror = reject
    req.onblocked = reject
  })
}

async function seedLegacyV2() {
  const name = 'gboldmap-db'
  await deleteDatabase(name)
  const old = new Dexie(name)
  old.version(1).stores({
    sheets: 'id, code, year, scale, status, series',
    scans: 'id, sheetId, importedAt, quality',
    placePairs: 'id, sheetId, oldName, newName, placeType, certainty',
    histories: 'id, placePairId, period, changeType',
  })
  old.version(2).stores({
    sheets: 'id, code, year, scale, status, series',
    scans: 'id, sheetId, importedAt, quality',
    placePairs: 'id, sheetId, oldName, newName, placeType, certainty',
    histories: 'id, placePairId, period, changeType',
  })
  await old.sheets.bulkAdd([
    { id: 's1', code: '甲-1', title: '图一', year: 1900, scale: '1:5000', projection: 'p', sheetSizeCm: '1', series: '组', neighborCodes: [], status: '待编' },
    { id: 's2', code: '乙-1', title: '图二', year: 1901, scale: '1:5000', projection: 'p', sheetSizeCm: '1', series: '组', neighborCodes: [], status: '待编' },
  ])
  await old.scans.bulkAdd([
    { id: 'sc1', sheetId: 's1', fileName: 'a.tif', resolutionDpi: 600, colorMode: '彩色', pieces: 1, quality: '清晰', storageNote: '柜1', importedAt: '2025-01-01T00:00:00Z', isPrimary: true },
    { id: 'sc2', sheetId: 's1', fileName: 'b.tif', resolutionDpi: 300, colorMode: '黑白', pieces: 1, quality: '偏淡', storageNote: '柜2', importedAt: '2025-02-01T00:00:00Z', isPrimary: false },
  ])
  await old.placePairs.bulkAdd([
    { id: 'p1', sheetId: 's1', oldName: '旧名', newName: '今名', aliasList: [], placeType: '村镇', coordNote: '东', certainty: '确定' },
  ])
  await old.histories.bulkAdd([
    { id: 'h1', placePairId: 'p1', period: '明', name: '旧名', changeType: '初置', sourceRef: '志', note: '' },
  ])
  old.close()
}

const ALL_TABLES_NAME = 'gboldmap-db'

function commitRecord({ id, sheetId, seq, ops, tabId, label, clientBaseRev }) {
  return {
    id,
    sheetId,
    seq,
    rev: seq,
    kind: 'commit',
    label: label ?? `提交${seq}`,
    ops,
    appliedOpCount: 0,
    tabId: tabId ?? `tab-${id}`,
    clientBaseRev: clientBaseRev ?? seq - 1,
    createdAt: new Date(Date.UTC(2026, 0, seq)).toISOString(),
  }
}

async function submitCommit(appDb, replayCommit, record) {
  return appDb.transaction(
    'rw',
    [appDb.commits, appDb.conflicts, appDb.sheets, appDb.scans, appDb.placePairs, appDb.histories],
    async () => {
      const latest = await appDb.commits.where('sheetId').equals(record.sheetId).reverse().sortBy('seq')
      const actualHead = latest[0]?.seq ?? 0
      if (actualHead !== record.clientBaseRev) {
        throw new Error(`stale base ${record.clientBaseRev} != ${actualHead}`)
      }
      const replay = await replayCommit(record)
      record.appliedOpCount = replay.appliedOpCount
      await appDb.commits.add(record)
      if (replay.conflicts.length) await appDb.conflicts.bulkAdd(replay.conflicts)
      return replay
    },
  )
}

async function run() {
  // ---- 1) 旧数据升级 ----
  await seedLegacyV2()
  const { db: appDb } = await import('../src/utils/db.ts')
  const { replayCommit } = await import('../src/utils/commitEngine.ts')
  await appDb.open()

  const commitsS1 = await appDb.commits.where('sheetId').equals('s1').sortBy('seq')
  const commitsS2 = await appDb.commits.where('sheetId').equals('s2').sortBy('seq')
  assert(commitsS1.length === 1 && commitsS2.length === 1, '每个图幅旧数据各建一个首个提交点')
  assert(commitsS1[0].kind === 'bootstrap' && commitsS1[0].seq === 1, '首个提交点为建账提交 seq=1')
  const baseline = commitsS1[0]
  assert(baseline.appliedOpCount === baseline.ops.length, '建账提交包含全部旧记录（图幅/2扫描/地名/沿革）')
  assert(baseline.ops.length === 5, `建账操作数为 5（实际 ${baseline.ops.length}）`)
  const s1 = await appDb.sheets.get('s1')
  const sc1 = await appDb.scans.get('sc1')
  const sc2 = await appDb.scans.get('sc2')
  const p1 = await appDb.placePairs.get('p1')
  const h1 = await appDb.histories.get('h1')
  assert([s1, sc1, p1, h1].every((r) => r.rowRev === 1), '升级后主档行版本统一为 1')
  assert((s1).schemaRev === 3, '旧图幅 schemaRev 落在 3')

  // ---- 2) 两页签并发 ----
  const s1A = JSON.parse(JSON.stringify(s1))
  const s1B = JSON.parse(JSON.stringify(s1))
  // 页签A：先提交，改题名（基于行版本1）
  const recA = commitRecord({
    id: 'cA', sheetId: 's1', seq: 2, tabId: 'tabA',
    ops: [{ kind: 'sheetUpsert', clientId: 'opA', baseRowRev: 1, entity: { ...s1A, title: '题名A' } }],
  })
  const rA = await submitCommit(appDb, replayCommit, recA)
  assert(rA.appliedOpCount === 1 && rA.conflicts.length === 0, '页签A图幅修订干净落档')

  // 页签B：基于同一旧版本，既补扫描件（独立对象）又改题名（撞车）
  const recB = commitRecord({
    id: 'cB', sheetId: 's1', seq: 3, clientBaseRev: 2, tabId: 'tabB',
    ops: [
      { kind: 'scanUpsert', clientId: 'opScan', baseRowRev: 0, entity: { id: 'sc3', sheetId: 's1', fileName: 'c.tif', resolutionDpi: 400, colorMode: '灰度', pieces: 2, quality: '清晰', storageNote: '柜3', importedAt: '2026-03-01T00:00:00Z', isPrimary: false } },
      { kind: 'sheetUpsert', clientId: 'opB', baseRowRev: 1, entity: { ...s1B, title: '题名B' } },
    ],
  })
  const rB = await submitCommit(appDb, replayCommit, recB)
  assert(rB.appliedOpCount === 1, '页签B补的扫描件照常重放——双方步骤都保留')
  assert(rB.conflicts.length === 1 && rB.conflicts[0].reason === 'row-changed', '页签B撞车的图幅修订进待核')
  const masterS1 = await appDb.sheets.get('s1')
  assert(masterS1.title === '题名A', '主档题名停在已提交的A，未被B覆盖')
  assert(masterS1.rowRev === 2, '图幅行版本随干净提交推进到2')
  const sc3 = await appDb.scans.get('sc3')
  assert(sc3 && sc3.rowRev === 1, '扫描件已落主档')

  // ---- 5) 采纳待核（force）重放 ----
  const acceptOps = rB.conflicts[0].ops.map((op) => ({ ...op, force: true, clientId: 'opB-ok' }))
  const recC = commitRecord({
    id: 'cC', sheetId: 's1', seq: 4, clientBaseRev: 3, tabId: 'tabB', label: '采纳待核',
    ops: acceptOps,
  })
  const rC = await submitCommit(appDb, replayCommit, recC)
  assert(rC.appliedOpCount === 1 && rC.conflicts.length === 0, '采纳后改动作为新提交重放')
  const afterAccept = await appDb.sheets.get('s1')
  assert(afterAccept.title === '题名B' && afterAccept.rowRev === 3, '采纳后题名变更、行版本到3')

  // ---- 3) 同组操作：原主用件被另一页签先改，切换主用件整组挂起 ----
  const recPre = commitRecord({
    id: 'cPre', sheetId: 's1', seq: 5, clientBaseRev: 4, tabId: 'tabA',
    ops: [{ kind: 'scanUpsert', clientId: 'opPre', baseRowRev: 1, entity: { ...sc1, storageNote: 'A改过存放位置' } }],
  })
  const rPre = await submitCommit(appDb, replayCommit, recPre)
  assert(rPre.appliedOpCount === 1, '另一页签先改原主用件成功')
  const staleSc1 = { ...sc1 } // 仍是行版本1的陈旧副本
  const recGrp = commitRecord({
    id: 'cGrp', sheetId: 's1', seq: 6, clientBaseRev: 5, tabId: 'tabB',
    ops: [
      { kind: 'scanUpsert', clientId: 'opOld', baseRowRev: 1, groupId: 'g1', entity: { ...staleSc1, isPrimary: false } },
      { kind: 'scanUpsert', clientId: 'opNew', baseRowRev: 1, groupId: 'g1', entity: { ...sc2, isPrimary: true } },
    ],
  })
  const rG = await submitCommit(appDb, replayCommit, recGrp)
  assert(rG.appliedOpCount === 0, '同组切换没有只落一半：两条都未写主档')
  assert(rG.conflicts.length === 2, '组内两条都进待核')
  assert(rG.conflicts.some((c) => c.reason === 'dependency'), '一条标记为组依赖挂起')
  const primaryNow = await appDb.scans.get('sc1')
  const otherNow = await appDb.scans.get('sc2')
  assert(primaryNow.isPrimary === true && otherNow.isPrimary === false, '主用件关系保持原状')

  // ---- 4) 同提交内互相依赖：新地名基于陈旧版本 + 其沿革 ----
  const recBoth = commitRecord({
    id: 'cBoth', sheetId: 's1', seq: 7, clientBaseRev: 6, tabId: 'tabB',
    ops: [
      { kind: 'pairUpsert', clientId: 'opPair', baseRowRev: 99, entity: { id: 'pnew', sheetId: 's1', oldName: 'X', newName: 'Y', aliasList: [], placeType: '桥梁', coordNote: '南', certainty: '确定' } },
      { kind: 'historyUpsert', clientId: 'opHist', baseRowRev: 0, entity: { id: 'hnew', placePairId: 'pnew', period: '民国', name: 'XY', changeType: '初置', sourceRef: '册', note: '' } },
    ],
  })
  const rBoth = await submitCommit(appDb, replayCommit, recBoth)
  assert(rBoth.appliedOpCount === 0, '互相依赖的改动没有只落一半：沿革未单独落档')
  assert(rBoth.conflicts.length === 2, '地名与沿革双双进待核')
  const orphan = await appDb.histories.get('hnew')
  assert(!orphan, '不存在没有地名归属的沿革孤记录')

  // ---- 6) 提交点竞态：陈旧 clientBaseRev 写入失败并整体回滚 ----
  const recStale = commitRecord({
    id: 'cStale', sheetId: 's1', seq: 99, clientBaseRev: 1, tabId: 'tabC',
    ops: [{ kind: 'sheetUpsert', clientId: 'opStale', baseRowRev: 3, entity: { ...afterAccept, title: '陈旧提交' } }],
  })
  let threw = false
  try {
    await submitCommit(appDb, replayCommit, recStale)
  } catch (error) {
    threw = true
  }
  assert(threw, '提交点已被推进时，陈旧提交被拒绝并抛错（事务回滚）')
  const committedStale = await appDb.commits.get('cStale')
  assert(!committedStale, '失败的操作记录未落库')
  const masterFinal = await appDb.sheets.get('s1')
  assert(masterFinal.title === '题名B', '回滚后主档仍停在上一提交点')

  const conflictCount = await appDb.conflicts.count()
  assert(conflictCount === 5, `待核台累计 5 条（实际 ${conflictCount}）`)

  console.log(`\n全部 ${passed} 项断言通过`)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
