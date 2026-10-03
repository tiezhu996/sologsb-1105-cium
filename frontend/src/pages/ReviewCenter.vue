<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useSheetStore } from '../stores/sheetStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import VacantHint from '../components/common/VacantHint.vue'

const sheetStore = useSheetStore()
const workspaceStore = useWorkspaceStore()
const busy = ref<string | null>(null)

onMounted(async () => {
  await Promise.all([sheetStore.init(), workspaceStore.init()])
})

const pendingRows = computed(() =>
  workspaceStore.conflicts.map((conflict) => ({
    conflict,
    sheet: sheetStore.getSheetById(conflict.sheetId),
  })),
)

const activeRows = computed(() => pendingRows.value.filter((item) => item.conflict.status === '待核'))
const resolvedRows = computed(() => pendingRows.value.filter((item) => item.conflict.status !== '待核'))

function displayValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join('、') || '（空）'
  }
  if (value === undefined || value === null || value === '') {
    return '（空）'
  }
  return String(value)
}

async function resolve(conflictId: string, resolution: '采纳' | '舍弃'): Promise<void> {
  busy.value = conflictId
  try {
    await workspaceStore.resolve(conflictId, resolution)
    await sheetStore.reload()
    ElMessage.success(`已${resolution}，主档已从上一提交点重放校准`)
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <span class="page-kicker">REVIEW QUEUE</span>
        <h1>待核中心</h1>
        <p>两个页签同时提交并改动同一字段时，双方步骤都保留在提交记录中；冲突内容不进主档，停在上一提交点，在此人工裁定。</p>
      </div>
      <router-link to="/sheets"><el-button>返回编目台</el-button></router-link>
    </div>

    <div v-if="activeRows.length" class="review-list">
      <article v-for="item in activeRows" :key="item.conflict.id" class="review-card" data-testid="row-conflict">
        <header class="review-card__head">
          <div>
            <el-tag type="warning" effect="dark">待核</el-tag>
            <strong>{{ item.sheet?.code ?? item.conflict.sheetId }} · {{ item.conflict.label }}</strong>
          </div>
          <span class="muted">
            来自 {{ item.conflict.tabLabel }} · 第 {{ item.conflict.commitSeq }} 次提交
          </span>
        </header>

        <table class="review-table">
          <thead>
            <tr>
              <th>字段</th>
              <th>上一提交点</th>
              <th>另一页签已提交</th>
              <th>本页签想写入</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="field in item.conflict.fields" :key="field.key">
              <td>{{ field.label }}</td>
              <td class="muted">{{ displayValue(field.base) }}</td>
              <td>{{ displayValue(field.theirs) }}</td>
              <td class="text-danger">{{ displayValue(field.ours) }}</td>
            </tr>
          </tbody>
        </table>

        <p class="muted review-card__note">
          主档当前保留「另一页签已提交」的值；采纳将写入本页签的值并作为正式步骤，舍弃则维持现主档。
        </p>

        <div class="review-card__actions">
          <router-link :to="`/sheets/${item.conflict.sheetId}`">
            <el-button>看图幅</el-button>
          </router-link>
          <el-button
            :loading="busy === item.conflict.id"
            @click="resolve(item.conflict.id, '舍弃')"
          >舍弃本页签值</el-button>
          <el-button
            type="primary"
            :loading="busy === item.conflict.id"
            @click="resolve(item.conflict.id, '采纳')"
          >采纳本页签值</el-button>
        </div>
      </article>
    </div>

    <section v-if="resolvedRows.length" class="resolved-list">
      <div class="section-title">
        <h2>已处置</h2>
        <span class="muted">裁定已作为提交记录保留</span>
      </div>
      <article v-for="item in resolvedRows" :key="item.conflict.id" class="resolved-row">
        <el-tag :type="item.conflict.status === '已采纳' ? 'success' : 'info'" size="small">
          {{ item.conflict.status }}
        </el-tag>
        <span>{{ item.sheet?.code ?? item.conflict.sheetId }} · {{ item.conflict.label }}</span>
        <span class="muted">{{ item.conflict.tabLabel }}</span>
      </article>
    </section>

    <VacantHint
      v-if="!activeRows.length && !resolvedRows.length"
      title="没有待核内容"
      description="当两个页签对同一图幅同一字段同时提交时，冲突会在此等待人工裁定。"
    />
  </section>
</template>

<style scoped>
.review-card {
  margin-bottom: 18px;
  padding: 18px 20px;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow);
}

.review-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.review-card__head strong {
  margin-left: 10px;
}

.review-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.review-table th,
.review-table td {
  padding: 8px 10px;
  text-align: left;
  border: 1px solid var(--line);
  vertical-align: top;
}

.review-table th {
  background: var(--paper-deep);
}

.review-card__note {
  margin: 10px 0 0;
  font-size: 13px;
}

.review-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.resolved-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  border-bottom: 1px dashed var(--line);
}
</style>
