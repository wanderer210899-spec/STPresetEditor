<script setup>
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/vue';
import {
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  Bars3Icon,
  BookmarkIcon,
  CameraIcon,
  Cog6ToothIcon,
  DocumentCheckIcon,
  EllipsisHorizontalIcon,
  EllipsisVerticalIcon,
  InformationCircleIcon,
  ViewColumnsIcon,
} from '@heroicons/vue/24/outline';
import { computed } from 'vue';
import { formatTokenCount } from '../utils/tokens';
import { usePresetStore } from '../stores/presetStore';
import { useSyncStore } from '../stores/syncStore';
import { syncNow } from '../stores/cloudSync';

// Initialize the preset store
const store = usePresetStore();

const takeSnapshot = () => {
  if (store.createSnapshot()) {
    store.showToast(store.t('toolbar.snapshotTaken'), 'success');
  }
};

// Explicit "Save now" for the current preset. Autosave already runs, so this
// just flushes the latest edit into the library entry (and to disk in the
// extension) and confirms it — the reassurance the file workflow expects.
const saveCurrent = () => {
  if (store.saveActivePreset()) store.showToast(store.t('toolbar.saved'), 'success');
};

// Cloud sync status (Cloudflare KV) for the indicator
const sync = useSyncStore();

// Manual "Sync now" (S2): force an immediate remote pull into the open editor,
// bypassing the focus/visibility/30s auto-pull (which a VS Code webview can miss
// when it reports itself hidden). Same conflict-safe merge as the auto-pull.
const doSyncNow = async () => {
  if (!sync.cloudEnabled) {
    store.showToast(store.t('sync.syncNowOffline'), 'info');
    return;
  }
  const pulled = await syncNow();
  store.showToast(
    store.t(pulled ? 'sync.syncNowPulled' : 'sync.syncNowUpToDate'),
    pulled ? 'success' : 'info',
  );
};
const syncDotClass = computed(() => {
  if (!sync.cloudEnabled) return 'bg-gray-300 dark:bg-gray-600';
  switch (sync.status) {
    case 'synced':
      return 'bg-green-500';
    case 'syncing':
      return 'bg-amber-400 animate-pulse';
    case 'conflict':
      return 'bg-orange-500';
    case 'error':
      return 'bg-red-500';
    default:
      return 'bg-gray-300 dark:bg-gray-600';
  }
});

// Undo/redo tooltips describe the step they would apply (F8a)
const undoTooltip = computed(() => {
  const label = store.undoLabel;
  return label ? `${store.t('history.undo')}: ${label}` : store.t('history.undo');
});
const redoTooltip = computed(() => {
  const label = store.redoLabel;
  return label ? `${store.t('history.redo')}: ${label}` : store.t('history.redo');
});

// Shared class for mobile dropdown menu items (kept neutral for consistency)
const menuItemClass =
  'group flex w-full items-center rounded-md px-2 py-2 text-sm text-gray-900 dark:text-gray-100';

// Reset & Language now live in Settings modal
</script>

<template>
  <!-- Main toolbar container with responsive layout -->
  <div class="flex w-full items-center justify-between bg-white dark:bg-gray-800">
    <!-- Mobile: Left Sidebar Toggle Button -->
    <button v-if="store.isMobile" class="btn-icon" @click="store.toggleLeftSidebar()">
      <Bars3Icon class="h-6 w-6" />
    </button>

    <!-- Desktop: collapse / expand the prompt-library column -->
    <button
      v-if="!store.isMobile"
      class="btn-icon btn-icon-sm mr-1 inline-flex"
      :class="{ 'btn-icon-active': store.desktopLeftOpen }"
      :title="store.t('toolbar.toggleLibrary')"
      :aria-pressed="store.desktopLeftOpen"
      @click="store.toggleDesktopLeft()"
    >
      <ViewColumnsIcon class="h-5 w-5" />
    </button>

    <!-- Desktop: Application Title (truncates so it never pushes buttons off) -->
    <h1
      v-if="!store.isMobile"
      class="mr-2 min-w-0 flex-1 truncate text-base font-bold text-gray-800 dark:text-gray-200"
    >
      {{ store.t('app.title') }}
    </h1>

    <!-- Mobile: Spacer to center the title -->
    <div v-if="store.isMobile" class="flex-1"></div>

    <!-- Mobile: Centered Application Title -->
    <h1 v-if="store.isMobile" class="absolute left-1/2 -translate-x-1/2 text-lg font-bold">
      {{ store.t('app.titleMobile') }}
    </h1>

    <!-- Desktop: Action Buttons Group (one consistent secondary style) -->
    <div v-if="!store.isMobile" class="flex items-center gap-2">
      <!-- Undo / redo (F8a) -->
      <button
        v-tooltip="undoTooltip"
        class="btn-icon btn-icon-sm"
        :disabled="!store.canUndo"
        @click="store.undo()"
      >
        <ArrowUturnLeftIcon class="h-4 w-4" />
      </button>
      <button
        v-tooltip="redoTooltip"
        class="btn-icon btn-icon-sm"
        :disabled="!store.canRedo"
        @click="store.redo()"
      >
        <ArrowUturnRightIcon class="h-4 w-4" />
      </button>
      <!-- Approximate token total of enabled, in-order prompts (F8d) -->
      <span
        class="hidden text-xs text-gray-400 tabular-nums lg:inline dark:text-gray-500"
        :title="store.t('toolbar.tokenTotalTitle')"
      >
        {{ store.t('toolbar.tokenTotal', { count: formatTokenCount(store.enabledTokenTotal) }) }}
      </span>
      <!-- Cloud-library sync status + click-to-"Sync now" (same everywhere now
           that the extension's open file syncs like the web app's active preset). -->
      <button
        type="button"
        class="mr-1 flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-gray-500 transition hover:bg-gray-100 disabled:hover:bg-transparent dark:text-gray-400 dark:hover:bg-gray-700/50"
        :title="sync.cloudEnabled ? store.t('sync.syncNow') : sync.statusLabel"
        :disabled="sync.status === 'syncing'"
        @click="doSyncNow"
      >
        <span class="inline-block h-2 w-2 rounded-full" :class="syncDotClass"></span>
        <span class="hidden lg:inline">{{ sync.statusLabel }}</span>
      </button>
      <!-- Save the current preset now (autosave already runs; this is the
           explicit "commit + confirm" the file workflow expects). Kept out front
           as an everyday essential. -->
      <button
        class="btn btn-sm btn-secondary"
        :title="store.t('toolbar.saveTitle')"
        @click="saveCurrent"
      >
        <DocumentCheckIcon class="h-4 w-4" />
        <span class="hidden lg:inline">{{ store.t('toolbar.save') }}</span>
      </button>
      <!-- Everything else lives under one "More" menu so the bar stays calm:
           Import, Export, Snapshot, Presets, Settings. -->
      <Menu as="div" class="relative">
        <MenuButton class="btn btn-sm btn-secondary" :title="store.t('toolbar.more')">
          <EllipsisHorizontalIcon class="h-4 w-4" />
          <span class="hidden lg:inline">{{ store.t('toolbar.more') }}</span>
        </MenuButton>
        <transition
          enter-active-class="transition duration-100 ease-out"
          enter-from-class="transform scale-95 opacity-0"
          enter-to-class="transform scale-100 opacity-100"
          leave-active-class="transition duration-75 ease-in"
          leave-from-class="transform scale-100 opacity-100"
          leave-to-class="transform scale-95 opacity-0"
        >
          <MenuItems
            class="absolute right-0 z-20 mt-2 w-56 origin-top-right divide-y divide-gray-100 rounded-md bg-white shadow-md ring-1 ring-gray-200 focus:outline-none dark:divide-gray-700 dark:bg-gray-800 dark:ring-gray-700"
          >
            <div class="px-1 py-1">
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                  @click="store.openImportModal()"
                >
                  <ArrowDownTrayIcon class="mr-2 h-5 w-5 text-gray-500 dark:text-gray-400" />
                  {{ store.t('toolbar.importFromJson') }}
                </button>
              </MenuItem>
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                  @click="store.openExportModal()"
                >
                  <ArrowUpTrayIcon class="mr-2 h-5 w-5 text-gray-500 dark:text-gray-400" />
                  {{ store.t('toolbar.exportToJson') }}
                </button>
              </MenuItem>
            </div>
            <div class="px-1 py-1">
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                  @click="takeSnapshot"
                >
                  <CameraIcon class="mr-2 h-5 w-5 text-gray-500 dark:text-gray-400" />
                  {{ store.t('toolbar.snapshot') }}
                </button>
              </MenuItem>
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                  @click="store.openPresetManager()"
                >
                  <BookmarkIcon class="mr-2 h-5 w-5 text-gray-500 dark:text-gray-400" />
                  {{ store.t('toolbar.presets') }}
                </button>
              </MenuItem>
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                  @click="store.isSettingsModalOpen = true"
                >
                  <Cog6ToothIcon class="mr-2 h-5 w-5 text-gray-500 dark:text-gray-400" />
                  {{ store.t('toolbar.settings') }}
                </button>
              </MenuItem>
            </div>
          </MenuItems>
        </transition>
      </Menu>
      <!-- Collapse / expand the details/variables column -->
      <button
        class="btn-icon btn-icon-sm"
        :class="{ 'btn-icon-active': store.desktopRightOpen }"
        :title="store.t('toolbar.toggleDetails')"
        :aria-pressed="store.desktopRightOpen"
        @click="store.toggleDesktopRight()"
      >
        <InformationCircleIcon class="h-5 w-5" />
      </button>
    </div>

    <!-- Mobile: Action Group with Right Sidebar Toggle and Menu -->
    <div v-if="store.isMobile" class="flex items-center">
      <!-- Cloud sync status dot — tap to "Sync now" -->
      <button
        type="button"
        class="mr-1 flex h-6 w-6 items-center justify-center rounded"
        :title="sync.cloudEnabled ? store.t('sync.syncNow') : sync.statusLabel"
        :disabled="sync.status === 'syncing'"
        @click="doSyncNow"
      >
        <span class="inline-block h-2 w-2 rounded-full" :class="syncDotClass"></span>
      </button>
      <!-- Right Sidebar Toggle Button -->
      <button class="btn-icon" @click="store.toggleRightSidebar()">
        <InformationCircleIcon class="h-6 w-6" />
      </button>

      <!-- Mobile Menu Dropdown -->
      <Menu as="div" class="relative">
        <MenuButton class="btn-icon">
          <EllipsisVerticalIcon class="h-6 w-6" />
        </MenuButton>
        <!-- Menu Transition Animation -->
        <transition
          enter-active-class="transition duration-100 ease-out"
          enter-from-class="transform scale-95 opacity-0"
          enter-to-class="transform scale-100 opacity-100"
          leave-active-class="transition duration-75 ease-in"
          leave-from-class="transform scale-100 opacity-100"
          leave-to-class="transform scale-95 opacity-0"
        >
          <MenuItems
            class="absolute right-0 z-10 mt-2 w-56 origin-top-right divide-y divide-gray-100 rounded-md bg-white shadow-md ring-1 ring-gray-200 focus:outline-none dark:divide-gray-700 dark:bg-gray-800 dark:ring-gray-700"
          >
            <!-- Undo / Redo -->
            <div class="px-1 py-1">
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                  :disabled="!store.canUndo"
                  @click="store.undo()"
                >
                  <ArrowUturnLeftIcon class="mr-2 h-5 w-5 text-gray-500 dark:text-gray-400" />
                  {{ store.t('history.undo') }}
                </button>
              </MenuItem>
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                  :disabled="!store.canRedo"
                  @click="store.redo()"
                >
                  <ArrowUturnRightIcon class="mr-2 h-5 w-5 text-gray-500 dark:text-gray-400" />
                  {{ store.t('history.redo') }}
                </button>
              </MenuItem>
            </div>
            <!-- Import / Export -->
            <div class="px-1 py-1">
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                  @click="store.openImportModal()"
                >
                  <ArrowDownTrayIcon class="mr-2 h-5 w-5 text-gray-500 dark:text-gray-400" />
                  {{ store.t('toolbar.importFromJson') }}
                </button>
              </MenuItem>
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                  @click="store.openExportModal()"
                >
                  <ArrowUpTrayIcon class="mr-2 h-5 w-5 text-gray-500 dark:text-gray-400" />
                  {{ store.t('toolbar.exportToJson') }}
                </button>
              </MenuItem>
            </div>
            <!-- Presets / Settings -->
            <div class="px-1 py-1">
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                  @click="saveCurrent"
                >
                  <DocumentCheckIcon class="mr-2 h-5 w-5 text-gray-500 dark:text-gray-400" />
                  {{ store.t('toolbar.save') }}
                </button>
              </MenuItem>
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                  @click="takeSnapshot"
                >
                  <CameraIcon class="mr-2 h-5 w-5 text-gray-500 dark:text-gray-400" />
                  {{ store.t('toolbar.snapshot') }}
                </button>
              </MenuItem>
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                  @click="store.openPresetManager()"
                >
                  <BookmarkIcon class="mr-2 h-5 w-5 text-gray-500 dark:text-gray-400" />
                  {{ store.t('toolbar.presets') }}
                </button>
              </MenuItem>
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                  @click="store.isSettingsModalOpen = true"
                >
                  <Cog6ToothIcon class="mr-2 h-5 w-5 text-gray-500 dark:text-gray-400" />
                  {{ store.t('toolbar.settings') }}
                </button>
              </MenuItem>
            </div>
          </MenuItems>
        </transition>
      </Menu>
    </div>
  </div>
</template>
