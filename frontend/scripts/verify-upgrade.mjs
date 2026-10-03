import 'fake-indexeddb/auto'
import Dexie from 'dexie'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

const seedSheets = [
  { id: 's1', code: '甲-1', title: '旧图幅一', year: 1900, scale: '1:5000', projection: 'p', sheetSizeCm: '1', series: 'g', neighborCodes: [], status: '已编' },
  { id: 's2', code: '甲-2', title: '旧图幅二', year: 1910, scale: '1:50000', projection: 'p', sheetSizeCm: '2', series: 'g', neighborCodes: [], status: '待核' },
]
const seedScans = [
  { id: 'sc1', sheetId: 's1', fileName: 'a.tif', resolutionDpi: 600, colorMode: '彩色', pieces: 1, quality: '清晰', storageNote: 'x', importedAt: '2025-01-01', isPrimary: true },
]
const seedPairs = [{ id: 'p1', sheetId: 's1', oldName: '旧', newName: '新', aliasList: [], placeType: '村镇', coordNote: 'c', certainty: '确定' }]
const seedHistories = [{ id: 'h1', placePairId: 'p1', period: '明代', name: '旧名', changeType: '初置', sourceRef: '志', note: '' }]

// 1) 先以 v2 结构建库并灌入旧数据
const oldDb = new Dexie('gboldmap-db')
oldDb.version(2).stores({
  sheets: 'id, code, year, scale, status, series',
  scans: 'id, sheetId, importedAt, quality',
  placePairs: 'id, sheetId, oldName, newName, placeType, certainty',
  histories: 'id, placePairId, period, changeType',
})
await oldDb.sheets.bulkAdd(seedSheets)
await oldDb.scans.bulkAdd(seedScans)
await oldDb.placePairs.bulkAdd(seedPairs)
await oldDb.histories.bulkAdd(seedHistories)
oldDb.close()

// 2) 用应用当前数据库（v3）重新打开，触发 upgrade
const { db } = await import('./src/utils/db.ts')
await db.open()

const baselines = await db.baselines.toArray()
const baselineCommits = await db.commits.where('seq').equals(0).toArray()
console.log(`基线条数=${baselines.length}，基线提交条数=${baselineCommits.length}`)

check('每个旧图幅生成一条基线', baselines.length === 2, `count=${baselines.length}`)
check('每个旧图幅生成一条 seq=0 提交', baselineCommits.length === 2)

const s1 = baselines.find((b) => b.sheetId === 's1')
check('s1 基线含图幅卡', s1.sheet?.id === 's1')
check('s1 基线含扫描件', s1.scans.length === 1 && s1.scans[0].id === 'sc1')
check('s1 基线含地名', s1.placePairs.length === 1 && s1.placePairs[0].id === 'p1')
check('s1 基线含沿革（按地名归图幅）', s1.histories.length === 1 && s1.histories[0].id === 'h1')
const s2 = baselines.find((b) => b.sheetId === 's2')
check('s2 基线附属为空', s2.scans.length === 0 && s2.placePairs.length === 0 && s2.histories.length === 0)

const c1 = baselineCommits.find((c) => c.sheetId === 's1')
check('基线提交说明标注旧数据升级', c1.message.includes('首个提交点'))
check('基线提交 baseSeq=0', c1.baseSeq === 0)

// 3) 旧主档四仓数据在升级后原样保留
check('主档图幅仍为2条', (await db.sheets.count()) === 2)
check('主档扫描件仍为1条', (await db.scans.count()) === 1)

console.log(failures === 0 ? '\n旧数据升级验证通过 ✅' : `\n${failures} 条断言失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
