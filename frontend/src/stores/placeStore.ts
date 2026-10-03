import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Certainty, PlacePair, PlaceType } from '../types/placePair'
import { createId, db } from '../utils/db'
import { useWorkspaceStore } from './workspaceStore'

export type NewPlacePair = Omit<PlacePair, 'id'>

export const usePlaceStore = defineStore('place', () => {
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

  async function init(): Promise<void> {
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

  async function reload(): Promise<void> {
    const currentId = currentPair.value?.id
    pairs.value = await db.placePairs.toArray()
    if (currentId) {
      currentPair.value = pairs.value.find((pair) => pair.id === currentId) ?? null
    }
  }

  /** 地名对照先记入所属图幅的暂存步骤，与其它步骤一起按图幅提交。 */
  async function addPair(input: NewPlacePair): Promise<PlacePair> {
    await init()
    const workspace = useWorkspaceStore()
    await workspace.init()
    const pair: PlacePair = { ...input, id: createId('place-draft') }
    await workspace.stagePlace(pair)
    currentPair.value = pair
    return pair
  }

  async function loadPair(id: string): Promise<void> {
    await init()
    currentPair.value = pairs.value.find((pair) => pair.id === id) ?? (await db.placePairs.get(id)) ?? null
  }

  /** 含本页签暂存中的地名，供界面即时看到"待提交"步骤。 */
  function getPairsForSheet(sheetId: string): PlacePair[] {
    const workspace = useWorkspaceStore()
    const committed = pairs.value.filter((pair) => pair.sheetId === sheetId)
    const drafts = workspace
      .opsFor(sheetId)
      .filter((op) => op.type === 'place.add')
      .map((op) => op.payload as unknown as PlacePair)
    return [...committed, ...drafts]
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
