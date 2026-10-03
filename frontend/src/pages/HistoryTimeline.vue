<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useHistoryStore, type NewNameHistory } from '../stores/historyStore'
import { usePlaceStore } from '../stores/placeStore'
import { useSheetStore } from '../stores/sheetStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import type { NameChangeType } from '../types/history'
import { NAME_CHANGE_TYPES } from '../types/history'
import PairRow from '../components/common/PairRow.vue'
import VacantHint from '../components/common/VacantHint.vue'

const route = useRoute()
const placeStore = usePlaceStore()
const historyStore = useHistoryStore()
const sheetStore = useSheetStore()
const workspaceStore = useWorkspaceStore()
const formError = ref('')

const placePairId = computed(() => String(route.params.id ?? ''))
const pair = computed(() => {
  const current = placeStore.currentPair
  if (current?.id === placePairId.value) {
    return current
  }
  // 暂存中的地名对照（尚未提交）
  return workspaceStore.workspaces
    .flatMap((ws) => ws.ops)
    .find((op) => op.type === 'place.add' && op.recordId === placePairId.value)
    ?.payload as typeof current
})
const sheet = computed(() => (pair.value ? sheetStore.getSheetById(pair.value.sheetId) : undefined))
const timeline = computed(() =>
  historyStore.getForPair(placePairId.value).map((history) => ({
    history,
    staged: history.id.endsWith('-draft') || history.id.includes('history-draft'),
  })),
)
const sheetDraftCount = computed(() => (sheet.value ? workspaceStore.pendingCountBySheet[sheet.value.id] ?? 0 : 0))

function createEmptyForm(): NewNameHistory {
  return {
    placePairId: placePairId.value,
    period: '',
    name: '',
    changeType: '改名',
    sourceRef: '',
    note: '',
  }
}

const form = reactive<NewNameHistory>(createEmptyForm())

const narrative = computed(() => {
  if (timeline.value.length === 0) {
    return '尚未录入沿革记录。'
  }
  return timeline.value
    .map((item) => `${item.history.period}${item.history.name}（${item.history.changeType}）`)
    .join('；') + '。'
})

function timelineColor(changeType: NameChangeType): string {
  if (changeType === '初置') return '#526b59'
  if (changeType === '改名') return '#8b3f2f'
  if (changeType === '迁治') return '#a2713e'
  return '#766a62'
}

async function submitHistory(): Promise<void> {
  if (!form.period.trim() || !form.name.trim() || !form.sourceRef.trim()) {
    formError.value = '请填写年代、地名与出处置信。'
    return
  }
  await historyStore.addHistory({
    ...form,
    placePairId: placePairId.value,
    period: form.period.trim(),
    name: form.name.trim(),
    sourceRef: form.sourceRef.trim(),
    note: form.note.trim(),
  })
  Object.assign(form, createEmptyForm())
  formError.value = ''
  ElMessage.info('沿革已记入所属图幅的待提交步骤')
}

async function initialize(): Promise<void> {
  await Promise.all([
    sheetStore.init(),
    placeStore.init(),
    historyStore.init(),
    workspaceStore.init(),
  ])
  await placeStore.loadPair(placePairId.value)
  await historyStore.loadFor(placePairId.value)
}

onMounted(() => {
  void initialize()
})

watch(placePairId, () => {
  Object.assign(form, createEmptyForm())
  void placeStore.loadPair(placePairId.value)
  void historyStore.loadFor(placePairId.value)
})
</script>

<template>
  <section v-if="pair" class="page">
    <div class="page-heading">
      <div>
        <span class="page-kicker">NAME EVOLUTION</span>
        <h1>{{ pair.oldName }} 地名沿革时间线</h1>
        <p>沿时间顺序整理更名、迁治与废置记录，保留出处卷页，形成可复核的地名脉络。</p>
      </div>
      <router-link to="/places"><el-button>返回地名对照台</el-button></router-link>
    </div>

    <div class="detail-layout">
      <div>
        <PairRow :pair="pair" :sheet-code="sheet?.code ?? '图幅待补'" />

        <div class="section-title">
          <h2>沿革序列</h2>
          <span class="muted">共 {{ timeline.length }} 条</span>
        </div>

        <div v-if="sheetDraftCount" class="draft-notice">
          所属图幅有 {{ sheetDraftCount }} 步待提交，含本次沿革；
          <router-link :to="`/sheets/${sheet?.id}`">到图幅页提交</router-link>。
        </div>

        <div class="timeline-wrap">
          <div class="timeline-narrative">{{ narrative }}</div>
          <el-timeline>
            <el-timeline-item
              v-for="item in timeline"
              :key="item.history.id"
              :timestamp="item.history.period"
              placement="top"
              :color="timelineColor(item.history.changeType)"
            >
              <div class="timeline-item__head">
                <span class="timeline-item__name">{{ item.history.name }}</span>
                <el-tag effect="plain">{{ item.history.changeType }}</el-tag>
                <el-tag v-if="item.staged" type="warning" size="small">待提交</el-tag>
              </div>
              <p class="timeline-item__source">出处：{{ item.history.sourceRef }}</p>
              <p class="timeline-item__note">{{ item.history.note || '暂无补注。' }}</p>
            </el-timeline-item>
          </el-timeline>
        </div>
      </div>

      <aside>
        <form class="inline-form" @submit.prevent="submitHistory">
          <h2>新增沿革记录</h2>
          <el-form-item label="年代或朝代" required>
            <input v-model="form.period" class="native-field" data-testid="field-period" placeholder="例如：清光绪三十四年（1908）" />
          </el-form-item>
          <el-form-item label="当时名称" required>
            <input v-model="form.name" class="native-field" data-testid="field-name" />
          </el-form-item>
          <el-form-item label="变化类型" required>
            <select v-model="form.changeType" class="native-field" data-testid="field-changeType">
              <option v-for="changeType in NAME_CHANGE_TYPES" :key="changeType" :value="changeType">{{ changeType }}</option>
            </select>
          </el-form-item>
          <el-form-item label="出处卷页" required>
            <input v-model="form.sourceRef" class="native-field" data-testid="field-sourceRef" placeholder="志书、档案或图幅信息" />
          </el-form-item>
          <el-form-item label="核录说明">
            <textarea v-model="form.note" class="native-field" data-testid="field-note" rows="4"></textarea>
          </el-form-item>
          <p v-if="formError" class="text-danger">{{ formError }}</p>
          <el-button type="primary" native-type="submit" style="width: 100%" data-testid="submit-history">加入时间线</el-button>
        </form>
      </aside>
    </div>
  </section>

  <section v-else class="page">
    <h1>地名沿革时间线</h1>
    <VacantHint title="未找到地名对照" description="请返回地名对照台选择有效记录。" />
  </section>
</template>
