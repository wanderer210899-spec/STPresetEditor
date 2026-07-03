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
  EllipsisVerticalIcon,
  InformationCircleIcon,
  ViewColumnsIcon,
} from '@heroicons/vue/24/outline';
import { computed } from 'vue';
import { getEditorMode } from '../utils/host';
import { formatTokenCount } from '../utils/tokens';
import { usePresetStore } from '../stores/presetStore';
import { useSyncStore } from '../stores/syncStore';

// Initialize the preset store
const store = usePresetStore();

// A file-backed extension webview edits one local .json (not a library entry),
// so snapshots — which version a library preset — are hidden there. The web app
// and the standalone library editor both keep them.
const isFileMode = getEditorMode() === 'file';
const takeSnapshot = () => {
  if (store.createSnapshot()) {
    store.showToast(store.t('toolbar.snapshotTaken'), 'success');
  }
};

// Cloud sync status (Cloudflare KV) for the indicator
const sync = useSyncStore();
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

// File-link status (file webview only): how the OPEN FILE relates to the cloud
// library, pushed by the host after each folder reconcile. Shown instead of the
// generic library-sync label so "save/update" is legible at a glance.
const fileLinkState = computed(() => sync.fileLink?.state || 'unlinked');
// Whether the cloud (API key + Worker URL) is configured at all. Lets an
// unlinked file read as "connected — just not linked yet" instead of "offline".
const fileLinkConnected = computed(() => Boolean(sync.fileLink?.connected));
const fileLinkNotInLibrary = computed(
  () => fileLinkState.value === 'unlinked' || fileLinkState.value === 'localOnly',
);
const fileLinkLabel = computed(() => store.t(`fileLink.${fileLinkState.value}`));
const fileLinkTitle = computed(() => {
  // A local file that isn't in the library: the advice differs by whether the
  // cloud is even connected (connect first vs. link the folder).
  if (fileLinkNotInLibrary.value) {
    return store.t(fileLinkConnected.value ? 'fileLink.titleUnlinked' : 'fileLink.titleOffline');
  }
  const map = {
    synced: 'titleSynced',
    pending: 'titlePending',
    conflict: 'titleConflict',
  };
  return store.t(`fileLink.${map[fileLinkState.value] || 'titleUnlinked'}`);
});
const fileLinkDotClass = computed(() => {
  switch (fileLinkState.value) {
    case 'synced':
      return 'bg-green-500';
    case 'pending':
      return 'bg-amber-400 animate-pulse';
    case 'conflict':
      return 'bg-orange-500';
    case 'localOnly':
    case 'unlinked':
      // Connected but this local file isn't part of the library yet → blue
      // (actionable), not the dead grey that reads as "sync is broken".
      return fileLinkConnected.value ? 'bg-sky-500' : 'bg-gray-300 dark:bg-gray-600';
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
    <button class="btn-icon md:hidden" @click="store.toggleLeftSidebar()">
      <Bars3Icon class="h-6 w-6" />
    </button>

    <!-- Desktop: collapse / expand the prompt-library column -->
    <button
      class="btn-icon btn-icon-sm mr-1 hidden md:inline-flex"
      :class="{ 'btn-icon-active': store.desktopLeftOpen }"
      :title="store.t('toolbar.toggleLibrary')"
      :aria-pressed="store.desktopLeftOpen"
      @click="store.toggleDesktopLeft()"
    >
      <ViewColumnsIcon class="h-5 w-5" />
    </button>

    <!-- Desktop: Application Title (truncates so it never pushes buttons off) -->
    <h1
      class="mr-2 hidden min-w-0 flex-1 truncate text-base font-bold text-gray-800 md:block dark:text-gray-200"
    >
      {{ store.t('app.title') }}
    </h1>

    <!-- Mobile: Spacer to center the title -->
    <div class="flex-1 md:hidden"></div>

    <!-- Mobile: Centered Application Title -->
    <h1 class="absolute left-1/2 -translate-x-1/2 text-lg font-bold md:hidden">
      {{ store.t('app.titleMobile') }}
    </h1>

    <!-- Desktop: Action Buttons Group (one consistent secondary style) -->
    <div class="hidden items-center gap-2 md:flex">
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
      <!-- File-backed webview: the OPEN FILE's link/sync status. Everywhere else:
           the generic cloud-library sync status. -->
      <div
        v-if="isFileMode"
        class="mr-1 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"
        :title="fileLinkTitle"
      >
        <span class="inline-block h-2 w-2 rounded-full" :class="fileLinkDotClass"></span>
        <span class="hidden lg:inline">{{ fileLinkLabel }}</span>
      </div>
      <div
        v-else
        class="mr-1 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"
        :title="sync.statusLabel"
      >
        <span class="inline-block h-2 w-2 rounded-full" :class="syncDotClass"></span>
        <span class="hidden lg:inline">{{ sync.statusLabel }}</span>
      </div>
      <!-- Icon-only between md and lg (landscape phones / small tablets) so
           the row always fits; full labels return at lg. -->
      <button
        class="btn btn-sm btn-secondary"
        :title="store.t('toolbar.import')"
        @click="store.openImportModal()"
      >
        <ArrowDownTrayIcon class="h-4 w-4" />
        <span class="hidden lg:inline">{{ store.t('toolbar.import') }}</span>
      </button>
      <button
        class="btn btn-sm btn-secondary"
        :title="store.t('toolbar.export')"
        @click="store.openExportModal()"
      >
        <ArrowUpTrayIcon class="h-4 w-4" />
        <span class="hidden lg:inline">{{ store.t('toolbar.export') }}</span>
      </button>
      <button
        v-if="!isFileMode"
        class="btn btn-sm btn-secondary"
        :title="store.t('toolbar.snapshot')"
        @click="takeSnapshot"
      >
        <CameraIcon class="h-4 w-4" />
        <span class="hidden lg:inline">{{ store.t('toolbar.snapshot') }}</span>
      </button>
      <button
        class="btn btn-sm btn-secondary"
        :title="store.t('toolbar.presets')"
        @click="store.openPresetManager()"
      >
        <BookmarkIcon class="h-4 w-4" />
        <span class="hidden lg:inline">{{ store.t('toolbar.presets') }}</span>
      </button>
      <button
        class="btn btn-sm btn-secondary"
        :title="store.t('toolbar.settings')"
        @click="store.isSettingsModalOpen = true"
      >
        <Cog6ToothIcon class="h-4 w-4" />
        <span class="hidden lg:inline">{{ store.t('toolbar.settings') }}</span>
      </button>
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
    <div class="flex items-center md:hidden">
      <!-- Cloud sync status dot (file webview shows the open file's link state) -->
      <span
        class="mr-1 inline-block h-2 w-2 rounded-full"
        :class="isFileMode ? fileLinkDotClass : syncDotClass"
        :title="isFileMode ? fileLinkTitle : sync.statusLabel"
      ></span>
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
              <MenuItem v-if="!isFileMode" v-slot="{ active }">
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
