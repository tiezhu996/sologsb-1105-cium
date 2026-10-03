<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useCommitStore } from '../stores/commitStore'
import { useSheetStore } from '../stores/sheetStore'
import type { CommitOp, ConflictRecord } from '../types/commit'
import { CONFLICT_REASON_TEXT } from '../types/commit'
import { formatDateTime, opKindText, opSubject } from '../utils/describe'
import VacantHint from '../components/common/VacantHint.vue'

const route = useRoute()
const commitStore = useCommitStore()
const sheetStore = useSheetStore()

const selectedSheetId = ref(String(route.query.sheet ?? ''))
const resolvingId = ref('')

const sheetOptions = computed(() => {
  const ids = new Set(commitStore.pendingConflicts.map((item) => item.sheetId))
  return [...ids]
    .map((id) => ({ id, sheet: sheetStore.getSheetById(id) }))
    .filter((item) => item.sheet)
})

const visiblePending = computed(() =>
  selectedSheetId.value
    ? commitStore.pendingConflicts.filter((item) => item.sheetId === selectedSheetId.value)
    : commitStore.pendingConflicts,
)

function sheetCode(sheetId: string): string {
  return sheetStore.getSheetById(sheetId)?.code ?? sheetId
}

/** 把待核操作的实体展开为可修订字段（采纳后到改动）。 */
function editableFields(conflict: ConflictRecord): Record<string, string | number> {
  const op = conflict.ops[0]
  const entity = op.entity as unknown as Record<string, unknown>
  const fields: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(entity)) {
    if (key === 'id' || key === 'sheetId' || key === 'placePairId' || key === 'rowRev') {
      continue
    }
    if (typeof value === 'string' || typeof value === 'number') {
      fields[key] = value
    }
  }
  return fields
}

const editing = reactive<Record<string, Record<string, string | number>>>({})
const showEditor = ref('')

function startEdit(conflict: ConflictRecord): void {
  editing[conflict.id] = editableFields(conflict)
  showEditor.value = conflict.id
}

function applyEditedEntity(conflict: ConflictRecord): CommitOp {
  const op = conflict.ops[0]
  const edits = editing[conflict.id] ?? {}
  const entity = { ...op.entity } as Record<string, unknown>
  for (const [key, value] of Object.entries(edits)) {
    entity[key] = typeof value === 'string' ? value : Number(value)
  }
  return { ...op, entity: entity as unknown as CommitOp['entity'] }
}

async function acceptAsIs(conflict: ConflictRecord): Promise<void> {
  resolvingId.value = conflict.id
  try {
    const outcome = await commitStore.acceptConflict(conflict)
    if (!outcome.ok) {
      ElMessage.error(`采纳失败，主档仍停在上一提交点：${outcome.error}`)
      return
    }
    if (outcome.conflicts.length) {
      ElMessage.warning('其上游改动仍在待核，请先裁定上游记录。')
      return
    }
    ElMessage.success(`已采纳并重放为第 ${outcome.seq} 个提交点。`)
  } finally {
    resolvingId.value = ''
  }
}

async function acceptWithEdit(conflict: ConflictRecord): Promise<void> {
  resolvingId.value = conflict.id
  try {
    const outcome = await commitStore.acceptConflict(conflict, (op) =>
      applyEditedEntity({ ...conflict, ops: [op] }),
    )
    if (!outcome.ok) {
      ElMessage.error(`采纳失败，主档仍停在上一提交点：${outcome.error}`)
      return
    }
    if (outcome.conflicts.length) {
      ElMessage.warning('其上游改动仍在待核，请先裁定上游记录。')
      return
    }
    showEditor.value = ''
    ElMessage.success(`修订后的内容已重放为第 ${outcome.seq} 个提交点。`)
  } finally {
    resolvingId.value = ''
  }
}

async function dismiss(conflict: ConflictRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '维持上一提交点内容？该步骤将不会重放，但记录保留可查。',
      '维持主档',
      { type: 'warning', confirmButtonText: '维持上一提交点', cancelButtonText: '再想想' },
    )
  } catch {
    return
  }
  resolvingId.value = conflict.id
  try {
    await commitStore.dismissConflict(conflict)
    ElMessage.success('已维持上一提交点，待核记录归档。')
  } finally {
    resolvingId.value = ''
  }
}

onMounted(async () => {
  await Promise.all([sheetStore.init(), commitStore.init()])
})
</script>

<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <span class="page-kicker">REVIEW QUEUE</span>
        <h1>待核台</h1>
        <p>两个页签同时提交且改动相撞时，冲突步骤停在此处；主档保持在上一提交点，裁定后才重放。</p>
      </div>
      <el-tag type="danger" effect="dark" size="large">待核 {{ commitStore.pendingCount }} 条</el-tag>
    </div>

    <div v-if="commitStore.pendingCount" class="filter-bar">
      <span class="muted">按图幅筛选：</span>
      <el-select v-model="selectedSheetId" clearable placeholder="全部图幅" style="width: 260px">
        <el-option
          v-for="option in sheetOptions"
          :key="option.id"
          :label="option.sheet ? `${option.sheet.code} · ${option.sheet.title}` : option.id"
          :value="option.id"
        />
      </el-select>
    </div>

    <div v-if="visiblePending.length" class="conflict-list">
      <article v-for="conflict in visiblePending" :key="conflict.id" class="conflict-card" data-testid="conflict-card">
        <header class="conflict-card__head">
          <el-tag type="danger" effect="dark">{{ sheetCode(conflict.sheetId) }}</el-tag>
          <strong>{{ conflict.commitLabel }}</strong>
          <el-tag effect="plain">提交点 {{ conflict.commitSeq }}</el-tag>
          <span class="muted">{{ conflict.tabId === 'bootstrap' ? '' : `页签 ${conflict.tabId.slice(-6)}` }}</span>
          <time class="muted">{{ formatDateTime(conflict.createdAt) }}</time>
        </header>

        <p class="conflict-card__reason">
          <strong>挂起原因：</strong>{{ CONFLICT_REASON_TEXT[conflict.reason] }}
        </p>

        <ul class="conflict-card__ops">
          <li v-for="op in conflict.ops" :key="op.clientId">
            <el-tag size="small" effect="plain">{{ opKindText(op.kind) }}</el-tag>
            <span>{{ opSubject(op) }}</span>
            <span class="muted">基于行版本 {{ op.baseRowRev }}</span>
          </li>
        </ul>

        <div v-if="showEditor === conflict.id" class="conflict-editor">
          <h3>修订后采纳</h3>
          <div v-for="(value, key) in editing[conflict.id]" :key="key" class="conflict-editor__row">
            <label>{{ key }}</label>
            <input v-model="editing[conflict.id][key]" class="native-field" />
          </div>
        </div>

        <div class="conflict-card__actions">
          <el-button
            type="success"
            :loading="resolvingId === conflict.id"
            @click="acceptAsIs(conflict)"
          >
            按此内容采纳并重放
          </el-button>
          <el-button
            v-if="showEditor !== conflict.id"
            plain
            :disabled="resolvingId === conflict.id"
            @click="startEdit(conflict)"
          >
            采纳后到改动
          </el-button>
          <el-button
            v-else
            type="primary"
            :loading="resolvingId === conflict.id"
            @click="acceptWithEdit(conflict)"
          >
            提交修订
          </el-button>
          <el-button plain :disabled="resolvingId === conflict.id" @click="dismiss(conflict)">
            维持上一提交点
          </el-button>
        </div>
      </article>
    </div>

    <VacantHint
      v-else
      title="没有待核改动"
      description="两个页签对同一记录的改动若互不冲突会自动合并；撞车的步骤才会停在这里。"
    />

    <section v-if="commitStore.resolvedConflicts.length" class="mt-20">
      <div class="section-title">
        <h2>已裁定记录</h2>
        <span class="muted">待核内容不删除，保留审计痕迹。</span>
      </div>
      <div class="conflict-list">
        <article
          v-for="conflict in commitStore.resolvedConflicts"
          :key="conflict.id"
          class="conflict-card conflict-card--resolved"
        >
          <header class="conflict-card__head">
            <el-tag :type="conflict.status === 'accepted' ? 'success' : 'info'" effect="plain">
              {{ conflict.status === 'accepted' ? '已采纳' : '维持主档' }}
            </el-tag>
            <strong>{{ conflict.commitLabel }}</strong>
            <span class="muted">{{ sheetCode(conflict.sheetId) }} · 提交点 {{ conflict.commitSeq }}</span>
            <time v-if="conflict.resolvedAt" class="muted">{{ formatDateTime(conflict.resolvedAt) }}</time>
          </header>
          <p class="muted">{{ conflict.resolution }}</p>
        </article>
      </div>
    </section>
  </section>
</template>

<style scoped>
.conflict-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.conflict-card {
  border: 1px solid #d9cbb6;
  border-left: 4px solid #b3402b;
  border-radius: 10px;
  padding: 14px 18px;
  background: #fffdf8;
}

.conflict-card--resolved {
  border-left-color: #9a8f80;
  background: #faf7f2;
}

.conflict-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 14px;
}

.conflict-card__reason {
  margin: 10px 0 6px;
}

.conflict-card__ops {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.conflict-card__ops li {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.conflict-card__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 14px;
}

.conflict-editor {
  margin-top: 12px;
  padding: 12px;
  border: 1px dashed #b9a58a;
  border-radius: 8px;
  background: #faf6ef;
}

.conflict-editor__row {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 10px;
  align-items: center;
  margin-bottom: 8px;
}
</style>
