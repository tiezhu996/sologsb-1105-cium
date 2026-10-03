import { computed, onBeforeUnmount, ref, toValue, type MaybeRefOrGetter } from 'vue'
import { ElMessage } from 'element-plus'
import { useCommitStore } from '../stores/commitStore'
import { useSheetStore } from '../stores/sheetStore'

/**
 * 监听其他页签对同一图幅的提交：落档后对齐到新提交点并重载主档，
 * 避免本页签继续拿旧提交点覆盖对方。
 */
export function useSheetCommitSync(sheetIdRef: MaybeRefOrGetter<string>) {
  const commitStore = useCommitStore()
  const sheetStore = useSheetStore()
  const lastSignalAt = ref('')

  const sheetId = computed(() => toValue(sheetIdRef))
  const headRev = computed(() => commitStore.sheetHeads[sheetId.value] ?? 0)

  const stop = commitStore.onCrossTabSignal((signal) => {
    if (signal.sheetId !== sheetId.value || signal.tabId === commitStore.tabId) {
      return
    }
    if (signal.at <= lastSignalAt.value) {
      return
    }
    lastSignalAt.value = signal.at
    commitStore.syncMessage = `另一页签已提交到第 ${signal.rev} 个提交点，已为你对齐。`
    void Promise.all([
      commitStore.reloadIndexes(),
      commitStore.notifyRefreshes(),
      sheetStore.loadSheet(signal.sheetId),
    ]).then(() => {
      ElMessage.success({
        message: '另一页签的改动已保留并重放，当前为最新提交点。',
        duration: 2600,
      })
    })
  })

  onBeforeUnmount(stop)

  return { headRev }
}
