<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useSheetStore, type NewScanItem } from '../stores/sheetStore'
import { usePlaceStore } from '../stores/placeStore'
import { useCommitStore } from '../stores/commitStore'
import type { Sheet } from '../types/sheet'
import type { ColorMode, ScanQuality } from '../types/scan'
import { COLOR_MODES, SCAN_QUALITIES } from '../types/scan'
import { SHEET_SCALES, SHEET_STATUSES } from '../types/sheet'
import { usePlaceSearch } from '../hooks/usePlaceSearch'
import { useSheetCommitSync } from '../hooks/useSheetCommitSync'
import { useStagedDraft } from '../hooks/useStagedDraft'
import { estimateSheetSpan, scaleToText } from '../utils/scale'
import { downloadJson } from '../utils/export'
import PairRow from '../components/common/PairRow.vue'
import ScanCard from '../components/common/ScanCard.vue'
import VacantHint from '../components/common/VacantHint.vue'
import CommitPointBar from '../components/common/CommitPointBar.vue'
import CommitLogPanel from '../components/common/CommitLogPanel.vue'

const route = useRoute()
const sheetStore = useSheetStore()
const placeStore = usePlaceStore()
const commitStore = useCommitStore()
const searchKeyword = ref('')
const { hits } = usePlaceSearch(searchKeyword)
const showScanForm = ref(false)
const showEditForm = ref(false)

const sheetId = computed(() => String(route.params.id ?? ''))
useSheetCommitSync(sheetId)

const sheet = computed(() => {
  const current = sheetStore.currentSheet
  return current?.id === sheetId.value ? current : undefined
})
const relatedPlaces = computed(() => placeStore.getPairsForSheet(sheetId.value))
const relatedHits = computed(() => hits.value.filter((hit) => hit.pair.sheetId === sheetId.value))
const spanEstimate = computed(() => (sheet.value ? estimateSheetSpan(sheet.value.scale, sheet.value.sheetSizeCm) : undefined))

function createScanForm(): NewScanItem {
  return {
    sheetId: sheetId.value,
    fileName: '',
    resolutionDpi: 600,
    colorMode: '彩色',
    pieces: 1,
    quality: '清晰',
    storageNote: '',
    importedAt: new Date().toISOString(),
    isPrimary: false,
  }
}

const scanForm = reactive<NewScanItem>(createScanForm())
const scanFormError = ref('')
const scanSubmitting = ref(false)

const scanDraft = useStagedDraft<NewScanItem>({
  draftKey: computed(() => `draft:scan:${sheetId.value}`),
  sheetId,
  form: scanForm,
  isBlank: (form) => !form.fileName.trim() && !form.storageNote.trim(),
  onResumed: () => {
    showScanForm.value = true
  },
})

function resetScanForm(): void {
  Object.assign(scanForm, createScanForm())
  scanFormError.value = ''
}

async function submitScan(): Promise<void> {
  if (!scanForm.fileName.trim() || !scanForm.storageNote.trim()) {
    scanFormError.value = '请填写扫描文件名与存放位置。'
    return
  }
  scanSubmitting.value = true
  try {
    const { outcome } = await sheetStore.addScan({
      ...scanForm,
      sheetId: sheetId.value,
      fileName: scanForm.fileName.trim(),
      storageNote: scanForm.storageNote.trim(),
    })
    if (!outcome.ok) {
      // 写入已整体回滚，主档停在上一提交点；草稿保留，可直接重试。
      ElMessage.error(`保存失败，已恢复到上一提交点：${outcome.error}`)
      return
    }
    if (outcome.conflicts.length) {
      ElMessage.warning('与另一页签的改动撞车，该扫描件已进入待核台，主档未改动。')
      return
    }
    await scanDraft.discard()
    resetScanForm()
    showScanForm.value = false
    ElMessage.success(`已作为第 ${outcome.seq} 个提交点保存，双方步骤均已保留。`)
  } finally {
    scanSubmitting.value = false
  }
}

// ---- 图幅与四至修订 -------------------------------------------------------

type SheetEditForm = Omit<Sheet, 'neighborCodes' | 'rowRev'> & { neighborCodesText: string }

function createEditForm(source?: Sheet): SheetEditForm {
  return {
    id: source?.id ?? sheetId.value,
    code: source?.code ?? '',
    title: source?.title ?? '',
    year: source?.year ?? 1935,
    scale: source?.scale ?? '1:5000',
    projection: source?.projection ?? '',
    sheetSizeCm: source?.sheetSizeCm ?? '',
    series: source?.series ?? '',
    status: source?.status ?? '待编',
    neighborCodesText: (source?.neighborCodes ?? []).join('、'),
  }
}

const editForm = reactive<SheetEditForm>(createEditForm())
const editFormError = ref('')
const editSubmitting = ref(false)

const editDraft = useStagedDraft<SheetEditForm>({
  draftKey: computed(() => `draft:sheet-edit:${sheetId.value}`),
  sheetId,
  form: editForm,
  isBlank: (form) => !form.title.trim() && !form.projection.trim(),
  onResumed: () => {
    showEditForm.value = true
  },
})

function openEditForm(): void {
  if (!sheet.value) {
    return
  }
  Object.assign(editForm, createEditForm(sheet.value))
  showEditForm.value = true
}

async function submitSheetEdit(): Promise<void> {
  if (!editForm.code.trim() || !editForm.title.trim() || !editForm.projection.trim()) {
    editFormError.value = '请填写图幅号、题名与投影方式。'
    return
  }
  const baseSheet = sheetStore.getSheetById(sheetId.value)
  if (!baseSheet) {
    editFormError.value = '主档中找不到该图幅，请刷新后重试。'
    return
  }
  editSubmitting.value = true
  try {
    // 始终以上一提交点的最新主档为基准携带行版本，避免拿陈旧版本覆盖。
    const nextSheet: Sheet = {
      id: baseSheet.id,
      code: editForm.code.trim(),
      title: editForm.title.trim(),
      year: editForm.year,
      scale: editForm.scale,
      projection: editForm.projection.trim(),
      sheetSizeCm: editForm.sheetSizeCm.trim(),
      series: editForm.series.trim(),
      neighborCodes: editForm.neighborCodesText
        .split(/[、,，]/)
        .map((code) => code.trim())
        .filter(Boolean),
      status: editForm.status,
    }
    const outcome = await sheetStore.updateSheet(nextSheet)
    if (!outcome.ok) {
      ElMessage.error(`保存失败，已恢复到上一提交点：${outcome.error}`)
      return
    }
    if (outcome.conflicts.length) {
      ElMessage.warning('另一页签也修订了同一图幅卡，你的改动已进入待核台裁定。')
      return
    }
    await editDraft.discard()
    showEditForm.value = false
    editFormError.value = ''
    ElMessage.success(`图幅修订已提交（提交点 ${outcome.seq}）。`)
  } finally {
    editSubmitting.value = false
  }
}

function exportSheet(): void {
  if (!sheet.value) {
    return
  }
  downloadJson(`${sheet.value.code}-编目.json`, {
    sheet: sheet.value,
    scans: sheetStore.getScansForSheet(sheet.value.id),
    placePairs: relatedPlaces.value,
  })
}

async function initialize(): Promise<void> {
  await Promise.all([sheetStore.init(), placeStore.init(), commitStore.init()])
  await sheetStore.loadSheet(sheetId.value)
}

onMounted(() => {
  void initialize()
})

watch(sheetId, () => {
  resetScanForm()
  void sheetStore.loadSheet(sheetId.value)
})
</script>

<template>
  <section v-if="sheet" class="page" data-testid="detail-sheet">
    <CommitPointBar :sheet-id="sheet.id" />
    <el-alert
      v-if="commitStore.syncMessage"
      :title="commitStore.syncMessage"
      type="success"
      :closable="true"
      class="mb-12"
      @close="commitStore.syncMessage = ''"
    />

    <div class="detail-layout">
      <div>
        <header class="detail-hero">
          <span class="detail-hero__code">{{ sheet.code }} · {{ sheet.series }}</span>
          <h1>{{ sheet.title }}</h1>
          <p>{{ sheet.projection }}，图幅尺寸 {{ sheet.sheetSizeCm }}。现登记 {{ relatedPlaces.length }} 条地名对照。</p>
          <div class="detail-hero__tags">
            <el-tag type="warning" effect="dark">{{ sheet.year }} 年</el-tag>
            <el-tag type="info" effect="dark">{{ sheet.scale }}</el-tag>
            <el-tag effect="dark">{{ sheet.status }}</el-tag>
            <el-tag v-if="spanEstimate" effect="dark">
              约 {{ spanEstimate.widthKm }} × {{ spanEstimate.heightKm }} 公里
            </el-tag>
          </div>
        </header>

        <form v-if="showEditForm" class="inline-form" data-testid="form-sheet-edit" @submit.prevent="submitSheetEdit">
          <h2>修订图幅与四至</h2>
          <p class="muted">改动以整幅图卡提交；与另一页签同改一卡时进入待核，不会互相覆盖。</p>
          <div class="form-grid">
            <el-form-item label="图幅号" required>
              <input v-model="editForm.code" class="native-field" />
            </el-form-item>
            <el-form-item label="图幅题名" required>
              <input v-model="editForm.title" class="native-field" />
            </el-form-item>
            <el-form-item label="测绘年代" required>
              <input v-model.number="editForm.year" class="native-field" type="number" min="1800" max="2100" />
            </el-form-item>
            <el-form-item label="比例尺" required>
              <select v-model="editForm.scale" class="native-field">
                <option v-for="scale in SHEET_SCALES" :key="scale" :value="scale">{{ scale }}</option>
              </select>
            </el-form-item>
            <el-form-item label="投影方式" required>
              <input v-model="editForm.projection" class="native-field" />
            </el-form-item>
            <el-form-item label="所属图组">
              <input v-model="editForm.series" class="native-field" />
            </el-form-item>
            <el-form-item label="整理状态">
              <select v-model="editForm.status" class="native-field">
                <option v-for="status in SHEET_STATUSES" :key="status" :value="status">{{ status }}</option>
              </select>
            </el-form-item>
            <el-form-item label="图幅尺寸">
              <input v-model="editForm.sheetSizeCm" class="native-field" />
            </el-form-item>
            <el-form-item label="四至邻接图号" class="form-grid__wide">
              <input v-model="editForm.neighborCodesText" class="native-field" placeholder="多个图号用中文顿号分隔" />
            </el-form-item>
            <div class="form-actions">
              <el-button @click="showEditForm = false">取消</el-button>
              <el-button type="primary" native-type="submit" :loading="editSubmitting" data-testid="submit-sheet-edit">
                提交图幅修订
              </el-button>
            </div>
          </div>
          <p v-if="editFormError" class="text-danger">{{ editFormError }}</p>
        </form>

        <div class="section-title">
          <div>
            <h2>扫描件条目</h2>
            <span class="muted">主用件优先作为地名核录与拼合基准</span>
          </div>
          <div class="section-title__actions">
            <el-button plain @click="openEditForm" data-testid="open-sheet-edit">修改图幅与四至</el-button>
            <el-button type="primary" plain @click="showScanForm = true">登记扫描件</el-button>
          </div>
        </div>

        <form v-if="showScanForm" class="inline-form" @submit.prevent="submitScan">
          <h2>登记扫描件</h2>
          <el-alert
            v-if="scanDraft.resumed.value"
            title="已恢复上次未提交的扫描件草稿，可接着补录后再提交。"
            type="info"
            :closable="false"
            class="mb-12"
          />
          <div class="form-grid">
            <el-form-item label="扫描文件名" required>
              <input v-model="scanForm.fileName" class="native-field" />
            </el-form-item>
            <el-form-item label="分辨率">
              <input v-model.number="scanForm.resolutionDpi" class="native-field" type="number" min="72" max="1200" />
            </el-form-item>
            <el-form-item label="色彩模式">
              <select v-model="scanForm.colorMode" class="native-field">
                <option v-for="mode in COLOR_MODES" :key="mode" :value="mode">{{ mode }}</option>
              </select>
            </el-form-item>
            <el-form-item label="分块数">
              <input v-model.number="scanForm.pieces" class="native-field" type="number" min="1" />
            </el-form-item>
            <el-form-item label="图像质量">
              <select v-model="scanForm.quality" class="native-field">
                <option v-for="quality in SCAN_QUALITIES" :key="quality" :value="quality">{{ quality }}</option>
              </select>
            </el-form-item>
            <el-form-item label="存放位置" required>
              <input v-model="scanForm.storageNote" class="native-field" />
            </el-form-item>
            <el-form-item label="设为主用件">
              <el-switch v-model="scanForm.isPrimary" />
            </el-form-item>
            <div class="form-actions">
              <el-button @click="showScanForm = false; resetScanForm()">取消</el-button>
              <el-button type="primary" native-type="submit" :loading="scanSubmitting">保存扫描件</el-button>
            </div>
          </div>
          <p v-if="scanFormError" class="text-danger">{{ scanFormError }}</p>
        </form>

        <div class="scan-list">
          <ScanCard v-for="scan in sheetStore.currentScans" :key="scan.id" :scan="scan" />
          <div v-if="sheetStore.currentScans.length === 0" class="empty-inline">该图幅尚未登记扫描件。</div>
        </div>
        <div v-if="sheetStore.currentScans.length" class="section-title">
          <span class="muted">主用件标记以同组操作提交，切换不会只改一半。</span>
          <div>
            <el-button
              v-for="scan in sheetStore.currentScans"
              :key="`primary-${scan.id}`"
              link
              :type="scan.isPrimary ? 'success' : 'primary'"
              :disabled="scan.isPrimary"
              @click="sheetStore.setPrimaryScan(scan.id)"
            >
              {{ scan.isPrimary ? '当前主用件' : `设为主用件：${scan.fileName}` }}
            </el-button>
          </div>
        </div>
      </div>

      <aside>
        <section class="side-panel">
          <h2>编目摘要</h2>
          <dl class="fact-list">
            <div><dt>图幅号</dt><dd>{{ sheet.code }}</dd></div>
            <div><dt>所属图组</dt><dd>{{ sheet.series }}</dd></div>
            <div><dt>年代</dt><dd>{{ sheet.year }} 年</dd></div>
            <div><dt>比例尺</dt><dd>{{ sheet.scale }}</dd></div>
            <div><dt>比例尺说明</dt><dd>{{ scaleToText(sheet.scale) }}</dd></div>
            <div><dt>投影</dt><dd>{{ sheet.projection }}</dd></div>
            <div><dt>尺寸</dt><dd>{{ sheet.sheetSizeCm }}</dd></div>
            <div v-if="spanEstimate"><dt>估算跨度</dt><dd>{{ spanEstimate.longitudeSpan }} × {{ spanEstimate.latitudeSpan }}</dd></div>
            <div><dt>扫描件</dt><dd>{{ sheetStore.currentScans.length }} 件</dd></div>
            <div><dt>地名对照</dt><dd>{{ relatedPlaces.length }} 条</dd></div>
          </dl>
          <div class="mt-20">
            <router-link :to="`/sheets/${sheet.id}/neighbors`"><el-button>查看邻接与拼合预览</el-button></router-link>
            <el-button type="primary" plain @click="exportSheet">导出 JSON</el-button>
          </div>
        </section>
      </aside>
    </div>

    <section class="section-title">
      <div>
        <h2>图内地名核录</h2>
        <span class="muted">可检索本图幅的古名、今名、异写与图上方位。</span>
      </div>
      <el-input v-model="searchKeyword" clearable placeholder="检索本地名" style="width: 260px" />
    </section>

    <div v-if="relatedPlaces.length" class="place-list">
      <PairRow
        v-for="pair in relatedHits.length || !searchKeyword ? relatedPlaces : []"
        :key="pair.id"
        :pair="pair"
        :query="searchKeyword"
        :sheet-code="sheet.code"
      />
      <div v-if="searchKeyword && relatedHits.length === 0" class="empty-inline">本地名未检索到吻合记录。</div>
    </div>

    <CommitLogPanel class="mt-20" :sheet-id="sheet.id" />
  </section>

  <section v-else class="page">
    <h1>图幅详情</h1>
    <VacantHint title="未找到该图幅" description="图幅可能已被移除，请返回编目台重新选择。" />
  </section>
</template>

<style scoped>
.section-title__actions {
  display: flex;
  gap: 8px;
}

.form-grid__wide {
  grid-column: 1 / -1;
}

.mb-12 {
  margin-bottom: 12px;
}
</style>
