import type { NameHistory } from '../types/history'
import type { PlacePair } from '../types/placePair'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'
import type {
  CommitOp,
  MasterSnapshot,
  PendingConflict,
  SheetBaseline,
  SheetSlice,
} from '../types/commit'

/** 图幅字段的中文名，供待核界面展示。 */
export const SHEET_FIELD_LABELS: Record<string, string> = {
  code: '图幅号',
  title: '图幅题名',
  year: '测绘年代',
  scale: '比例尺',
  projection: '投影方式',
  sheetSizeCm: '图幅尺寸',
  series: '所属图组',
  neighborCodes: '四至邻接',
  status: '整理状态',
}

export function fieldLabel(key: string): string {
  return SHEET_FIELD_LABELS[key] ?? key
}

/** 从基线集合构造内存聚合快照。 */
export function createSnapshot(baselines: SheetBaseline[]): MasterSnapshot {
  const snapshot: MasterSnapshot = {
    sheets: new Map(),
    scans: new Map(),
    placePairs: new Map(),
    histories: new Map(),
  }
  for (const baseline of baselines) {
    if (baseline.sheet) {
      snapshot.sheets.set(baseline.sheet.id, structuredCloneSafe(baseline.sheet))
    }
    baseline.scans.forEach((scan) => snapshot.scans.set(scan.id, structuredCloneSafe(scan)))
    baseline.placePairs.forEach((pair) => snapshot.placePairs.set(pair.id, structuredCloneSafe(pair)))
    baseline.histories.forEach((history) =>
      snapshot.histories.set(history.id, structuredCloneSafe(history)),
    )
  }
  return snapshot
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 取某图幅相关记录的当前物化状态。 */
export function sliceOf(snapshot: MasterSnapshot, sheetId: string): SheetSlice {
  const sheet = snapshot.sheets.get(sheetId) ?? null
  return {
    sheet: sheet ? structuredCloneSafe(sheet) : null,
    scans: [...snapshot.scans.values()].filter((scan) => scan.sheetId === sheetId).map(structuredCloneSafe),
    placePairs: [...snapshot.placePairs.values()]
      .filter((pair) => pair.sheetId === sheetId)
      .map(structuredCloneSafe),
    histories: [...snapshot.histories.values()]
      .filter((history) => {
        const pair = snapshot.placePairs.get(history.placePairId)
        return pair?.sheetId === sheetId
      })
      .map(structuredCloneSafe),
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export interface ReplayOutcome {
  /** 干净落地的操作下标（含部分字段落地的 sheet.patch） */
  appliedIndexes: number[]
  conflicts: Array<{
    opIndex: number
    fields: PendingConflict['fields']
    /** 剔除冲突字段后仍可写入的补丁；全部字段冲突时为 null，表示整步不落地 */
    cleanPatch: Record<string, unknown> | null
  }>
}

/**
 * 在快照上判定一组操作相对当前主档的字段级冲突。
 *
 * 只有 sheet.patch 会与另一页签产生内容冲突：新增类操作（扫描件、地名、沿革、
 * 主用件切换）彼此独立或天然有序，双方步骤都保留并依次重放。
 */
export function detectConflicts(snapshot: MasterSnapshot, sheetId: string, ops: CommitOp[]): ReplayOutcome {
  const result: ReplayOutcome = { appliedIndexes: [], conflicts: [] }
  // 本批操作自己写入的字段，批内后一步不再按 beforePatch 误判为冲突
  const patchedKeys = new Set<string>()

  ops.forEach((op, opIndex) => {
    if (op.type !== 'sheet.patch') {
      result.appliedIndexes.push(opIndex)
      return
    }

    const current = snapshot.sheets.get(sheetId)
    const patch = (op.payload ?? {}) as unknown as Partial<Sheet>
    const beforePatch = op.beforePatch ?? {}
    const fields: PendingConflict['fields'] = []
    const cleanPatch: Record<string, unknown> = {}

    for (const [key, ours] of Object.entries(patch as Record<string, unknown>)) {
      const theirs = current ? (current as unknown as Record<string, unknown>)[key] : undefined
      const base = beforePatch[key]
      const touchedByOther =
        !patchedKeys.has(key) && !valuesEqual(theirs, base) && !valuesEqual(theirs, ours)
      if (touchedByOther) {
        fields.push({ key, label: fieldLabel(key), base, theirs, ours })
      } else {
        cleanPatch[key] = ours
      }
      patchedKeys.add(key)
    }

    if (fields.length) {
      result.conflicts.push({
        opIndex,
        fields,
        cleanPatch: Object.keys(cleanPatch).length ? cleanPatch : null,
      })
    }
    // 即便有字段转待核，其余字段仍随本提交落地（不把互不依赖的改动也拖入待核）
    result.appliedIndexes.push(opIndex)
  })

  return result
}

/** 把一条操作应用到内存快照（重放）。patchOnly 用于只落地无冲突字段。 */
export function applyOp(
  snapshot: MasterSnapshot,
  sheetId: string,
  op: CommitOp,
  patchOnly?: Record<string, unknown>,
): void {
  switch (op.type) {
    case 'sheet.create': {
      const sheet = (op.payload ?? {}) as unknown as Sheet
      snapshot.sheets.set(sheet.id, structuredCloneSafe(sheet))
      break
    }
    case 'sheet.patch': {
      const current = snapshot.sheets.get(sheetId)
      if (!current) {
        return
      }
      const patch = (patchOnly ?? op.payload ?? {}) as unknown as Partial<Sheet>
      snapshot.sheets.set(sheetId, { ...structuredCloneSafe(current), ...structuredCloneSafe(patch) })
      break
    }
    case 'scan.add': {
      const scan = (op.payload ?? {}) as unknown as ScanItem
      if (scan.isPrimary) {
        for (const existing of snapshot.scans.values()) {
          if (existing.sheetId === sheetId) {
            existing.isPrimary = false
          }
        }
      }
      snapshot.scans.set(scan.id, structuredCloneSafe(scan))
      break
    }
    case 'scan.setPrimary': {
      const targetId = op.recordId
      for (const scan of snapshot.scans.values()) {
        if (scan.sheetId === sheetId) {
          scan.isPrimary = scan.id === targetId
        }
      }
      break
    }
    case 'place.add': {
      const pair = (op.payload ?? {}) as unknown as PlacePair
      snapshot.placePairs.set(pair.id, structuredCloneSafe(pair))
      break
    }
    case 'history.add': {
      const history = (op.payload ?? {}) as unknown as NameHistory
      snapshot.histories.set(history.id, structuredCloneSafe(history))
      break
    }
  }
}
