import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { NameHistory } from '../types/history'
import type { PlacePair } from '../types/placePair'
import type { ScanItem } from '../types/scan'
import type { CommitOp, CommitRecord, PendingConflict, Workspace } from '../types/commit'
import { createId, db, plain } from '../utils/db'
import { describeOp } from '../utils/ops'
import {
  getHeadSeq,
  readMasterSlice,
  repairSheet,
  resolveConflict,
  submitWorkspace,
} from '../utils/commitService'
import { commitBus } from '../utils/bus'

const TAB_ID_KEY = 'gboldmap-tab-id'
const TAB_LABEL_KEY = 'gboldmap-tab-label'

/** 当前浏览器标签会话的稳定标识：重开本页签（刷新）仍能取回暂存步骤。 */
function currentTabId(): string {
  const existing = sessionStorage.getItem(TAB_ID_KEY)
  if (existing) {
    return existing
  }
  const id = createId('tab')
  sessionStorage.setItem(TAB_ID_KEY, id)
  return id
}

function currentTabLabel(): string {
  const existing = sessionStorage.getItem(TAB_LABEL_KEY)
  if (existing) {
    return existing
  }
  // 用时间给页签一个可辨认的名字
  const label = `页签 ${new Date().toLocaleString('zh-CN', { hour12: false })}`
  sessionStorage.setItem(TAB_LABEL_KEY, label)
  return label
}

export interface StageResult {
  workspace: Workspace
  conflictWithCommitted: boolean
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const tabId = currentTabId()
  const tabLabel = currentTabLabel()

  const workspaces = ref<Workspace[]>([])
  const conflicts = ref<PendingConflict[]>([])
  const commitsBySheet = ref<Record<string, CommitRecord[]>>({})
  /** 各图幅主档当前序号，用于提示本页签暂存基线是否落后 */
  const headSeqBySheet = ref<Record<string, number>>({})
  const initialized = ref(false)
  let initialization: Promise<void> | null = null

  const myWorkspaces = computed(() => workspaces.value.filter((ws) => ws.tabId === tabId))
  const otherWorkspaces = computed(() => workspaces.value.filter((ws) => ws.tabId !== tabId))
  const pendingConflicts = computed(() => conflicts.value.filter((conflict) => conflict.status === '待核'))

  const myPendingCount = computed(() => myWorkspaces.value.reduce((sum, ws) => sum + ws.ops.length, 0))
  const pendingCountBySheet = computed<Record<string, number>>(() => {
    const counter: Record<string, number> = {}
    for (const ws of myWorkspaces.value) {
      counter[ws.sheetId] = (counter[ws.sheetId] ?? 0) + ws.ops.length
    }
    return counter
  })

  function workspaceFor(sheetId: string): Workspace | undefined {
    return workspaces.value.find((ws) => ws.tabId === tabId && ws.sheetId === sheetId)
  }

  function opsFor(sheetId: string): CommitOp[] {
    return workspaceFor(sheetId)?.ops ?? []
  }

  /** 暂存基线是否已被其它页签的提交推进（需要重放合并） */
  function isStale(sheetId: string): boolean {
    const ws = workspaceFor(sheetId)
    if (!ws) {
      return false
    }
    return (headSeqBySheet.value[sheetId] ?? ws.baseSeq) > ws.baseSeq
  }

  async function init(): Promise<void> {
    if (initialized.value) {
      return
    }
    if (!initialization) {
      initialization = reloadAll()
    }
    await initialization
  }

  async function reloadAll(): Promise<void> {
    const [wsRows, conflictRows, baselineRows, commitRows] = await Promise.all([
      db.workspaces.toArray(),
      db.pendingConflicts.toArray(),
      db.baselines.toArray(),
      db.commits.toArray(),
    ])
    workspaces.value = wsRows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    conflicts.value = conflictRows.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    headSeqBySheet.value = Object.fromEntries(baselineRows.map((baseline) => [baseline.sheetId, baseline.seq]))
    const commits: Record<string, CommitRecord[]> = {}
    for (const commit of commitRows.sort((left, right) => right.seq - left.seq)) {
      ;(commits[commit.sheetId] ??= []).push(commit)
    }
    commitsBySheet.value = commits
    initialized.value = true
  }

  async function commitsForSheet(sheetId: string): Promise<CommitRecord[]> {
    if (!commitsBySheet.value[sheetId]) {
      await reloadAll()
    }
    return commitsBySheet.value[sheetId] ?? []
  }

  /** 暂存一步（或对同一记录的连续改动合并）。 */
  async function stageOp(sheetId: string, op: CommitOp, mergeKey?: string): Promise<Workspace> {
    await init()
    const now = new Date().toISOString()
    const existing = await db.workspaces
      .where('tabId')
      .equals(tabId)
      .and((ws: Workspace) => ws.sheetId === sheetId)
      .first()

    let workspace: Workspace
    if (existing) {
      const ops = [...existing.ops]
      if (mergeKey) {
        const mergeIndex = ops.findIndex((item) => item.type === op.type && item.recordId === mergeKey)
        if (mergeIndex >= 0) {
          const previous = ops[mergeIndex]
          if (previous.type === 'sheet.patch' && op.type === 'sheet.patch') {
            ops[mergeIndex] = mergePatchOps(previous, op)
          } else {
            ops[mergeIndex] = op
          }
        } else {
          ops.push(op)
        }
      } else {
        ops.push(op)
      }
      workspace = { ...existing, ops, updatedAt: now }
    } else {
      const baseSeq = headSeqBySheet.value[sheetId] ?? (await getHeadSeq(sheetId))
      workspace = {
        id: createId('workspace'),
        tabId,
        tabLabel,
        sheetId,
        baseSeq,
        baseSlice: await readMasterSlice(sheetId),
        ops: [op],
        updatedAt: now,
      }
    }
    await db.workspaces.put(plain(workspace))
    await reloadAll()
    return workspace
  }

  async function stageScan(sheetId: string, scan: Omit<ScanItem, 'id'>): Promise<void> {
    const id = createId('scan-draft')
    await stageOp(sheetId, {
      type: 'scan.add',
      recordId: id,
      payload: plain({ ...scan, id }) as unknown as Record<string, unknown>,
      label: describeOp({ type: 'scan.add', payload: { fileName: scan.fileName } }),
    })
  }

  async function stageSetPrimary(sheetId: string, scanId: string, fileName: string): Promise<void> {
    await stageOp(sheetId, {
      type: 'scan.setPrimary',
      recordId: scanId,
      label: `切换主用件：${fileName}`,
    })
  }

  async function stagePlace(pair: PlacePair): Promise<void> {
    await stageOp(pair.sheetId, {
      type: 'place.add',
      recordId: pair.id,
      payload: plain(pair) as unknown as Record<string, unknown>,
      label: describeOp({ type: 'place.add', payload: pair }),
    })
  }

  async function stageHistory(sheetId: string, history: NameHistory): Promise<void> {
    await stageOp(sheetId, {
      type: 'history.add',
      recordId: history.id,
      payload: plain(history) as unknown as Record<string, unknown>,
      label: describeOp({ type: 'history.add', payload: history }),
    })
  }

  async function stageSheetPatch(
    sheetId: string,
    patch: Record<string, unknown>,
    beforePatch: Record<string, unknown>,
  ): Promise<void> {
    if (Object.keys(patch).length === 0) {
      return
    }
    const fieldNames = Object.keys(patch)
      .map((key) => ({ code: '图幅号', title: '题名', year: '年代', scale: '比例尺', projection: '投影', sheetSizeCm: '尺寸', series: '图组', neighborCodes: '四至', status: '状态' } as Record<string, string>)[key] ?? key)
      .join('、')
    await stageOp(
      sheetId,
      {
        type: 'sheet.patch',
        payload: patch,
        beforePatch,
        label: `修改图幅${fieldNames}`,
      },
      'sheet',
    )
  }

  async function removeOp(sheetId: string, opIndex: number): Promise<void> {
    const ws = workspaceFor(sheetId)
    if (!ws) {
      return
    }
    const ops = ws.ops.filter((_, index) => index !== opIndex)
    if (ops.length === 0) {
      await db.workspaces.delete(ws.id)
    } else {
      await db.workspaces.put(plain({ ...ws, ops, updatedAt: new Date().toISOString() }))
    }
    await reloadAll()
  }

  async function discardWorkspace(sheetId: string, ownerTabId: string = tabId): Promise<void> {
    const ws = workspaces.value.find((item) => item.tabId === ownerTabId && item.sheetId === sheetId)
    if (ws) {
      await db.workspaces.delete(ws.id)
      await reloadAll()
    }
  }

  /** 接管其它页签遗留的暂存步骤。 */
  async function adoptWorkspace(sheetId: string, ownerTabId: string): Promise<void> {
    const ws = workspaces.value.find((item) => item.tabId === ownerTabId && item.sheetId === sheetId)
    if (!ws) {
      return
    }
    const own = workspaceFor(sheetId)
    if (own) {
      await db.workspaces.put(
        plain({ ...own, ops: [...own.ops, ...ws.ops], updatedAt: new Date().toISOString() }),
      )
      await db.workspaces.delete(ws.id)
    } else {
      await db.workspaces.put(
        plain({
          ...ws,
          id: createId('workspace'),
          tabId,
          tabLabel,
          baseSeq: headSeqBySheet.value[sheetId] ?? ws.baseSeq,
          baseSlice: await readMasterSlice(sheetId),
          updatedAt: new Date().toISOString(),
        }),
      )
    }
    await reloadAll()
  }

  /**
   * 提交本页签在某图幅上暂存的全部步骤。
   * 原子提交：双方步骤保留重放，冲突转待核，失败整体回滚。
   */
  async function commit(sheetId: string, message?: string, failBeforeCommit = false): Promise<{
    committed: boolean
    conflictCount: number
  }> {
    const ws = workspaceFor(sheetId)
    if (!ws || ws.ops.length === 0) {
      return { committed: false, conflictCount: 0 }
    }
    const result = await submitWorkspace({
      sheetId,
      tabId,
      tabLabel,
      message: message?.trim() || `提交 ${ws.ops.length} 个步骤`,
      baseSeq: ws.baseSeq,
      ops: plain(ws.ops),
      failBeforeCommit,
    })
    await reloadAll()
    commitBus.post({ sheetId, commitSeq: result.headSeq, fromTabId: tabId })
    return { committed: true, conflictCount: result.conflicts.length }
  }

  async function resolve(conflictId: string, resolution: '采纳' | '舍弃'): Promise<void> {
    const result = await resolveConflict({ conflictId, resolution, tabId, tabLabel })
    await reloadAll()
    commitBus.post({ sheetId: result.commit.sheetId, commitSeq: result.headSeq, fromTabId: tabId })
  }

  /** 从上一提交点修复主档（写入失败后的恢复入口）。 */
  async function repair(sheetId: string): Promise<void> {
    await repairSheet(sheetId)
    await reloadAll()
    commitBus.post({ sheetId, commitSeq: headSeqBySheet.value[sheetId] ?? 0, fromTabId: tabId })
  }

  async function masterSlice(sheetId: string) {
    return readMasterSlice(sheetId)
  }

  return {
    tabId,
    tabLabel,
    workspaces,
    myWorkspaces,
    otherWorkspaces,
    conflicts,
    pendingConflicts,
    commitsBySheet,
    headSeqBySheet,
    myPendingCount,
    pendingCountBySheet,
    init,
    reloadAll,
    commitsForSheet,
    workspaceFor,
    opsFor,
    isStale,
    stageOp,
    stageScan,
    stageSetPrimary,
    stagePlace,
    stageHistory,
    stageSheetPatch,
    removeOp,
    discardWorkspace,
    adoptWorkspace,
    commit,
    resolve,
    repair,
    masterSlice,
  }
})

/** 同一图幅上连续两次字段修改合并为一步，基线值保留最早一次的。 */
function mergePatchOps(previous: CommitOp, next: CommitOp): CommitOp {
  return {
    ...previous,
    payload: { ...(previous.payload ?? {}), ...(next.payload ?? {}) },
    beforePatch: { ...(previous.beforePatch ?? {}), ...(next.beforePatch ?? {}) },
    label: next.label,
  }
}
