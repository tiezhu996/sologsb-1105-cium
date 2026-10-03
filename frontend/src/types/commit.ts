import type { NameHistory } from './history'
import type { PlacePair } from './placePair'
import type { ScanItem } from './scan'
import type { Sheet } from './sheet'

/** 操作记录的四种粒度，均为整实体写入（upsert）。 */
export type CommitOpKind = 'sheetUpsert' | 'scanUpsert' | 'pairUpsert' | 'historyUpsert'

export interface CommitOp {
  kind: CommitOpKind
  /** 单次编辑内稳定、重放与待核裁定用的客户端操作标识。 */
  clientId: string
  /** 操作基于的实体行版本：0 表示新建，其余须与主档当前行版本一致，否则进待核。 */
  baseRowRev: number
  /** 待核裁定“采纳后到改动”时跳过行版本校验。 */
  force?: boolean
  /**
   * 同组操作标识（如切换主用件会同时改写目标件与原主用件）。
   * 组内任意一条撞车，整组挂起，避免只落一半。
   */
  groupId?: string
  entity: Sheet | ScanItem | PlacePair | NameHistory
}

export interface UpsertOpInput<T> {
  entity: T
  baseRowRev: number
  force?: boolean
}

export type CommitKind = 'commit' | 'bootstrap'

/**
 * 按图幅提交的操作记录。同一图幅的提交按 seq 连成一条链，
 * rev 为链上位置，等于该图幅的当前提交点。
 */
export interface CommitRecord {
  id: string
  sheetId: string
  seq: number
  rev: number
  kind: CommitKind
  label: string
  note?: string
  ops: CommitOp[]
  /** 本提交内成功重放到主档的操作数；与 ops.length 不等时说明有待核内容。 */
  appliedOpCount: number
  /** 提交者页签标识，用于区分两个页签各自保留下来的步骤。 */
  tabId: string
  /** 提交时该页签所知的上一提交点，用于判断是否并排改同一图幅。 */
  clientBaseRev: number
  createdAt: string
}

export type ConflictReason =
  | 'row-changed'
  | 'row-created-elsewhere'
  | 'row-missing'
  | 'dependency'
  | 'referential-missing'

export type ConflictStatus = 'pending' | 'accepted' | 'dismissed'

/** 重放时未能落到主档的操作，连同上下文冻结进待核台。 */
export interface ConflictRecord {
  id: string
  sheetId: string
  commitId: string
  commitSeq: number
  commitLabel: string
  tabId: string
  createdAt: string
  status: ConflictStatus
  reason: ConflictReason
  /** dependency 时指向同提交内被挂起的上游操作 clientId。 */
  dependentOn?: string
  ops: CommitOp[]
  resolution?: string
  resolvedAt?: string
}

/** 尚未提交的操作草稿，按表单键持久化，重开页签后可接着处理。 */
export interface DraftRecord<T = unknown> {
  key: string
  sheetId: string
  payload: T
  tabId: string
  createdAt: string
  updatedAt: string
}

export interface CommitOutcome {
  ok: boolean
  seq: number
  rev: number
  appliedOpCount: number
  conflicts: ConflictRecord[]
  error?: string
}

export const CONFLICT_REASON_TEXT: Record<ConflictReason, string> = {
  'row-changed': '同一记录已在另一个页签被改动，两边内容不一致',
  'row-created-elsewhere': '该编号的记录已由另一个页签先行建立',
  'row-missing': '目标记录在上一提交点之后已不存在',
  dependency: '依赖的上游记录进入待核，随之一并挂起',
  'referential-missing': '依赖的上游记录不存在，无法单独落档',
}
