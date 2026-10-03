import Dexie from 'dexie'
import type { NameHistory } from '../types/history'
import type { PlacePair } from '../types/placePair'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'
import { createId, db, plain } from './db'
import {
  applyOp,
  createSnapshot,
  detectConflicts,
  sliceOf,
} from './journal'
import type {
  CommitOp,
  CommitRecord,
  CommitResult,
  MasterSnapshot,
  PendingConflict,
  SheetBaseline,
  SheetSlice,
} from '../types/commit'

/** 读取图幅当前提交序号（无基线视为 0）。 */
export async function getHeadSeq(sheetId: string): Promise<number> {
  const baseline = await db.baselines.get(sheetId)
  return baseline?.seq ?? 0
}

async function listCommits(sheetId: string): Promise<CommitRecord[]> {
  const rows = await db.commits.where('sheetId').equals(sheetId).toArray()
  return rows.sort((left, right) => left.seq - right.seq)
}

/**
 * 从上一提交点（基线快照）出发，依序重放全部已提交操作，
 * 跳过仍在待核的操作字段，物化出当前应有的主档状态。
 */
async function materialize(sheetId: string): Promise<{ snapshot: MasterSnapshot; slice: SheetSlice }> {
  const [baselines, commits, pendingRows] = await Promise.all([
    db.baselines.toArray(),
    listCommits(sheetId),
    db.pendingConflicts.where('sheetId').equals(sheetId).toArray(),
  ])
  const baseline = baselines.find((item) => item.sheetId === sheetId)
  const snapshot = createSnapshot(baseline ? [baseline] : [])

  const conflictByKey = new Map<string, PendingConflict>()
  for (const conflict of pendingRows) {
    conflictByKey.set(`${conflict.commitId}:${conflict.opIndex}`, conflict)
  }

  for (const commit of commits) {
    if (commit.seq === 0) {
      continue
    }
    commit.ops.forEach((op, opIndex) => {
      const conflict = conflictByKey.get(`${commit.id}:${opIndex}`)
      if (!conflict) {
        applyOp(snapshot, sheetId, op)
        return
      }
      if (conflict.status === '已采纳') {
        // 采纳后待核值已合并进操作本身，按完整步骤重放
        applyOp(snapshot, sheetId, op)
        return
      }
      // 待核或已舍弃：主档停在上一提交点，只落地同一步中的干净字段
      if (conflict.cleanPatch) {
        applyOp(snapshot, sheetId, op, conflict.cleanPatch)
      }
    })
  }

  return { snapshot, slice: sliceOf(snapshot, sheetId) }
}

/** 从主档读取某图幅的最新聚合状态。 */
export async function readMasterSlice(sheetId: string): Promise<SheetSlice> {
  const [maybeSheet, scans, placePairs] = await Promise.all([
    db.sheets.get(sheetId),
    db.scans.where('sheetId').equals(sheetId).toArray(),
    db.placePairs.where('sheetId').equals(sheetId).toArray(),
  ])
  const sheet = maybeSheet ?? null
  const placeIds = new Set(placePairs.map((pair) => pair.id))
  const allHistories = placeIds.size ? await db.histories.toArray() : []
  const histories = allHistories.filter((history) => placeIds.has(history.placePairId))
  return { sheet, scans, placePairs, histories }
}

export interface SubmitWorkspaceInput {
  sheetId: string
  tabId: string
  tabLabel: string
  message: string
  baseSeq: number
  ops: CommitOp[]
  /** 故障演练：置 true 时在主档写入后、提交点落盘前抛错，验证整笔回滚 */
  failBeforeCommit?: boolean
}

/**
 * 按图幅原子提交一组步骤。
 *
 * 全部写入（主档四仓、提交记录、待核、工作区清理、基线推进）在同一个 Dexie
 * 事务内完成：任何一步失败，事务整体回滚，互相依赖的改动不会只落一半，
 * 主档仍停在上一提交点，页签暂存步骤原样保留可重试。
 *
 * 两个页签基于同一提交点先后提交时，后到者按操作步骤重放：双方步骤都保留，
 * 同字段互改的部分进入待核，其余改动照常合并。
 */
export async function submitWorkspace(input: SubmitWorkspaceInput): Promise<CommitResult> {
  const { sheetId, ops, baseSeq } = input
  if (ops.length === 0) {
    throw new Error('没有可提交的步骤')
  }

  return db.transaction(
    'rw',
    [
      db.sheets,
      db.scans,
      db.placePairs,
      db.histories,
      db.commits,
      db.baselines,
      db.pendingConflicts,
      db.workspaces,
    ],
    async () => {
      const headBaseline = await db.baselines.get(sheetId)
      const headSeq = headBaseline?.seq ?? 0
      const commitSeq = headSeq + 1

      // 1) 从本页签暂存时固化的基快照出发（旧工作区缺基快照时退回当前主档）
      const ownWorkspace = await db.workspaces
        .where('tabId')
        .equals(input.tabId)
        .and((ws: { sheetId: string }) => ws.sheetId === sheetId)
        .first()
      const baseSnapshot = ownWorkspace?.baseSlice
        ? createSnapshot([
            {
              sheetId,
              seq: baseSeq,
              sheet: ownWorkspace.baseSlice.sheet,
              scans: ownWorkspace.baseSlice.scans,
              placePairs: ownWorkspace.baseSlice.placePairs,
              histories: ownWorkspace.baseSlice.histories,
              capturedAt: '',
            },
          ])
        : (await materialize(sheetId)).snapshot

      // 2) 依次重放基序号之后、由其它页签（或本页签此前）已经提交的步骤，
      //    重放时按待核现状剔除仍未裁定的冲突字段——保留双方步骤并合并互不依赖的改动
      const interveningCommits = (await listCommits(sheetId)).filter(
        (record) => record.seq > baseSeq && record.seq <= headSeq,
      )
      const pendingRows = await db.pendingConflicts.where('sheetId').equals(sheetId).toArray()
      const conflictByKey = new Map(pendingRows.map((conflict) => [`${conflict.commitId}:${conflict.opIndex}`, conflict]))
      for (const record of interveningCommits) {
        record.ops.forEach((committedOp, opIndex) => {
          const conflict = conflictByKey.get(`${record.id}:${opIndex}`)
          if (conflict && conflict.status !== '已采纳') {
            if (conflict.cleanPatch) {
              applyOp(baseSnapshot, sheetId, committedOp, conflict.cleanPatch)
            }
            return
          }
          applyOp(baseSnapshot, sheetId, committedOp)
        })
      }

      // 3) 为重放准备正式记录号（新增类操作的客户端临时号在提交时定稿）
      const prepared = prepareOps(ops)

      // 4) 在"基快照 + 对方新提交"的状态上逐操作判字段级冲突
      const outcome = detectConflicts(baseSnapshot, sheetId, prepared)
      const conflictByIndex = new Map(outcome.conflicts.map((item) => [item.opIndex, item]))

      const conflictRows: PendingConflict[] = []
      for (const item of outcome.conflicts) {
        conflictRows.push({
          id: createId('conflict'),
          sheetId,
          commitId: `__pending__${commitSeq}`,
          commitSeq,
          opIndex: item.opIndex,
          opType: prepared[item.opIndex].type,
          label: prepared[item.opIndex].label,
          tabLabel: input.tabLabel,
          createdAt: new Date().toISOString(),
          status: '待核',
          fields: item.fields,
          cleanPatch: item.cleanPatch,
        })
      }

      // 5) 干净步骤落地主档（冲突字段已从补丁剔除，整步冲突则跳过主档写入）
      for (const [opIndex, op] of prepared.entries()) {
        const conflict = conflictByIndex.get(opIndex)
        if (conflict && !conflict.cleanPatch) {
          continue
        }
        applyOp(baseSnapshot, sheetId, op, conflict?.cleanPatch ?? undefined)
        await persistOp(sheetId, op)
      }

      if (input.failBeforeCommit) {
        throw new Error('故障演练：提交点落盘前中断，事务应整体回滚')
      }

      // 6) 提交记录（双方步骤都原样保留，冲突步骤标下标）
      const now = new Date().toISOString()
      const commit: CommitRecord = {
        id: createId('commit'),
        sheetId,
        seq: commitSeq,
        baseSeq,
        ops: plain(prepared),
        tabId: input.tabId,
        tabLabel: input.tabLabel,
        message: input.message,
        createdAt: now,
        conflictIndexes: outcome.conflicts.map((item) => item.opIndex),
      }
      for (const row of conflictRows) {
        row.commitId = commit.id
      }

      // 7) 推进该图幅的上一提交点快照（重放合并后的状态即新提交点）
      const slice = sliceOf(baseSnapshot, sheetId)
      const nextBaseline: SheetBaseline = {
        sheetId,
        seq: commitSeq,
        sheet: slice.sheet,
        scans: slice.scans,
        placePairs: slice.placePairs,
        histories: slice.histories,
        capturedAt: now,
      }

      await db.commits.add(plain(commit))
      if (conflictRows.length) {
        await db.pendingConflicts.bulkAdd(plain(conflictRows))
      }
      await db.baselines.put(plain(nextBaseline))
      // 已提交的工作区步骤随事务清除
      if (ownWorkspace) {
        await db.workspaces.delete(ownWorkspace.id)
      }

      return { commit, conflicts: conflictRows, headSeq: commitSeq }
    },
  )
}

/** 新建图幅：建卡与首个提交点在同一事务内落盘，避免半成品主档。 */
export async function createSheetWithCommit(input: {
  sheet: Sheet
  tabId: string
  tabLabel: string
}): Promise<CommitResult> {
  const { sheet } = input
  const op: CommitOp = {
    type: 'sheet.create',
    recordId: sheet.id,
    payload: plain(sheet) as unknown as Record<string, unknown>,
    label: `新建图幅《${sheet.title}》`,
  }
  return db.transaction(
    'rw',
    [db.sheets, db.scans, db.placePairs, db.histories, db.commits, db.baselines, db.pendingConflicts],
    async () => {
      const now = new Date().toISOString()
      const commit: CommitRecord = {
        id: createId('commit'),
        sheetId: sheet.id,
        seq: 1,
        baseSeq: 0,
        ops: [plain(op)],
        tabId: input.tabId,
        tabLabel: input.tabLabel,
        message: '新建图幅卡',
        createdAt: now,
        conflictIndexes: [],
      }
      const baseline: SheetBaseline = {
        sheetId: sheet.id,
        seq: 1,
        sheet: plain(sheet),
        scans: [],
        placePairs: [],
        histories: [],
        capturedAt: now,
      }
      await db.sheets.add(plain(sheet))
      await db.commits.add(plain(commit))
      await db.baselines.add(plain(baseline))
      return { commit, conflicts: [], headSeq: 1 }
    },
  )
}

/** 新增类操作里携带的客户端临时号在提交时转成正式号。 */
function prepareOps(ops: CommitOp[]): CommitOp[] {
  return ops.map((op) => {
    if (op.type === 'scan.setPrimary') {
      return op
    }
    if (op.type === 'sheet.patch' || op.type === 'sheet.create') {
      return op
    }
    const payload = { ...(op.payload ?? {}) }
    if (!payload.id) {
      payload.id = createId(op.type === 'scan.add' ? 'scan' : op.type === 'place.add' ? 'place' : 'history')
    }
    return { ...op, recordId: String(payload.id), payload }
  })
}

async function persistOp(sheetId: string, op: CommitOp): Promise<void> {
  switch (op.type) {
    case 'sheet.create':
      await db.sheets.put(plain(op.payload as unknown as Sheet))
      break
    case 'sheet.patch': {
      const patch = (op.payload ?? {}) as Partial<Sheet>
      await db.sheets.update(sheetId, plain(patch))
      break
    }
    case 'scan.add': {
      const scan = op.payload as unknown as ScanItem
      if (scan.isPrimary) {
        await db.scans.where('sheetId').equals(sheetId).modify({ isPrimary: false })
      }
      await db.scans.put(plain(scan))
      break
    }
    case 'scan.setPrimary': {
      const targetId = op.recordId
      await db.scans.where('sheetId').equals(sheetId).modify({ isPrimary: false })
      if (targetId) {
        await db.scans.update(targetId, { isPrimary: true })
      }
      break
    }
    case 'place.add':
      await db.placePairs.put(plain(op.payload as unknown as PlacePair))
      break
    case 'history.add':
      await db.histories.put(plain(op.payload as unknown as NameHistory))
      break
  }
}

export interface ResolveConflictInput {
  conflictId: string
  /** 采纳：写入待核值；舍弃：维持当前主档 */
  resolution: '采纳' | '舍弃'
  tabId: string
  tabLabel: string
}

/**
 * 待核处置：采纳或舍弃同样作为一笔按图幅提交。
 * 处置后从上一提交点重新物化主档并整体校准（修复），
 * 保证互相依赖的改动最终一致，主档不出现半落状态。
 */
export async function resolveConflict(input: ResolveConflictInput): Promise<CommitResult> {
  return db.transaction(
    'rw',
    [db.sheets, db.scans, db.placePairs, db.histories, db.commits, db.baselines, db.pendingConflicts],
    async () => {
      const conflict = await db.pendingConflicts.get(input.conflictId)
      if (!conflict || conflict.status !== '待核') {
        throw new Error('待核记录不存在或已处置')
      }
      const sheetId = conflict.sheetId

      // 1) 标记处置（在重算前先改状态，materialize 即会放开该操作）
      conflict.status = input.resolution === '采纳' ? '已采纳' : '已舍弃'
      conflict.resolvedAt = new Date().toISOString()
      await db.pendingConflicts.put(plain(conflict))

      // 2) 采纳：把待核值合并进对应已提交操作，使其成为正常历史步骤
      if (input.resolution === '采纳') {
        const commit = await db.commits.get(conflict.commitId)
        const op = commit?.ops[conflict.opIndex]
        if (commit && op?.type === 'sheet.patch') {
          for (const field of conflict.fields) {
            if (op.payload) {
              op.payload[field.key] = field.ours
            }
            // 采纳后基线值不再视为冲突：把 beforePatch 对齐为当时对方已提交值
            if (op.beforePatch) {
              op.beforePatch[field.key] = field.theirs
            }
          }
          commit.conflictIndexes = commit.conflictIndexes.filter((index) => index !== conflict.opIndex)
          await db.commits.put(plain(commit))
        }
      }

      // 3) 从上一提交点重算并整体校准该图幅主档
      const { slice } = await materialize(sheetId)
      await reconcileMaster(sheetId, slice)

      const headBaseline = await db.baselines.get(sheetId)
      const commitSeq = (headBaseline?.seq ?? 0) + 1
      const now = new Date().toISOString()
      const resolutionCommit: CommitRecord = {
        id: createId('commit'),
        sheetId,
        seq: commitSeq,
        baseSeq: commitSeq - 1,
        ops: [],
        tabId: input.tabId,
        tabLabel: input.tabLabel,
        message: `${input.resolution}待核：${conflict.label}`,
        createdAt: now,
        conflictIndexes: [],
      }
      const nextBaseline: SheetBaseline = {
        sheetId,
        seq: commitSeq,
        sheet: slice.sheet,
        scans: slice.scans,
        placePairs: slice.placePairs,
        histories: slice.histories,
        capturedAt: now,
      }
      await db.commits.add(plain(resolutionCommit))
      await db.baselines.put(plain(nextBaseline))

      return { commit: resolutionCommit, conflicts: [], headSeq: commitSeq }
    },
  )
}

/**
 * 从上一提交点修复：按提交记录与待核现状重新物化主档，
 * 清除任何未落完整或多余的主档行。写入失败后的恢复入口。
 */
export async function repairSheet(sheetId: string): Promise<SheetSlice> {
  return db.transaction(
    'rw',
    [db.sheets, db.scans, db.placePairs, db.histories, db.commits, db.baselines, db.pendingConflicts],
    async () => {
      const { slice } = await materialize(sheetId)
      await reconcileMaster(sheetId, slice)
      return slice
    },
  )
}

/** 用重算出的权威集合整体替换该图幅主档，多余行删除、缺失行补回。 */
async function reconcileMaster(sheetId: string, slice: SheetSlice): Promise<void> {
  // 图幅卡
  if (slice.sheet) {
    await db.sheets.put(plain(slice.sheet))
  } else {
    await db.sheets.delete(sheetId)
  }

  await reconcileTable<ScanItem>(db.scans, slice.scans, (scan) => scan.sheetId === sheetId)
  await reconcileTable<PlacePair>(db.placePairs, slice.placePairs, (pair) => pair.sheetId === sheetId)

  // 沿革按所属地名对照间接归图幅
  const pairIds = new Set(slice.placePairs.map((item) => item.id))
  const allHistories = await db.histories.toArray()
  const staleHistories = allHistories
    .filter((history) => pairIds.has(history.placePairId) && !slice.histories.some((item) => item.id === history.id))
    .map((history) => history.id)
  if (staleHistories.length) {
    await db.histories.bulkDelete(staleHistories)
  }
  await db.histories.bulkPut(plain(slice.histories))
}

/** 按归属谓词整体校准一张对象仓库：删除应消失的行、写入权威行。 */
async function reconcileTable<T extends { id: string }>(
  table: Dexie.Table<T, string>,
  expected: T[],
  belongs: (row: T) => boolean,
): Promise<void> {
  const existing = await table.toCollection().filter(belongs).toArray()
  const expectedIds = new Set(expected.map((item) => item.id))
  const staleIds = existing.filter((item) => !expectedIds.has(item.id)).map((item) => item.id)
  if (staleIds.length) {
    await table.bulkDelete(staleIds)
  }
  await table.bulkPut(plain(expected))
}
