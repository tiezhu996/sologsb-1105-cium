<script setup lang="ts">
import { computed } from 'vue'
import { useCommitStore } from '../../stores/commitStore'

const props = defineProps<{ sheetId: string }>()

const commitStore = useCommitStore()

const headRev = computed(() => commitStore.sheetHeads[props.sheetId] ?? 0)
const pendingForSheet = computed(() =>
  commitStore.pendingConflicts.filter((item) => item.sheetId === props.sheetId),
)
</script>

<template>
  <div class="commit-point-bar" data-testid="commit-point-bar">
    <span class="commit-point-bar__rev">
      提交点
      <strong data-testid="commit-head-rev">{{ headRev || '—' }}</strong>
    </span>
    <router-link
      v-if="pendingForSheet.length"
      class="commit-point-bar__conflict"
      :to="`/conflicts?sheet=${sheetId}`"
      data-testid="commit-pending-link"
    >
      <el-badge :value="pendingForSheet.length" type="danger">
        <span class="commit-point-bar__conflict-text">本图幅有改动待核，去裁定</span>
      </el-badge>
    </router-link>
    <span v-else class="muted">主档停在已确认的提交点上</span>
  </div>
</template>

<style scoped>
.commit-point-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  padding: 8px 14px;
  margin-bottom: 16px;
  border: 1px dashed #b9a58a;
  border-radius: 8px;
  background: #faf6ef;
  font-size: 13px;
}

.commit-point-bar__rev strong {
  font-size: 16px;
  color: #8b3f2f;
  margin-left: 4px;
}

.commit-point-bar__conflict-text {
  color: #b3402b;
  font-weight: 600;
}
</style>
