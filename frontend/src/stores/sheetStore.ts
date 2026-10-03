import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'
import { createId, db } from '../utils/db'
import { sortByYear } from '../utils/scale'
import { createSheetWithCommit } from '../utils/commitService'
import { useWorkspaceStore } from './workspaceStore'

export type NewSheet = Omit<Sheet, 'id' | 'neighborCodes'> & {
  neighborCodes?: string[]
}
export type NewScanItem = Omit<ScanItem, 'id'>

export const useSheetStore = defineStore('sheet', () => {
  const sheets = ref<Sheet[]>([])
  const allScans = ref<ScanItem[]>([])
  const currentSheet = ref<Sheet | null>(null)
  const loading = ref(false)
  const initialized = ref(false)
  let initialization: Promise<void> | null = null

  const currentScans = computed(() =>
    currentSheet.value
      ? allScans.value.filter((scan) => scan.sheetId === currentSheet.value?.id)
      : [],
  )

  async function init(): Promise<void> {
    if (initialized.value) {
      return
    }
    if (!initialization) {
      loading.value = true
      initialization = Promise.all([db.sheets.toArray(), db.scans.toArray()])
        .then(([sheetRows, scanRows]) => {
          sheets.value = sortByYear(sheetRows).reverse()
          allScans.value = scanRows
          initialized.value = true
        })
        .finally(() => {
          loading.value = false
        })
    }
    await initialization
  }

  /** 其它页签提交后回到上一提交点重载主档。 */
  async function reload(): Promise<void> {
    const [sheetRows, scanRows] = await Promise.all([db.sheets.toArray(), db.scans.toArray()])
    const currentId = currentSheet.value?.id
    sheets.value = sortByYear(sheetRows).reverse()
    allScans.value = scanRows
    if (currentId) {
      currentSheet.value = sheets.value.find((sheet) => sheet.id === currentId) ?? null
    }
  }

  /**
   * 新建图幅：建卡与首个提交点在同一事务内落盘，
   * 互相依赖的改动不会只落一半。
   */
  async function addSheet(input: NewSheet): Promise<Sheet> {
    await init()
    const workspace = useWorkspaceStore()
    await workspace.init()
    const sheet: Sheet = {
      ...input,
      id: createId('sheet'),
      neighborCodes: input.neighborCodes ?? [],
    }
    await createSheetWithCommit({ sheet, tabId: workspace.tabId, tabLabel: workspace.tabLabel })
    sheets.value = sortByYear([...sheets.value, sheet]).reverse()
    currentSheet.value = sheet
    await workspace.reloadAll()
    return sheet
  }

  async function loadSheet(id: string): Promise<void> {
    await init()
    currentSheet.value = sheets.value.find((sheet) => sheet.id === id) ?? (await db.sheets.get(id)) ?? null
  }

  /** 补扫描件先记入本图幅暂存步骤，提交时才进主档。 */
  async function addScan(input: NewScanItem): Promise<ScanItem> {
    await init()
    const workspace = useWorkspaceStore()
    await workspace.init()
    await workspace.stageScan(input.sheetId, input)
    // 主用件联动取消也随暂存步骤一起在提交时原子生效，这里不直接写主档
    await reload()
    return { ...input, id: 'draft' }
  }

  /** 切换主用件同样作为本图幅的一步暂存。 */
  async function setPrimaryScan(scanId: string): Promise<void> {
    const target = allScans.value.find((scan) => scan.id === scanId)
    if (!target) {
      return
    }
    const workspace = useWorkspaceStore()
    await workspace.init()
    await workspace.stageSetPrimary(target.sheetId, scanId, target.fileName)
  }

  /** 暂存中的扫描件（尚未提交），供详情页即时展示。 */
  function draftScansForSheet(sheetId: string): ScanItem[] {
    const workspace = useWorkspaceStore()
    return workspace
      .opsFor(sheetId)
      .filter((op) => op.type === 'scan.add')
      .map((op) => op.payload as unknown as ScanItem)
  }

  /** 暂存中被指定为主用件的扫描件号。 */
  function draftPrimaryScanId(sheetId: string): string | undefined {
    const workspace = useWorkspaceStore()
    const ops = workspace.opsFor(sheetId)
    const setPrimary = [...ops].reverse().find((op) => op.type === 'scan.setPrimary')
    if (setPrimary) {
      return setPrimary.recordId
    }
    const addedPrimary = [...ops]
      .reverse()
      .find((op) => op.type === 'scan.add' && (op.payload as ScanItem | undefined)?.isPrimary)
    return addedPrimary?.recordId
  }

  function getSheetById(id: string): Sheet | undefined {
    return sheets.value.find((sheet) => sheet.id === id)
  }

  function getSheetByCode(code: string): Sheet | undefined {
    return sheets.value.find((sheet) => sheet.code === code)
  }

  function getScansForSheet(sheetId: string): ScanItem[] {
    // 主档 + 本页签暂存件合并展示；主用状态以暂存步骤为准
    const workspace = useWorkspaceStore()
    const draftPrimary = draftPrimaryScanId(sheetId)
    const draftIds = new Set(draftScansForSheet(sheetId).map((scan) => scan.id))
    const merged = [
      ...allScans.value
        .filter((scan) => scan.sheetId === sheetId && !draftIds.has(scan.id))
        .map((scan) => ({
          ...scan,
          isPrimary: draftPrimary ? scan.id === draftPrimary : scan.isPrimary,
        })),
      ...draftScansForSheet(sheetId).map((scan) => ({
        ...scan,
        isPrimary: draftPrimary ? scan.id === draftPrimary : scan.isPrimary,
      })),
    ]
    return merged.sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary))
  }

  return {
    sheets,
    allScans,
    currentSheet,
    currentScans,
    loading,
    initialized,
    init,
    reload,
    addSheet,
    loadSheet,
    addScan,
    setPrimaryScan,
    draftScansForSheet,
    draftPrimaryScanId,
    getSheetById,
    getSheetByCode,
    getScansForSheet,
  }
})
