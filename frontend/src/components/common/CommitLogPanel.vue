<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { CommitRecord } from '../../types/commit'
import { useCommitStore } from '../../stores/commitStore'
import { formatDateTime, opKindText, opSubject } from '../../utils/describe'

const props = defineProps<{ sheetId: string }>()
const commitStore = useCommitStore()
const commits = ref<CommitRecord[]>([])
const expandedId = ref('')

async function reload(): Promise<void> {
  commits.value = (await commitStore.commitsForSheet(props.sheetId)).slice().reverse()
}

onMounted(() => void reload())
watch(
  () => commitStore.sheetHeads[props.sheetId],
  () => void reload(),
)

function toggle(id: string): void {
  expandedId.value = expandedId.value === id ? '' : id
}
</script>

<template>
  <section class="commit-log">
    <div class="section-title">
      <div>
        <h2>按图幅提交的操作记录</h2>
        <span class="muted">每个页签的改动按提交点保留并重放，待核步骤可在待核台裁定。</span>
      </div>
    </div>

    <el-timeline v-if="commits.length">
      <el-timeline-item
        v-for="commit in commits"
        :key="commit.id"
        :timestamp="formatDateTime(commit.createdAt)"
        placement="top"
        :color="commit.kind === 'bootstrap' ? '#9a8f80' : '#526b59'"
      >
        <div class="commit-log__head" @click="toggle(commit.id)">
          <span class="commit-log__seq">#{{ commit.seq }}</span>
          <strong>{{ commit.label }}</strong>
          <el-tag size="small" :type="commit.appliedOpCount < commit.ops.length ? 'danger' : 'success'">
            {{ commit.appliedOpCount }}/{{ commit.ops.length }} 步已重放
          </el-tag>
          <el-tag v-if="commit.kind === 'bootstrap'" size="small" effect="plain">建账</el-tag>
          <span class="muted commit-log__tab">{{ commit.tabId === 'bootstrap' ? '建账' : `页签 ${commit.tabId.slice(-6)}` }}</span>
        </div>
        <p v-if="commit.note" class="muted commit-log__note">{{ commit.note }}</p>
        <ul v-if="expandedId === commit.id" class="commit-log__ops">
          <li v-for="op in commit.ops" :key="op.clientId">
            <el-tag size="small" effect="plain">{{ opKindText(op.kind) }}</el-tag>
            <span>{{ opSubject(op) }}</span>
            <span class="muted">行版本基准 {{ op.baseRowRev }}</span>
          </li>
        </ul>
      </el-timeline-item>
    </el-timeline>
    <div v-else class="empty-inline">该图幅尚无提交记录。</div>
  </section>
</template>

<style scoped>
.commit-log__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  cursor: pointer;
}

.commit-log__seq {
  font-weight: 700;
  color: #8b3f2f;
}

.commit-log__tab {
  font-size: 12px;
}

.commit-log__note {
  margin: 6px 0 0;
  font-size: 13px;
}

.commit-log__ops {
  margin: 8px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.commit-log__ops li {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
