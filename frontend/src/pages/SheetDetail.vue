<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useSheetStore, type NewScanItem } from '../stores/sheetStore'
import { usePlaceStore } from '../stores/placeStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import type { Sheet, SheetScale, SheetStatus } from '../types/sheet'
import { SHEET_SCALES, SHEET_STATUSES } from '../types/sheet'
import type { ColorMode, ScanQuality } from '../types/scan'
import { COLOR_MODES, SCAN_QUALITIES } from '../types/scan'
import type { CommitRecord } from '../types/commit'
import { usePlaceSearch } from '../hooks/usePlaceSearch'
import { estimateSheetSpan, scaleToText } from '../utils/scale'
import { downloadJson } from '../utils/export'
import { buildSheetPatch } from '../utils/ops'
import PairRow from '../components/common/PairRow.vue'
import ScanCard from '../components/common/ScanCard.vue'
import VacantHint from '../components/common/VacantHint.vue'

const route = useRoute()
const router = useRouter()
const sheetStore = useSheetStore()
const placeStore = usePlaceStore()
const workspaceStore = useWorkspaceStore()
const searchKeyword = ref('')
const { hits } = usePlaceSearch(searchKeyword)
const showScanForm = ref(false)
const showSheetForm = ref(false)
const submitting = ref(false)
const commitLog = ref<CommitRecord[]>([])

const sheetId = computed(() => String(route.params.id ?? ''))
const sheet = computed(() => {
  const current = sheetStore.currentSheet
  return current?.id === sheetId.value ? current : undefined
})
const relatedPlaces = computed(() => placeStore.getPairsForSheet(sheetId.value))
const relatedHits = computed(() => hits.value.filter((hit) => hit.pair.sheetId === sheetId.value))
const spanEstimate = computed(() => (sheet.value ? estimateSheetSpan(sheet.value.scale, sheet.value.sheetSizeCm) : undefined))

const draftOps = computed(() => workspaceStore.opsFor(sheetId.value))
const draftWorkspace = computed(() => workspaceStore.workspaceFor(sheetId.value))
const draftStale = computed(() => workspaceStore.isStale(sheetId.value))

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

function resetScanForm(): void {
  Object.assign(scanForm, createScanForm())
  scanFormError.value = ''
}

async function submitScan(): Promise<void> {
  if (!scanForm.fileName.trim() || !scanForm.storageNote.trim()) {
    scanFormError.value = '请填写扫描文件名与存放位置。'
    return
  }
  await sheetStore.addScan({
    ...scanForm,
    sheetId: sheetId.value,
    fileName: scanForm.fileName.trim(),
    storageNote: scanForm.storageNote.trim(),
  })
  resetScanForm()
  showScanForm.value = false
  ElMessage.info('扫描件已记入待提交步骤，提交后才写入主档')
}

// —— 图幅与四至编辑 ——
type SheetEditForm = {
  code: string
  title: string
  year: number
  scale: SheetScale
  projection: string
  sheetSizeCm: string
  series: string
  neighborCodes: string
  status: SheetStatus
}

function createSheetEditForm(source: Sheet): SheetEditForm {
  return {
    code: source.code,
    title: source.title,
    year: source.year,
    scale: source.scale,
    projection: source.projection,
    sheetSizeCm: source.sheetSizeCm,
    series: source.series,
    neighborCodes: source.neighborCodes.join('、'),
    status: source.status,
  }
}

const sheetForm = reactive<SheetEditForm>({
  code: '',
  title: '',
  year: 1935,
  scale: '1:5000',
  projection: '',
  sheetSizeCm: '',
  series: '',
  neighborCodes: '',
  status: '待编',
})
const sheetFormError = ref('')

function openSheetForm(): void {
  if (!sheet.value) {
    return
  }
  Object.assign(sheetForm, createSheetEditForm(sheet.value))
  sheetFormError.value = ''
  showSheetForm.value = true
}

async function submitSheetPatch(): Promise<void> {
  if (!sheet.value) {
    return
  }
  if (!sheetForm.code.trim() || !sheetForm.title.trim() || !sheetForm.year || !sheetForm.projection.trim()) {
    sheetFormError.value = '请填写图幅号、题名、年代与投影方式。'
    return
  }
  const before = createSheetEditForm(sheet.value)
  const after = {
    ...sheetForm,
    code: sheetForm.code.trim(),
    title: sheetForm.title.trim(),
    projection: sheetForm.projection.trim(),
    series: sheetForm.series.trim() || sheet.value.series,
    neighborCodes: sheetForm.neighborCodes
      .split(/[、,，]/)
      .map((code) => code.trim())
      .filter(Boolean),
  }
  const { patch, beforePatch, changedKeys } = buildSheetPatch(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>)
  if (changedKeys.length === 0) {
    showSheetForm.value = false
    return
  }
  await workspaceStore.stageSheetPatch(sheetId.value, patch, beforePatch)
  // 本地即时反映暂存后的图幅卡（仍可放弃）
  Object.assign(sheet.value, patch)
  showSheetForm.value = false
  ElMessage.info('图幅改动已记入待提交步骤')
}

async function commitWorkspace(): Promise<void> {
  submitting.value = true
  try {
    const result = await workspaceStore.commit(sheetId.value)
    await sheetStore.reload()
    await sheetStore.loadSheet(sheetId.value)
    await loadCommitLog()
    if (result.conflictCount > 0) {
      ElMessage.warning(`双方步骤均已保留重放，${result.conflictCount} 处同改进入待核`)
      router.push('/review')
    } else {
      ElMessage.success('已按图幅提交，主档推进到新提交点')
    }
  } catch (error) {
    await sheetStore.reload()
    await sheetStore.loadSheet(sheetId.value)
    ElMessage.error(`提交失败，已从上一提交点恢复：${(error as Error).message}`)
  } finally {
    submitting.value = false
  }
}

async function loadCommitLog(): Promise<void> {
  commitLog.value = await workspaceStore.commitsForSheet(sheetId.value)
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

async function setPrimary(scanId: string): Promise<void> {
  await sheetStore.setPrimaryScan(scanId)
  ElMessage.info('主用件切换已记入待提交步骤')
}

async function discardDraft(): Promise<void> {
  await workspaceStore.discardWorkspace(sheetId.value)
  // 放弃暂存后回到主档（上一提交点）视图
  await sheetStore.reload()
  await sheetStore.loadSheet(sheetId.value)
  ElMessage.info('已放弃暂存步骤，图幅卡回到上一提交点')
}

async function initialize(): Promise<void> {
  await Promise.all([sheetStore.init(), placeStore.init(), workspaceStore.init()])
  await sheetStore.loadSheet(sheetId.value)
  await loadCommitLog()
}

onMounted(() => {
  void initialize()
})

watch(sheetId, async () => {
  resetScanForm()
  showSheetForm.value = false
  await sheetStore.loadSheet(sheetId.value)
  await loadCommitLog()
})
</script>

<template>
  <section v-if="sheet" class="page" data-testid="detail-sheet">
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

        <div class="section-title">
          <div>
            <h2>扫描件条目</h2>
            <span class="muted">主用件优先作为地名核录与拼合基准；补登记先暂存，随本图幅一并提交</span>
          </div>
          <div class="detail-toolbar">
            <el-button plain @click="openSheetForm">改图幅与四至</el-button>
            <el-button type="primary" plain @click="showScanForm = true">登记扫描件</el-button>
          </div>
        </div>

        <form v-if="showSheetForm" class="inline-form" @submit.prevent="submitSheetPatch">
          <h2>改图幅与四至（暂存一步）</h2>
          <div class="form-grid">
            <el-form-item label="图幅号" required>
              <input v-model="sheetForm.code" class="native-field" />
            </el-form-item>
            <el-form-item label="图幅题名" required>
              <input v-model="sheetForm.title" class="native-field" />
            </el-form-item>
            <el-form-item label="测绘年代" required>
              <input v-model.number="sheetForm.year" class="native-field" type="number" min="1800" max="2100" />
            </el-form-item>
            <el-form-item label="比例尺" required>
              <select v-model="sheetForm.scale" class="native-field">
                <option v-for="scale in SHEET_SCALES" :key="scale" :value="scale">{{ scale }}</option>
              </select>
            </el-form-item>
            <el-form-item label="投影方式" required>
              <input v-model="sheetForm.projection" class="native-field" />
            </el-form-item>
            <el-form-item label="所属图组" required>
              <input v-model="sheetForm.series" class="native-field" />
            </el-form-item>
            <el-form-item label="整理状态" required>
              <select v-model="sheetForm.status" class="native-field">
                <option v-for="status in SHEET_STATUSES" :key="status" :value="status">{{ status }}</option>
              </select>
            </el-form-item>
            <el-form-item label="图幅尺寸">
              <input v-model="sheetForm.sheetSizeCm" class="native-field" />
            </el-form-item>
            <el-form-item label="四至邻接图号" class="form-grid__wide">
              <input v-model="sheetForm.neighborCodes" class="native-field" placeholder="多个图号用顿号分隔" />
            </el-form-item>
            <div class="form-actions">
              <el-button @click="showSheetForm = false">取消</el-button>
              <el-button type="primary" native-type="submit">暂存图幅改动</el-button>
            </div>
          </div>
          <p v-if="sheetFormError" class="text-danger">{{ sheetFormError }}</p>
        </form>

        <form v-if="showScanForm" class="inline-form" @submit.prevent="submitScan">
          <h2>登记扫描件（暂存一步）</h2>
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
              <el-button type="primary" native-type="submit">暂存扫描件</el-button>
            </div>
          </div>
          <p v-if="scanFormError" class="text-danger">{{ scanFormError }}</p>
        </form>

        <!-- 本图幅暂存步骤：双方页签各自暂存，提交时保留重放 -->
        <section v-if="draftOps.length" class="draft-panel" data-testid="draft-panel">
          <div class="section-title">
            <div>
              <h2>待提交步骤（{{ draftOps.length }}）</h2>
              <span class="muted">
                基于第 {{ draftWorkspace?.baseSeq }} 次提交
                <el-tag v-if="draftStale" type="warning" size="small" style="margin-left: 6px">
                  另一页签已先提交，本次提交将保留双方步骤并重放
                </el-tag>
              </span>
            </div>
            <div>
              <el-button @click="discardDraft">全部放弃</el-button>
              <el-button type="primary" :loading="submitting" @click="commitWorkspace">
                按图幅提交
              </el-button>
            </div>
          </div>
          <ol class="draft-panel__ops">
            <li v-for="(op, index) in draftOps" :key="`${op.recordId ?? op.type}-${index}`">
              <span>{{ index + 1 }}. {{ op.label }}</span>
              <el-button link type="danger" @click="workspaceStore.removeOp(sheetId, index)">移出</el-button>
            </li>
          </ol>
        </section>

        <div class="scan-list">
          <ScanCard v-for="scan in sheetStore.getScansForSheet(sheet.id)" :key="scan.id" :scan="scan" />
          <div v-if="sheetStore.getScansForSheet(sheet.id).length === 0" class="empty-inline">该图幅尚未登记扫描件。</div>
        </div>
        <div v-if="sheetStore.getScansForSheet(sheet.id).length" class="section-title">
          <span class="muted">主用件标记可随时切换，切换作为一步暂存，提交时原子生效。</span>
          <div>
            <el-button
              v-for="scan in sheetStore.getScansForSheet(sheet.id)"
              :key="`primary-${scan.id}`"
              link
              :type="scan.isPrimary ? 'success' : 'primary'"
              :disabled="scan.isPrimary"
              @click="setPrimary(scan.id)"
            >
              {{ scan.isPrimary ? '当前主用件' : `设为主用件：${scan.fileName}` }}
            </el-button>
          </div>
        </div>

        <!-- 按图幅的提交操作记录 -->
        <section class="commit-log">
          <div class="section-title">
            <h2>提交记录</h2>
            <span class="muted">每次按图幅提交的操作步骤，冲突步骤亦完整保留</span>
          </div>
          <el-timeline>
            <el-timeline-item
              v-for="commit in commitLog"
              :key="commit.id"
              :timestamp="commit.seq === 0 ? '基线提交点' : `第 ${commit.seq} 次提交 · 基于第 ${commit.baseSeq} 次`"
              placement="top"
              :type="commit.conflictIndexes.length ? 'warning' : 'primary'"
            >
              <div class="timeline-commit">
                <strong>{{ commit.message }}</strong>
                <span class="muted">{{ commit.tabLabel }}</span>
              </div>
              <ul v-if="commit.ops.length" class="commit-log__ops">
                <li v-for="(op, index) in commit.ops" :key="index" :class="{ 'is-conflict': commit.conflictIndexes.includes(index) }">
                  {{ op.label }}
                  <el-tag v-if="commit.conflictIndexes.includes(index)" type="warning" size="small">冲突进待核</el-tag>
                </li>
              </ul>
            </el-timeline-item>
          </el-timeline>
        </section>
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
            <div><dt>四至</dt><dd>{{ sheet.neighborCodes.join('、') || '未登记' }}</dd></div>
            <div><dt>扫描件</dt><dd>{{ sheetStore.getScansForSheet(sheet.id).length }} 件</dd></div>
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
  </section>

  <section v-else class="page">
    <h1>图幅详情</h1>
    <VacantHint title="未找到该图幅" description="图幅可能已被移除，请返回编目台重新选择。" />
  </section>
</template>

<style scoped>
.detail-toolbar {
  display: flex;
  gap: 8px;
}

.form-grid__wide {
  grid-column: 1 / -1;
}

.draft-panel {
  margin: 14px 0 20px;
  padding: 14px 18px;
  background: #fdf7ec;
  border: 1px dashed #b48f5f;
  border-radius: 8px;
}

.draft-panel__ops {
  margin: 8px 0 0;
  padding-left: 0;
  list-style: none;
}

.draft-panel__ops li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 14px;
}

.commit-log {
  margin-top: 28px;
}

.timeline-commit {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.commit-log__ops {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 13px;
  color: var(--muted);
}

.commit-log__ops li {
  display: flex;
  align-items: center;
  gap: 8px;
}

.commit-log__ops li.is-conflict {
  color: var(--accent);
}
</style>
