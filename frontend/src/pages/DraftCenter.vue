<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useSheetStore } from '../stores/sheetStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import VacantHint from '../components/common/VacantHint.vue'

const sheetStore = useSheetStore()
const workspaceStore = useWorkspaceStore()
const busySheet = ref<string | null>(null)
const drillFailure = ref(false)

onMounted(async () => {
  await Promise.all([sheetStore.init(), workspaceStore.init()])
})

const rows = computed(() =>
  workspaceStore.workspaces
    .filter((ws) => ws.ops.length > 0)
    .map((ws) => ({
      ws,
      sheet: sheetStore.getSheetById(ws.sheetId),
      mine: ws.tabId === workspaceStore.tabId,
      stale: workspaceStore.headSeqBySheet[ws.sheetId] > ws.baseSeq,
    })),
)

const allSheetIds = computed(() => sheetStore.sheets.map((sheet) => sheet.id))

async function commit(sheetId: string): Promise<void> {
  busySheet.value = sheetId
  try {
    const result = await workspaceStore.commit(sheetId, undefined, drillFailure.value)
    await sheetStore.reload()
    if (drillFailure.value) {
      ElMessage.success('演练通过：写入中途失败，主档与暂存均保持在上一提交点')
    } else if (result.conflictCount > 0) {
      ElMessage.warning(`已提交，${result.conflictCount} 处冲突进入待核`)
    } else {
      ElMessage.success('已按图幅提交')
    }
  } catch (error) {
    await sheetStore.reload()
    ElMessage.warning(`提交中断（事务已整体回滚）：${(error as Error).message}`)
  } finally {
    busySheet.value = null
  }
}

async function adopt(sheetId: string, ownerTabId: string): Promise<void> {
  await workspaceStore.adoptWorkspace(sheetId, ownerTabId)
  ElMessage.success('已把该页签遗留步骤接至当前页签')
}

async function discard(sheetId: string, ownerTabId: string): Promise<void> {
  await workspaceStore.discardWorkspace(sheetId, ownerTabId)
  ElMessage.info('已放弃暂存步骤')
}

async function repair(sheetId: string): Promise<void> {
  busySheet.value = sheetId
  try {
    await workspaceStore.repair(sheetId)
    await sheetStore.reload()
    ElMessage.success('已从上一提交点恢复并重放全部已提交步骤')
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    busySheet.value = null
  }
}
</script>

<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <span class="page-kicker">DRAFTS &amp; RECOVERY</span>
        <h1>草稿与恢复</h1>
        <p>
          本页签未提交的步骤按图幅保存在本地，刷新或重开页签后仍可接着处理；
          其它页签关闭后遗留的草稿可接管。写入失败时从该图幅上一提交点恢复。
        </p>
      </div>
      <div>
        <el-checkbox v-model="drillFailure" border>故障演练：提交时在落盘前中断</el-checkbox>
      </div>
    </div>

    <div v-if="rows.length" class="draft-list">
      <article v-for="item in rows" :key="item.ws.id" class="draft-card" data-testid="row-draft">
        <header class="draft-card__head">
          <div>
            <el-tag :type="item.mine ? 'success' : 'info'" effect="plain">
              {{ item.mine ? '当前页签' : '其它页签遗留' }}
            </el-tag>
            <strong>{{ item.sheet?.code ?? item.ws.sheetId }} · {{ item.sheet?.title ?? '图幅' }}</strong>
          </div>
          <span class="muted">
            {{ item.ws.tabLabel }} · 基于第 {{ item.ws.baseSeq }} 次提交
            <el-tag v-if="item.stale" type="warning" size="small" style="margin-left: 6px">
              已有新提交，将重放
            </el-tag>
          </span>
        </header>

        <ol class="draft-card__ops">
          <li v-for="(op, index) in item.ws.ops" :key="`${op.recordId ?? op.type}-${index}`">{{ op.label }}</li>
        </ol>

        <div class="draft-card__actions">
          <router-link :to="`/sheets/${item.ws.sheetId}`"><el-button>打开图幅</el-button></router-link>
          <el-button :loading="busySheet === item.ws.sheetId" @click="repair(item.ws.sheetId)">
            从上一提交点恢复
          </el-button>
          <el-button v-if="!item.mine" @click="adopt(item.ws.sheetId, item.ws.tabId)">接管草稿</el-button>
          <el-button @click="discard(item.ws.sheetId, item.ws.tabId)">放弃</el-button>
          <el-button
            v-if="item.mine"
            type="primary"
            :loading="busySheet === item.ws.sheetId"
            @click="commit(item.ws.sheetId)"
          >提交本图幅</el-button>
        </div>
      </article>
    </div>

    <VacantHint
      v-else
      title="暂无暂存步骤"
      description="在图幅详情改图幅、补扫描件，或在地名、沿革页补记录时，步骤会先暂存于此，再按图幅提交。"
    />

    <section v-if="allSheetIds.length" class="repair-strip">
      <div class="section-title">
        <h2>逐图幅恢复</h2>
        <span class="muted">怀疑主档与提交记录不一致时，可对任意图幅从上一提交点重放校准。</span>
      </div>
      <div class="repair-buttons">
        <el-button
          v-for="sheet in sheetStore.sheets"
          :key="sheet.id"
          size="small"
          :loading="busySheet === sheet.id"
          @click="repair(sheet.id)"
        >{{ sheet.code }}</el-button>
      </div>
    </section>
  </section>
</template>

<style scoped>
.draft-card {
  margin-bottom: 16px;
  padding: 16px 20px;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow);
}

.draft-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.draft-card__head strong {
  margin-left: 10px;
}

.draft-card__ops {
  margin: 10px 0;
  padding-left: 22px;
  color: var(--ink);
  font-size: 14px;
}

.draft-card__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.repair-strip {
  margin-top: 28px;
}

.repair-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
