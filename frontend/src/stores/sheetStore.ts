import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CommitOutcome } from '../types/commit'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'
import { createId, db } from '../utils/db'
import { rowRevOf, scanUpsertOp, sheetUpsertOp } from '../utils/ops'
import { sortByYear } from '../utils/scale'
import { useCommitStore } from './commitStore'

export type NewSheet = Omit<Sheet, 'id' | 'neighborCodes' | 'rowRev'> & {
  neighborCodes?: string[]
}
export type NewScanItem = Omit<ScanItem, 'id' | 'rowRev'>

export interface SheetWriteResult {
  outcome: CommitOutcome
  sheet: Sheet
}

export interface ScanWriteResult {
  outcome: CommitOutcome
  scan: ScanItem
}

export const useSheetStore = defineStore('sheet', () => {
  const commitStore = useCommitStore()

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

  async function reload(): Promise<void> {
    if (!initialized.value) {
      return
    }
    const [sheetRows, scanRows] = await Promise.all([
      db.sheets.toArray(),
      db.scans.toArray(),
    ])
    const currentId = currentSheet.value?.id
    sheets.value = sortByYear(sheetRows).reverse()
    allScans.value = scanRows
    currentSheet.value = currentId
      ? (sheetRows.find((sheet) => sheet.id === currentId) ?? null)
      : null
  }

  async function init(): Promise<void> {
    await commitStore.init()
    commitStore.registerRefreshHook(reload)
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

  /** 新建图幅：图幅卡本身作为该图幅的首个提交点落档。 */
  async function addSheet(input: NewSheet): Promise<SheetWriteResult> {
    await init()
    const sheet: Sheet = {
      ...input,
      id: createId('sheet'),
      neighborCodes: input.neighborCodes ?? [],
    }
    const outcome = await commitStore.commit({
      sheetId: sheet.id,
      label: '新建图幅',
      note: `图幅卡 ${sheet.code} 建档，作为首个提交点。`,
      ops: [sheetUpsertOp({ entity: sheet, baseRowRev: 0 })],
    })
    if (outcome.ok) {
      sheets.value = sortByYear([...sheets.value, sheet]).reverse()
      currentSheet.value = sheet
    }
    return { outcome, sheet }
  }

  async function loadSheet(id: string): Promise<void> {
    await init()
    currentSheet.value = sheets.value.find((sheet) => sheet.id === id) ?? (await db.sheets.get(id)) ?? null
  }

  /** 图幅卡与四至修改，以整图幅实体写入；基于旧提交点的同卡改动会进待核。 */
  async function updateSheet(sheet: Sheet): Promise<CommitOutcome> {
    await init()
    const outcome = await commitStore.commit({
      sheetId: sheet.id,
      label: '修订图幅与四至',
      ops: [
        sheetUpsertOp({
          entity: { ...sheet },
          baseRowRev: rowRevOf(sheet),
        }),
      ],
    })
    if (outcome.ok) {
      currentSheet.value =
        sheets.value.find((item) => item.id === sheet.id) ?? currentSheet.value
    }
    return outcome
  }

  /** 补扫描件：设为主用件时，原主用件的取消标记与新件同组提交，不会只落一半。 */
  async function addScan(input: NewScanItem): Promise<ScanWriteResult> {
    await init()
    const scan: ScanItem = { ...input, id: createId('scan') }
    const ops = []
    let groupId: string | undefined
    if (scan.isPrimary) {
      groupId = createId('opgroup')
      const previousPrimary = allScans.value.find(
        (item) => item.sheetId === scan.sheetId && item.isPrimary,
      )
      if (previousPrimary) {
        ops.push(
          scanUpsertOp(
            {
              entity: { ...previousPrimary, isPrimary: false },
              baseRowRev: rowRevOf(previousPrimary),
            },
            groupId,
          ),
        )
      }
    }
    ops.push(scanUpsertOp({ entity: scan, baseRowRev: 0 }, groupId))

    const outcome = await commitStore.commit({
      sheetId: scan.sheetId,
      label: '补登记扫描件',
      note: `新增扫描件 ${scan.fileName}${scan.isPrimary ? '，并设为主用件' : ''}。`,
      ops,
    })
    if (outcome.ok && outcome.appliedOpCount > 0) {
      allScans.value = [...allScans.value.filter((item) => item.id !== scan.id), scan]
    }
    return { outcome, scan }
  }

  /** 切换主用件：目标件与原主用件同组，任一撞车则整体进待核。 */
  async function setPrimaryScan(scanId: string): Promise<CommitOutcome> {
    await init()
    const target = allScans.value.find((scan) => scan.id === scanId)
    if (!target || target.isPrimary) {
      return {
        ok: false,
        seq: target ? commitStore.headRev(target.sheetId) : 0,
        rev: target ? commitStore.headRev(target.sheetId) : 0,
        appliedOpCount: 0,
        conflicts: [],
        error: '未找到扫描件或已是主用件',
      }
    }
    const groupId = createId('opgroup')
    const previous = allScans.value.find(
      (scan) => scan.sheetId === target.sheetId && scan.isPrimary,
    )
    const ops = []
    if (previous) {
      ops.push(
        scanUpsertOp(
          { entity: { ...previous, isPrimary: false }, baseRowRev: rowRevOf(previous) },
          groupId,
        ),
      )
    }
    ops.push(
      scanUpsertOp(
        { entity: { ...target, isPrimary: true }, baseRowRev: rowRevOf(target) },
        groupId,
      ),
    )
    return commitStore.commit({
      sheetId: target.sheetId,
      label: '切换主用扫描件',
      ops,
    })
  }

  function getSheetById(id: string): Sheet | undefined {
    return sheets.value.find((sheet) => sheet.id === id)
  }

  function getSheetByCode(code: string): Sheet | undefined {
    return sheets.value.find((sheet) => sheet.code === code)
  }

  function getScansForSheet(sheetId: string): ScanItem[] {
    return allScans.value
      .filter((scan) => scan.sheetId === sheetId)
      .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary))
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
    updateSheet,
    loadSheet,
    addScan,
    setPrimaryScan,
    getSheetById,
    getSheetByCode,
    getScansForSheet,
  }
})
