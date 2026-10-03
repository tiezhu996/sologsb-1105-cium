import type { NameHistory } from './history'
import type { PlacePair } from './placePair'
import type { ScanItem } from './scan'
import type { Sheet } from './sheet'

/**
 * 按图幅提交的操作类型。
 *
 * 整理者在同一图幅上的每一类改动都落成一条可重放的操作：
 * - sheet.create / sheet.patch：建卡与改图幅、四至
 * - scan.add / scan.setPrimary：补扫描件、切换主用件
 * - place.add：补图内地名对照
 * - history.add：补地名沿革
 */
export type CommitOpType =
  | 'sheet.create'
  | 'sheet.patch'
  | 'scan.add'
  | 'scan.setPrimary'
  | 'place.add'
  | 'history.add'

/**
 * 单步操作。beforePatch 只用于图幅字段级冲突判定：
 * 记录本步暂存时该字段的上一提交点取值，重放时若主档已变成别的值，
 * 说明另一个页签也动了同一字段，这一步的该字段转入待核。
 */
export interface CommitOp {
  type: CommitOpType
  /** 本步产生或指向的记录主键（scan/place/history 的客户端临时号在提交时转正式号） */
  recordId?: string
  /** sheet.patch：字段改动；其余操作：完整新增记录 */
  payload?: Record<string, unknown>
  /** sheet.patch：暂存时各字段在上一提交点的取值 */
  beforePatch?: Record<string, unknown>
  /** 人类可读的步骤说明，用于提交记录与待核界面展示 */
  label: string
}

/** 已提交的操作记录，按图幅归集、seq 自增。 */
export interface CommitRecord {
  id: string
  sheetId: string
  /** 该图幅上的提交序号，0 为旧数据升级产生的基线提交 */
  seq: number
  /** 本提交暂存步骤所基于的上一提交点序号 */
  baseSeq: number
  ops: CommitOp[]
  tabId: string
  tabLabel: string
  message: string
  createdAt: string
  /** 重放后被转入待核的操作下标；全部干净时为空 */
  conflictIndexes: number[]
}

/**
 * 图幅基线：记录某一提交点主档的完整快照。
 * 旧数据升级后，以现有全部记录作为 seq=0 的首个提交点；
 * 冲突重放时以此为权威上一提交点，主档始终可以据此恢复。
 */
export interface SheetBaseline {
  sheetId: string
  seq: number
  sheet: Sheet | null
  scans: ScanItem[]
  placePairs: PlacePair[]
  histories: NameHistory[]
  capturedAt: string
}

/** 待核状态 */
export type PendingStatus = '待核' | '已采纳' | '已舍弃'

/**
 * 重放冲突后进入待核的内容。
 * 主档停在上一提交点：冲突字段不写入主档，原操作步骤仍完整保留在提交记录中。
 */
export interface PendingConflict {
  id: string
  sheetId: string
  /** 产生该待核的提交与操作位置 */
  commitId: string
  commitSeq: number
  opIndex: number
  opType: CommitOpType
  label: string
  tabLabel: string
  createdAt: string
  status: PendingStatus
  resolvedAt?: string
  /** 冲突字段：键为字段名，base 为本页签暂存时的基线值，theirs 为另一页签已提交值，ours 为本页签想写入的值 */
  fields: Array<{
    key: string
    label: string
    base: unknown
    theirs: unknown
    ours: unknown
  }>
  /** 同一步中无冲突、已随提交落地的字段补丁；从基线恢复重放时据此跳过待核字段 */
  cleanPatch?: Record<string, unknown> | null
}

/**
 * 页签工作区：暂存该页签对某图幅尚未提交的步骤。
 * 工作区按 [tabId, sheetId] 持久化，重开页签（同一浏览器标签会话）即可接着处理。
 */
export interface Workspace {
  id: string
  tabId: string
  tabLabel: string
  sheetId: string
  /** 暂存步骤所基于的提交序号 */
  baseSeq: number
  /** 暂存开始时该图幅主档的完整基快照，用于并发提交时重放对方步骤与按基值判冲突 */
  baseSlice: SheetSlice | null
  ops: CommitOp[]
  updatedAt: string
}

export interface CommitResult {
  commit: CommitRecord
  conflicts: PendingConflict[]
  /** 提交后该图幅的最新序号 */
  headSeq: number
}

/** 主档四仓在内存中的聚合快照，用于冲突重放 */
export interface MasterSnapshot {
  sheets: Map<string, Sheet>
  scans: Map<string, ScanItem>
  placePairs: Map<string, PlacePair>
  histories: Map<string, NameHistory>
}

/** 图幅相关记录的基线集合（恢复与修复用） */
export interface SheetSlice {
  sheet: Sheet | null
  scans: ScanItem[]
  placePairs: PlacePair[]
  histories: NameHistory[]
}
