import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CommitOutcome } from '../types/commit'
import type { NameHistory } from '../types/history'
import { createId, db } from '../utils/db'
import { historyUpsertOp } from '../utils/ops'
import { sortByPeriod } from '../utils/scale'
import { useCommitStore } from './commitStore'

export type NewNameHistory = Omit<NameHistory, 'id' | 'rowRev'>

export interface HistoryWriteResult {
  outcome: CommitOutcome
  history: NameHistory
  sheetId?: string
}

export const useHistoryStore = defineStore('history', () => {
  const commitStore = useCommitStore()

  const histories = ref<NameHistory[]>([])
  const currentPairId = ref('')
  const initialized = ref(false)
  let initialization: Promise<void> | null = null

  const currentHistories = computed(() =>
    sortByPeriod(
      histories.value.filter((history) => history.placePairId === currentPairId.value),
    ),
  )

  async function reload(): Promise<void> {
    if (!initialized.value) {
      return
    }
    histories.value = await db.histories.toArray()
  }

  async function init(): Promise<void> {
    await commitStore.init()
    commitStore.registerRefreshHook(reload)
    if (initialized.value) {
      return
    }
    if (!initialization) {
      initialization = db.histories.toArray().then((rows) => {
        histories.value = rows
        initialized.value = true
      })
    }
    await initialization
  }

  async function loadFor(placePairId: string): Promise<void> {
    await init()
    currentPairId.value = placePairId
  }

  /**
   * 补沿革：随所属地名的图幅提交。地名卡若在另一页签待核/不存在，
   * 沿革作为下游依赖一并挂起，不会落出孤记录。
   */
  async function addHistory(input: NewNameHistory): Promise<HistoryWriteResult> {
    await init()
    const history: NameHistory = { ...input, id: createId('history') }
    const pair = await db.placePairs.get(history.placePairId)
    if (!pair) {
      const rev = 0
      return {
        outcome: {
          ok: false,
          seq: rev,
          rev,
          appliedOpCount: 0,
          conflicts: [],
          error: '所属地名对照不存在，沿革无法单独提交',
        },
        history,
      }
    }
    const outcome = await commitStore.commit({
      sheetId: pair.sheetId,
      label: '补地名沿革',
      note: `为「${pair.oldName}」补录 ${history.period}「${history.name}」。`,
      ops: [historyUpsertOp({ entity: history, baseRowRev: 0 })],
    })
    if (outcome.ok && outcome.appliedOpCount > 0) {
      histories.value = [...histories.value, history]
    }
    currentPairId.value = history.placePairId
    return { outcome, history, sheetId: pair.sheetId }
  }

  function getForPair(placePairId: string): NameHistory[] {
    return sortByPeriod(histories.value.filter((history) => history.placePairId === placePairId))
  }

  return {
    histories,
    currentPairId,
    currentHistories,
    initialized,
    init,
    reload,
    loadFor,
    addHistory,
    getForPair,
  }
})
