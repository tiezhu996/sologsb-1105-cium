import type { CommitOp, CommitOpType } from '../types/commit'
import { fieldLabel } from './journal'

/** 生成暂存/提交步骤的可读说明。 */
export function describeOp(op: { type: CommitOpType; payload?: unknown }): string {
  const payload = (op.payload ?? {}) as Record<string, unknown>
  switch (op.type) {
    case 'sheet.create':
      return `新建图幅《${String(payload.title ?? '')}》`
    case 'sheet.patch': {
      const keys = Object.keys(payload)
      return `修改图幅${keys.map((key) => fieldLabel(key)).join('、') || '字段'}`
    }
    case 'scan.add':
      return `补扫描件 ${String(payload.fileName ?? '')}`
    case 'scan.setPrimary':
      return `切换主用件`
    case 'place.add':
      return `补地名对照 ${String(payload.oldName ?? '')} → ${String(payload.newName ?? '')}`
    case 'history.add':
      return `补沿革 ${String(payload.period ?? '')}·${String(payload.name ?? '')}`
  }
}

/** 从 before/after 两张图幅卡生成字段补丁及暂存基线。 */
export function buildSheetPatch(before: Record<string, unknown>, after: Record<string, unknown>): {
  patch: Record<string, unknown>
  beforePatch: Record<string, unknown>
  changedKeys: string[]
} {
  const editableKeys = [
    'code',
    'title',
    'year',
    'scale',
    'projection',
    'sheetSizeCm',
    'series',
    'neighborCodes',
    'status',
  ]
  const patch: Record<string, unknown> = {}
  const beforePatch: Record<string, unknown> = {}
  for (const key of editableKeys) {
    const left = before[key]
    const right = after[key]
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      patch[key] = right
      beforePatch[key] = left
    }
  }
  return { patch, beforePatch, changedKeys: Object.keys(patch) }
}

export const OP_TYPE_LABELS: Record<CommitOpType, string> = {
  'sheet.create': '新建图幅',
  'sheet.patch': '图幅改动',
  'scan.add': '扫描件',
  'scan.setPrimary': '主用件',
  'place.add': '地名对照',
  'history.add': '地名沿革',
}
