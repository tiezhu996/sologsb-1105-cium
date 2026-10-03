import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useCommitStore } from '../stores/commitStore'

export interface StagedDraft<T> {
  /** 是否从草稿台恢复出了上次未提交的内容。 */
  resumed: Ref<boolean>
  save: () => Promise<void>
  discard: () => Promise<void>
  stop: () => void
}

/**
 * 按表单键暂存未提交的操作草稿：
 * - 表单变化后防抖自动保存，页签崩溃/关闭后重开可接着处理；
 * - 挂载与键变化时从草稿台恢复；
 * - isBlank 用于区分“空表单”与“真有未完成内容”，空内容不提示恢复。
 */
export function useStagedDraft<T extends object>(options: {
  draftKey: string | Ref<string>
  sheetId: string | Ref<string>
  form: T
  isBlank?: (form: T) => boolean
  delayMs?: number
  onResumed?: (payload: T) => void
}): StagedDraft<T> {
  const commitStore = useCommitStore()
  const { form, isBlank, delayMs = 400 } = options
  const resumed = ref(false)

  function keyAt(): string {
    return typeof options.draftKey === 'string' ? options.draftKey : options.draftKey.value
  }
  function sheetIdAt(): string {
    return typeof options.sheetId === 'string' ? options.sheetId : options.sheetId.value
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  async function hydrate(): Promise<void> {
    const draft = await commitStore.loadDraft<T>(keyAt())
    if (draft && (!isBlank || !isBlank(draft.payload))) {
      Object.assign(form as object, draft.payload)
      resumed.value = true
      options.onResumed?.(draft.payload)
    } else {
      resumed.value = false
    }
  }

  async function save(): Promise<void> {
    if (isBlank?.(form)) {
      await commitStore.clearDraft(keyAt())
      return
    }
    await commitStore.saveDraft(keyAt(), sheetIdAt(), form)
  }

  async function discard(): Promise<void> {
    await commitStore.clearDraft(keyAt())
    resumed.value = false
  }

  const stopWatch = watch(
    () => ({ ...(form as Record<string, unknown>) }),
    () => {
      if (timer) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        void save()
      }, delayMs)
    },
    { deep: true },
  )

  void hydrate()

  // 草稿键随图幅切换时，重新恢复对应图幅的未提交内容。
  const keySource = typeof options.draftKey === 'string' ? null : options.draftKey
  const stopKeyWatch = keySource
    ? watch(keySource, () => void hydrate())
    : () => undefined

  function stop(): void {
    stopWatch()
    stopKeyWatch()
    if (timer) {
      clearTimeout(timer)
    }
  }

  onBeforeUnmount(stop)

  return { resumed, save, discard, stop }
}
