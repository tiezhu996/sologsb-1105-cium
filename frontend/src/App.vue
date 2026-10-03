<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import PendingTray from './components/common/PendingTray.vue'
import { usePlaceStore } from './stores/placeStore'
import { useHistoryStore } from './stores/historyStore'
import { useSheetStore } from './stores/sheetStore'
import { useWorkspaceStore } from './stores/workspaceStore'
import { commitBus } from './utils/bus'
import { ensureBaselines } from './utils/db'

const sheetStore = useSheetStore()
const placeStore = usePlaceStore()
const historyStore = useHistoryStore()
const workspaceStore = useWorkspaceStore()

const navigation = computed(() => [
  { label: '图幅编目台', to: '/sheets', hint: '编目与筛选', badge: 0 },
  { label: '地名对照台', to: '/places', hint: '古今与异写', badge: 0 },
  { label: '沿革时间线', to: '/places/place-bp-yi-3-1/history', hint: '年代脉络', badge: 0 },
  { label: '邻接拼合预览', to: '/sheets/sheet-bp-yi-3/neighbors', hint: '四至关系', badge: 0 },
  { label: '待核中心', to: '/review', hint: '同改裁定', badge: workspaceStore.pendingConflicts.length },
  { label: '草稿与恢复', to: '/drafts', hint: '续作与回档', badge: workspaceStore.myPendingCount },
])

async function syncAll(): Promise<void> {
  // 某页签提交后：所有页签回到上一提交点重载主档与提交状态
  await Promise.all([
    sheetStore.initialized ? sheetStore.reload() : Promise.resolve(),
    placeStore.initialized ? placeStore.reload() : Promise.resolve(),
    historyStore.initialized ? historyStore.reload() : Promise.resolve(),
    workspaceStore.reloadAll(),
  ])
}

let unsubscribe: (() => void) | null = null

onMounted(async () => {
  await ensureBaselines()
  await workspaceStore.init()
  unsubscribe = commitBus.subscribe(() => {
    void syncAll()
  })
  // 标签页重新获得焦点时也校准一次，兜底 BroadcastChannel 丢失
  window.addEventListener('focus', syncAll)
})

onUnmounted(() => {
  unsubscribe?.()
  window.removeEventListener('focus', syncAll)
})
</script>

<template>
  <div class="app-shell">
    <header class="site-header">
      <router-link class="brand" to="/sheets" aria-label="返回图幅编目台">
        <span class="brand__seal" aria-hidden="true">图</span>
        <span>
          <strong>老地图图幅编目台</strong>
          <small>gboldmap · 地方文献整理工具</small>
        </span>
      </router-link>
      <div class="site-header__status">
        <span class="status-dot" aria-hidden="true"></span>
        本地典藏数据 · 按图幅提交
      </div>
    </header>

    <aside class="site-nav" aria-label="主要导航">
      <p class="site-nav__eyebrow">整理工作台</p>
      <nav>
        <router-link v-for="item in navigation" :key="item.to" :to="item.to" class="nav-link">
          <span>{{ item.label }}</span>
          <small>{{ item.hint }}</small>
          <em v-if="item.badge" class="nav-badge" data-testid="nav-badge">{{ item.badge }}</em>
        </router-link>
      </nav>
      <div class="site-nav__foot">
        <svg viewBox="0 0 120 72" aria-hidden="true">
          <path d="M9 59h24V42h14v17h18V23h14v36h32" fill="none" stroke="currentColor" stroke-width="3" />
          <path d="M8 21l23-10 19 11 32-13 29 12v38l-29 10-32-12-19 11-23-10z" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M31 11v47M50 22v38M82 9v49" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 4" />
        </svg>
        <p>改动先暂存、按图幅提交；冲突进待核，主档停在上一提交点</p>
      </div>
    </aside>

    <main class="site-main">
      <router-view />
    </main>

    <PendingTray />
  </div>
</template>

<style scoped>
.nav-badge {
  position: absolute;
  top: 8px;
  right: 10px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  color: #fff5e7;
  background: #963f2c;
  border-radius: 9px;
  font-size: 11px;
  font-style: normal;
  line-height: 18px;
  text-align: center;
}
</style>
