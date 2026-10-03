<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useSheetStore } from '../../stores/sheetStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'

const route = useRoute()
const router = useRouter()
const workspaceStore = useWorkspaceStore()
const sheetStore = useSheetStore()
const expanded = ref(false)
const busy = ref<string | null>(null)

const grouped = computed(() =>
  workspaceStore.myWorkspaces
    .map((ws) => ({
      ws,
      sheet: sheetStore.getSheetById(ws.sheetId),
      stale: workspaceStore.isStale(ws.sheetId),
    }))
    .filter((item) => item.ws.ops.length > 0),
)

const total = computed(() => grouped.value.reduce((sum, item) => sum + item.ws.ops.length, 0))

function onDetail(sheetId: string): boolean {
  return route.name === 'sheet-detail' && route.params.id === sheetId
}

async function submit(sheetId: string): Promise<void> {
  busy.value = sheetId
  try {
    const result = await workspaceStore.commit(sheetId)
    if (result.committed) {
      await sheetStore.reload()
      if (result.conflictCount > 0) {
        ElMessage.warning(`已提交，${result.conflictCount} 处与另一页签同改，已进入待核`)
      } else {
        ElMessage.success('已按图幅提交')
      }
    }
  } catch (error) {
    ElMessage.error(`提交失败，主档仍停在上一提交点：${(error as Error).message}`)
  } finally {
    busy.value = null
  }
}

async function discard(sheetId: string): Promise<void> {
  await workspaceStore.discardWorkspace(sheetId)
  ElMessage.info('已放弃该图幅的暂存步骤')
}
</script>

<template>
  <div v-if="total > 0" class="pending-tray" data-testid="pending-tray">
    <button class="pending-tray__bar" @click="expanded = !expanded">
      <strong>{{ total }}</strong> 步待提交
      <span v-if="grouped.some((item) => item.stale)" class="pending-tray__warn">· 有页签已先提交，将重放合并</span>
      <span class="pending-tray__toggle">{{ expanded ? '收起' : '展开' }}</span>
    </button>
    <div v-if="expanded" class="pending-tray__body">
      <div v-for="item in grouped" :key="item.ws.id" class="pending-group">
        <div class="pending-group__head">
          <span>{{ item.sheet?.code ?? item.ws.sheetId }} · {{ item.sheet?.title ?? '图幅' }}</span>
          <el-tag v-if="item.stale" type="warning" size="small">基线落后，提交时重放</el-tag>
        </div>
        <ol class="pending-group__ops">
          <li v-for="(op, index) in item.ws.ops" :key="`${op.recordId ?? op.type}-${index}`">
            <span>{{ op.label }}</span>
            <button class="pending-group__remove" title="移出暂存" @click="workspaceStore.removeOp(item.ws.sheetId, index)">×</button>
          </li>
        </ol>
        <div class="pending-group__actions">
          <el-button size="small" @click="discard(item.ws.sheetId)">放弃</el-button>
          <el-button
            v-if="!onDetail(item.ws.sheetId)"
            size="small"
            @click="router.push(`/sheets/${item.ws.sheetId}`)"
          >到图幅页提交</el-button>
          <el-button
            size="small"
            type="primary"
            :loading="busy === item.ws.sheetId"
            @click="submit(item.ws.sheetId)"
          >提交本图幅</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pending-tray {
  position: fixed;
  right: 22px;
  bottom: 22px;
  z-index: 60;
  width: min(340px, calc(100vw - 44px));
  color: #f7f0e7;
  background: linear-gradient(115deg, #3b2a20, #5b3b2c);
  border: 1px solid #d8b68e;
  border-radius: 8px;
  box-shadow: 0 14px 34px rgba(45, 27, 16, 0.35);
  overflow: hidden;
}

.pending-tray__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 11px 14px;
  color: inherit;
  background: transparent;
  border: 0;
  cursor: pointer;
}

.pending-tray__bar strong {
  font-size: 17px;
  color: #e9c79a;
}

.pending-tray__warn {
  color: #f0c987;
  font-size: 12px;
}

.pending-tray__toggle {
  margin-left: auto;
  color: #d9c8b7;
  font-size: 12px;
}

.pending-tray__body {
  max-height: 60vh;
  overflow: auto;
  padding: 4px 12px 12px;
  border-top: 1px solid rgba(216, 182, 142, 0.35);
}

.pending-group {
  padding: 10px 0;
  border-bottom: 1px dashed rgba(216, 182, 142, 0.4);
}

.pending-group:last-child {
  border-bottom: 0;
}

.pending-group__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 13px;
}

.pending-group__ops {
  margin: 0 0 8px;
  padding-left: 18px;
  font-size: 13px;
  color: #e5d6c5;
}

.pending-group__ops li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.pending-group__remove {
  color: #e5d6c5;
  background: transparent;
  border: 0;
  cursor: pointer;
}

.pending-group__actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
</style>
