import type { CommitOp } from '../types/commit'
import type { NameHistory } from '../types/history'
import type { PlacePair } from '../types/placePair'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'

const KIND_TEXT: Record<CommitOp['kind'], string> = {
  sheetUpsert: '图幅与四至',
  scanUpsert: '扫描件',
  pairUpsert: '地名对照',
  historyUpsert: '地名沿革',
}

export function opKindText(kind: CommitOp['kind']): string {
  return KIND_TEXT[kind]
}

/** 待核台/提交链上展示一条操作涉及的对象摘要。 */
export function opSubject(op: CommitOp): string {
  switch (op.kind) {
    case 'sheetUpsert': {
      const sheet = op.entity as Sheet
      return `${sheet.code} · ${sheet.title}`
    }
    case 'scanUpsert': {
      const scan = op.entity as ScanItem
      return scan.fileName
    }
    case 'pairUpsert': {
      const pair = op.entity as PlacePair
      return `${pair.oldName} → ${pair.newName}`
    }
    case 'historyUpsert': {
      const history = op.entity as NameHistory
      return `${history.period} · ${history.name}（${history.changeType}）`
    }
  }
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  return date.toLocaleString('zh-CN', { hour12: false })
}
