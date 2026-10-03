import type { CommitOp, UpsertOpInput } from '../types/commit'
import type { NameHistory } from '../types/history'
import type { PlacePair } from '../types/placePair'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'
import { createId } from './db'

/** 主档行版本缺省视为首个提交点版本，供升级前残留数据兜底。 */
export function rowRevOf(entity: { rowRev?: number }): number {
  return entity.rowRev ?? 1
}

export function sheetUpsertOp(input: UpsertOpInput<Sheet>): CommitOp {
  return {
    kind: 'sheetUpsert',
    clientId: createId('op'),
    baseRowRev: input.baseRowRev,
    ...(input.force ? { force: true } : {}),
    entity: input.entity,
  }
}

export function scanUpsertOp(input: UpsertOpInput<ScanItem>, groupId?: string): CommitOp {
  return {
    kind: 'scanUpsert',
    clientId: createId('op'),
    baseRowRev: input.baseRowRev,
    ...(input.force ? { force: true } : {}),
    ...(groupId ? { groupId } : {}),
    entity: input.entity,
  }
}

export function pairUpsertOp(input: UpsertOpInput<PlacePair>): CommitOp {
  return {
    kind: 'pairUpsert',
    clientId: createId('op'),
    baseRowRev: input.baseRowRev,
    ...(input.force ? { force: true } : {}),
    entity: input.entity,
  }
}

export function historyUpsertOp(input: UpsertOpInput<NameHistory>): CommitOp {
  return {
    kind: 'historyUpsert',
    clientId: createId('op'),
    baseRowRev: input.baseRowRev,
    ...(input.force ? { force: true } : {}),
    entity: input.entity,
  }
}
