import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { NameHistory } from '../types/history'
import { createId, db } from '../utils/db'
import { sortByPeriod } from '../utils/scale'
import { useWorkspaceStore } from './workspaceStore'

export type NewNameHistory = Omit<NameHistory, 'id'>

export const useHistoryStore = defineStore('history', () => {
  const histories = ref<NameHistory[]>([])
  const currentPairId = ref('')
  const initialized = ref(false)
  let initialization: Promise<void> | null = null

  const currentHistories = computed(() =>
    sortByPeriod(
      histories.value.filter((history) => history.placePairId === currentPairId.value),
    ),
  )

  async function init(): Promise<void> {
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

  async function reload(): Promise<void> {
    histories.value = await db.histories.toArray()
  }

  async function loadFor(placePairId: string): Promise<void> {
    await init()
    currentPairId.value = placePairId
  }

  /**
   * 补沿革先记入地名所属图幅的暂存步骤。
   * 沿革间接归图幅：通过地名对照找到 sheetId。
   */
  async function addHistory(input: NewNameHistory): Promise<NameHistory> {
    await init()
    const workspace = useWorkspaceStore()
    await workspace.init()
    const history: NameHistory = { ...input, id: createId('history-draft') }

    // 归属地名可能还在某页签的暂存步骤里，也可能已在主档
    const draftPair = workspace.workspaces
      .flatMap((ws) => ws.ops)
      .find((op) => op.type === 'place.add' && op.recordId === input.placePairId)
    const sheetId =
      (draftPair?.payload as { sheetId?: string } | undefined)?.sheetId ??
      (await db.placePairs.get(input.placePairId))?.sheetId
    if (!sheetId) {
      throw new Error('找不到地名所属图幅，沿革步骤无法暂存')
    }
    await workspace.stageHistory(sheetId, history)
    currentPairId.value = history.placePairId
    return history
  }

  /** 含暂存中的沿革；draft 地名下的沿革也能即时显示。 */
  function getForPair(placePairId: string): NameHistory[] {
    const workspace = useWorkspaceStore()
    const drafts = workspace.workspaces
      .flatMap((ws) => ws.ops)
      .filter((op) => op.type === 'history.add')
      .map((op) => op.payload as unknown as NameHistory)
      .filter((history) => history.placePairId === placePairId)
    return sortByPeriod([
      ...histories.value.filter((history) => history.placePairId === placePairId),
      ...drafts,
    ])
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
