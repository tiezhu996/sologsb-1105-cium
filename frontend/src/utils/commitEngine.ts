import type { NameHistory } from '../types/history'
import type { PlacePair } from '../types/placePair'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'
import type { CommitOp, CommitRecord, ConflictReason, ConflictRecord } from '../types/commit'
import { BASELINE_ROW_REV, createId, db, plain } from './db'

type AnyEntity = Sheet | ScanItem | PlacePair | NameHistory

interface ReplayTable {
  get(key: string): Promise<AnyEntity | undefined>
  put(entity: AnyEntity): Promise<unknown>
}

function tableFor(kind: CommitOp['kind']): ReplayTable {
  switch (kind) {
    case 'sheetUpsert':
      return db.sheets as unknown as ReplayTable
    case 'scanUpsert':
      return db.scans as unknown as ReplayTable
    case 'pairUpsert':
      return db.placePairs as unknown as ReplayTable
    case 'historyUpsert':
      return db.histories as unknown as ReplayTable
  }
}

function entityId(op: CommitOp): string {
  return String((op.entity as { id?: string }).id ?? '')
}

/**
 * 基于上一提交点对单个操作做行版本校验。
 * force（待核“采纳后到改动”）只跳过行版本校验，引用完整性仍然生效。
 */
async function checkOwnConflict(op: CommitOp): Promise<ConflictReason | null> {
  if (op.force) {
    return null
  }
  const table = tableFor(op.kind)
  const current = await table.get(entityId(op))
  if (op.baseRowRev === 0) {
    return current ? 'row-created-elsewhere' : null
  }
  if (!current) {
    return 'row-missing'
  }
  const currentRev = (current as AnyEntity & { rowRev?: number }).rowRev ?? 0
  return currentRev === op.baseRowRev ? null : 'row-changed'
}

/**
 * 在提交事务内把操作按序重放到主档。
 * 干净操作落档并推进该行 rowRev；撞车操作及其同组/下游依赖整条进待核，
 * 不写主档，从而保证互相依赖的改动不会只落一半。
 */
export async function replayCommit(
  commit: CommitRecord,
): Promise<{ appliedOpCount: number; conflicts: ConflictRecord[] }> {
  // 第一遍：找出每个操作自身基于旧提交点造成的冲突。
  const ownFailure = new Map<string, ConflictReason>()
  await Promise.all(
    commit.ops.map(async (op) => {
      const reason = await checkOwnConflict(op)
      if (reason) {
        ownFailure.set(op.clientId, reason)
      }
    }),
  )

  // 同组操作：任意一条撞车，整组挂起（如主用件切换不能只改一半）。
  const groupFailureClient = new Map<string, string>()
  for (const op of commit.ops) {
    if (!op.groupId || !ownFailure.has(op.clientId)) {
      continue
    }
    const prior = groupFailureClient.get(op.groupId)
    if (!prior || ownFailure.has(op.clientId)) {
      groupFailureClient.set(op.groupId, op.clientId)
    }
  }

  const conflicts: ConflictRecord[] = []
  const blocked = new Set<string>()

  function queueConflict(op: CommitOp, reason: ConflictReason, dependentOn?: string): void {
    blocked.add(op.clientId)
    conflicts.push({
      id: createId('conflict'),
      sheetId: commit.sheetId,
      commitId: commit.id,
      commitSeq: commit.seq,
      commitLabel: commit.label,
      tabId: commit.tabId,
      createdAt: commit.createdAt,
      status: 'pending',
      reason,
      ...(dependentOn ? { dependentOn } : {}),
      ops: [plain(op)],
    })
  }

  // 本提交内已经落档的实体，用于同提交内引用判定（如新增地名后紧接着的沿革）。
  const appliedPairIds = new Set<string>()
  const blockedPairOpsByPairId = new Map<string, string>()
  let appliedOpCount = 0

  // 第二遍：按序重放，依赖在上游落档后才允许写入。
  for (const op of commit.ops) {
    const ownReason = ownFailure.get(op.clientId)
    if (ownReason) {
      queueConflict(op, ownReason)
      if (op.kind === 'pairUpsert') {
        blockedPairOpsByPairId.set(entityId(op), op.clientId)
      }
      continue
    }

    if (op.groupId && groupFailureClient.has(op.groupId)) {
      queueConflict(op, 'dependency', groupFailureClient.get(op.groupId))
      continue
    }

    if (op.kind === 'historyUpsert') {
      const history = op.entity as NameHistory
      const upstreamBlocked = blockedPairOpsByPairId.get(history.placePairId)
      const pairExists =
        appliedPairIds.has(history.placePairId) || !!(await db.placePairs.get(history.placePairId))
      if (upstreamBlocked) {
        queueConflict(op, 'dependency', upstreamBlocked)
        continue
      }
      if (!pairExists) {
        // force 也不能越过引用完整性，避免落出没有地名归属的沿革孤记录。
        queueConflict(op, 'referential-missing')
        continue
      }
    }

    const table = tableFor(op.kind)
    const current = await table.get(entityId(op))
    const currentRev = (current as (AnyEntity & { rowRev?: number }) | undefined)?.rowRev ?? 0
    const nextRowRev = op.baseRowRev === 0 && !op.force ? 1 : currentRev + 1
    const stamped = { ...plain(op.entity), rowRev: Math.max(nextRowRev, BASELINE_ROW_REV) }
    await table.put(stamped as AnyEntity)
    appliedOpCount += 1
    if (op.kind === 'pairUpsert') {
      appliedPairIds.add(entityId(op))
    }
  }

  return { appliedOpCount, conflicts }
}
