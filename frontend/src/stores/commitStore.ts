import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  CommitOp,
  CommitOutcome,
  CommitRecord,
  ConflictRecord,
  DraftRecord,
} from '../types/commit'
import { createId, db, plain } from '../utils/db'
import { replayCommit } from '../utils/commitEngine'

/** 跨页签通知频道：另一个页签落了提交后，提醒本页签对齐新提交点。 */
const SIGNAL_KEY = 'gboldmap-commit-signal'
const TAB_ID_KEY = 'gboldmap-tab-id'

export interface CommitSignal {
  tabId: string
  sheetId: string
  rev: number
  at: string
}

function getTabId(): string {
  // sessionStorage 让同页签刷新后身份不变，新开页签自动成为另一个整理员。
  let tabId = globalThis.sessionStorage?.getItem(TAB_ID_KEY) ?? ''
  if (!tabId) {
    tabId = createId('tab')
    globalThis.sessionStorage?.setItem(TAB_ID_KEY, tabId)
  }
  return tabId
}

type RefreshHook = () => Promise<void> | void

export const useCommitStore = defineStore('commit', () => {
  const tabId = getTabId()

  /** sheetId -> 当前提交点 rev。 */
  const sheetHeads = ref<Record<string, number>>({})
  const conflicts = ref<ConflictRecord[]>([])
  const drafts = ref<DraftRecord[]>([])
  const initialized = ref(false)
  const syncMessage = ref('')

  const refreshHooks = new Set<RefreshHook>()
  let indexing: Promise<void> | null = null

  const pendingConflicts = computed(() =>
    conflicts.value.filter((item) => item.status === 'pending'),
  )
  const resolvedConflicts = computed(() =>
    conflicts.value.filter((item) => item.status !== 'pending'),
  )
  const pendingCount = computed(() => pendingConflicts.value.length)

  function registerRefreshHook(hook: RefreshHook): () => void {
    refreshHooks.add(hook)
    return () => {
      refreshHooks.delete(hook)
    }
  }

  async function reloadIndexes(): Promise<void> {
    const [commitRows, conflictRows, draftRows] = await Promise.all([
      db.commits.toArray(),
      db.conflicts.toArray(),
      db.drafts.toArray(),
    ])
    const heads: Record<string, number> = {}
    for (const commit of commitRows) {
      heads[commit.sheetId] = Math.max(heads[commit.sheetId] ?? 0, commit.seq)
    }
    sheetHeads.value = heads
    conflicts.value = conflictRows.sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt),
    )
    drafts.value = draftRows.sort(
      (left, right) => right.updatedAt.localeCompare(left.updatedAt),
    )
  }

  async function init(): Promise<void> {
    if (initialized.value) {
      return
    }
    if (!indexing) {
      indexing = reloadIndexes().then(() => {
        initialized.value = true
      })
    }
    await indexing
  }

  async function notifyRefreshes(): Promise<void> {
    await Promise.all([...refreshHooks].map((hook) => hook()))
  }

  function emitSignal(sheetId: string, rev: number): void {
    const signal: CommitSignal = { tabId, sheetId, rev, at: new Date().toISOString() }
    // storage 事件只对其他页签触发，本页签不靠它回流。
    globalThis.localStorage?.setItem(SIGNAL_KEY, JSON.stringify(signal))
  }

  function onCrossTabSignal(handler: (signal: CommitSignal) => void): () => void {
    function listener(event: StorageEvent): void {
      if (event.key !== SIGNAL_KEY || !event.newValue) {
        return
      }
      try {
        handler(JSON.parse(event.newValue) as CommitSignal)
      } catch {
        // 信号仅用于提示对齐，解析失败时忽略。
      }
    }
    globalThis.addEventListener?.('storage', listener)
    return () => globalThis.removeEventListener?.('storage', listener)
  }

  function headRev(sheetId: string): number {
    return sheetHeads.value[sheetId] ?? 0
  }

  function commitsForSheet(sheetId: string): Promise<CommitRecord[]> {
    return db.commits.where('sheetId').equals(sheetId).sortBy('seq')
  }

  /**
   * 按图幅提交：同事务内完成“追加操作记录 + 重放到主档 + 写入待核”。
   * 事务任一步失败则整体回滚，主档仍停在上一提交点；随后从磁盘重载恢复。
   */
  async function commit(params: {
    sheetId: string
    label: string
    ops: CommitOp[]
    note?: string
  }): Promise<CommitOutcome> {
    await init()
    const { sheetId, label, ops } = params
    const clientBaseRev = headRev(sheetId)
    const seq = clientBaseRev + 1
    const commitId = createId('commit')
    const nowIso = new Date().toISOString()
    const record: CommitRecord = {
      id: commitId,
      sheetId,
      seq,
      rev: seq,
      kind: 'commit',
      label,
      ...(params.note ? { note: params.note } : {}),
      ops,
      appliedOpCount: 0,
      tabId,
      clientBaseRev,
      createdAt: nowIso,
    }

    let outcome: CommitOutcome
    try {
      const result = await db.transaction('rw', [
        db.commits,
        db.conflicts,
        db.sheets,
        db.scans,
        db.placePairs,
        db.histories,
      ], async () => {
        // 最后一道防线：链上位置以事务内实际读取为准，挡住同时提交的竞态。
        const latest = await db.commits.where('sheetId').equals(sheetId).reverse().sortBy('seq')
        const actualHead = latest[0]?.seq ?? 0
        if (actualHead !== clientBaseRev) {
          throw new Error(`该图幅已在另一页签提交（提交点 ${clientBaseRev} → ${actualHead}），请在新提交点上重试`)
        }
        const replay = await replayCommit(record)
        record.appliedOpCount = replay.appliedOpCount
        await db.commits.add(plain(record))
        if (replay.conflicts.length) {
          await db.conflicts.bulkAdd(replay.conflicts)
        }
        return replay
      })
      outcome = {
        ok: true,
        seq,
        rev: seq,
        appliedOpCount: result.appliedOpCount,
        conflicts: result.conflicts,
      }
    } catch (error) {
      // 写入失败：事务已整体回滚，从磁盘把各仓库恢复到上一提交点。
      await Promise.all([reloadIndexes(), notifyRefreshes()])
      outcome = {
        ok: false,
        seq: clientBaseRev,
        rev: clientBaseRev,
        appliedOpCount: 0,
        conflicts: [],
        error: error instanceof Error ? error.message : String(error),
      }
      return outcome
    }

    await Promise.all([reloadIndexes(), notifyRefreshes()])
    emitSignal(sheetId, seq)
    return outcome
  }

  /** 写入失败后主动从上一提交点恢复（供页面在异常路径调用）。 */
  async function restoreToLastCommit(): Promise<void> {
    await Promise.all([reloadIndexes(), notifyRefreshes()])
  }

  // ---- 待核裁定 ----------------------------------------------------------

  async function acceptConflict(
    conflict: ConflictRecord,
    edit?: (op: CommitOp) => CommitOp,
  ): Promise<CommitOutcome> {
    await init()
    const ops = conflict.ops.map((op) => {
      const next = edit ? edit(plain(op)) : plain(op)
      return { ...next, force: true }
    })
    const outcome = await commit({
      sheetId: conflict.sheetId,
      label: `采纳待核：${conflict.commitLabel}`,
      note: `对提交点 ${conflict.commitSeq} 的待核内容裁定采纳${edit ? '并修订' : ''}。`,
      ops,
    })
    if (outcome.ok) {
      // 依赖型待核在其上游仍挂起时不能直接采纳；保持待核状态。
      const stillPending = outcome.conflicts.some(
        (item) => item.ops[0]?.clientId === conflict.ops[0]?.clientId,
      )
      if (!stillPending) {
        await db.conflicts.update(conflict.id, {
          status: 'accepted',
          resolution: '已采纳为新提交并重放。',
          resolvedAt: new Date().toISOString(),
        })
        await reloadIndexes()
      }
    }
    return outcome
  }

  async function dismissConflict(conflict: ConflictRecord): Promise<void> {
    await init()
    await db.conflicts.update(conflict.id, {
      status: 'dismissed',
      resolution: '维持上一提交点内容，该步骤不重放。',
      resolvedAt: new Date().toISOString(),
    })
    await Promise.all([reloadIndexes(), notifyRefreshes()])
  }

  // ---- 草稿（重开页签接着处理） ------------------------------------------

  async function saveDraft<T>(key: string, sheetId: string, payload: T): Promise<void> {
    await init()
    const nowIso = new Date().toISOString()
    const existing = await db.drafts.get(key)
    const draft: DraftRecord<T> = {
      key,
      sheetId,
      payload: plain(payload),
      tabId,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    }
    await db.drafts.put(plain(draft))
    await reloadIndexes()
  }

  async function loadDraft<T>(key: string): Promise<DraftRecord<T> | undefined> {
    await init()
    return (await db.drafts.get(key)) as DraftRecord<T> | undefined
  }

  async function clearDraft(key: string): Promise<void> {
    await db.drafts.delete(key)
    await reloadIndexes()
  }

  function getDraft<T>(key: string): DraftRecord<T> | undefined {
    return drafts.value.find((draft) => draft.key === key) as DraftRecord<T> | undefined
  }

  return {
    tabId,
    sheetHeads,
    conflicts,
    drafts,
    initialized,
    syncMessage,
    pendingConflicts,
    resolvedConflicts,
    pendingCount,
    init,
    registerRefreshHook,
    reloadIndexes,
    notifyRefreshes,
    onCrossTabSignal,
    headRev,
    commitsForSheet,
    commit,
    restoreToLastCommit,
    acceptConflict,
    dismissConflict,
    saveDraft,
    loadDraft,
    clearDraft,
    getDraft,
  }
})
