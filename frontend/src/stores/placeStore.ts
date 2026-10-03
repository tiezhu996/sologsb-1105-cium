import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CommitOutcome } from '../types/commit'
import type { Certainty, PlacePair, PlaceType } from '../types/placePair'
import { createId, db } from '../utils/db'
import { pairUpsertOp } from '../utils/ops'
import { useCommitStore } from './commitStore'

export type NewPlacePair = Omit<PlacePair, 'id' | 'rowRev'>

export interface PairWriteResult {
  outcome: CommitOutcome
  pair: PlacePair
}

export const usePlaceStore = defineStore('place', () => {
  const commitStore = useCommitStore()

  const pairs = ref<PlacePair[]>([])
  const currentPair = ref<PlacePair | null>(null)
  const placeTypeFilter = ref<PlaceType | '全部'>('全部')
  const certaintyFilter = ref<Certainty | '全部'>('全部')
  const keyword = ref('')
  const matchedPairIds = ref<string[]>([])
  const initialized = ref(false)
  let initialization: Promise<void> | null = null

  const filteredPairs = computed(() =>
    pairs.value.filter((pair) => {
      const matchesType = placeTypeFilter.value === '全部' || pair.placeType === placeTypeFilter.value
      const matchesCertainty =
        certaintyFilter.value === '全部' || pair.certainty === certaintyFilter.value
      return matchesType && matchesCertainty
    }),
  )

  async function reload(): Promise<void> {
    if (!initialized.value) {
      return
    }
    const rows = await db.placePairs.toArray()
    const currentId = currentPair.value?.id
    pairs.value = rows
    currentPair.value = currentId ? (rows.find((pair) => pair.id === currentId) ?? null) : null
  }

  async function init(): Promise<void> {
    await commitStore.init()
    commitStore.registerRefreshHook(reload)
    if (initialized.value) {
      return
    }
    if (!initialization) {
      initialization = db.placePairs.toArray().then((rows) => {
        pairs.value = rows
        initialized.value = true
      })
    }
    await initialization
  }

  /** 补地名对照：按所属图幅提交，与另一页签的图幅修订互不覆盖。 */
  async function addPair(input: NewPlacePair): Promise<PairWriteResult> {
    await init()
    const pair: PlacePair = { ...input, id: createId('place') }
    const outcome = await commitStore.commit({
      sheetId: pair.sheetId,
      label: '补录地名对照',
      note: `新增古名「${pair.oldName}」对照今名「${pair.newName}」。`,
      ops: [pairUpsertOp({ entity: pair, baseRowRev: 0 })],
    })
    if (outcome.ok && outcome.appliedOpCount > 0) {
      pairs.value = [...pairs.value, pair]
      currentPair.value = pair
    }
    return { outcome, pair }
  }

  async function loadPair(id: string): Promise<void> {
    await init()
    currentPair.value = pairs.value.find((pair) => pair.id === id) ?? (await db.placePairs.get(id)) ?? null
  }

  function getPairsForSheet(sheetId: string): PlacePair[] {
    return pairs.value.filter((pair) => pair.sheetId === sheetId)
  }

  function setMatchedPairIds(ids: string[]): void {
    matchedPairIds.value = [...ids]
  }

  function resetFilters(): void {
    placeTypeFilter.value = '全部'
    certaintyFilter.value = '全部'
    keyword.value = ''
    matchedPairIds.value = []
  }

  return {
    pairs,
    currentPair,
    placeTypeFilter,
    certaintyFilter,
    keyword,
    matchedPairIds,
    filteredPairs,
    initialized,
    init,
    reload,
    addPair,
    loadPair,
    getPairsForSheet,
    setMatchedPairIds,
    resetFilters,
  }
})
