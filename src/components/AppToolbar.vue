<script setup>
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/vue';
import {
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  Bars3Icon,
  BookmarkIcon,
  Cog6ToothIcon,
  EllipsisVerticalIcon,
  InformationCircleIcon,
} from '@heroicons/vue/24/outline';
import { computed } from 'vue';
import { usePresetStore } from '../stores/presetStore';
import { useSyncStore } from '../stores/syncStore';

// Initialize the preset store
const store = usePresetStore();

// Cloud sync status (Cloudflare KV) for the indicator
const sync = useSyncStore();
const syncDotClass = computed(() => {
  if (!sync.cloudEnabled) return 'bg-gray-300';
  switch (sync.status) {
    case 'synced':
      return 'bg-green-500';
    case 'syncing':
      return 'bg-amber-400 animate-pulse';
    case 'error':
      return 'bg-red-500';
    default:
      return 'bg-gray-300';
  }
});

// Shared class for mobile dropdown menu items (kept neutral for consistency)
const menuItemClass = 'group flex w-full items-center rounded-md px-2 py-2 text-sm text-gray-900';

// Reset & Language now live in Settings modal
</script>

<template>
  <!-- Main toolbar container with responsive layout -->
  <div class="flex w-full items-center justify-between bg-white">
    <!-- Mobile: Left Sidebar Toggle Button -->
    <button class="btn-icon md:hidden" @click="store.toggleLeftSidebar()">
      <Bars3Icon class="h-6 w-6" />
    </button>

    <!-- Desktop: Application Title -->
    <h1 class="hidden text-base font-bold text-gray-800 md:block">{{ store.t('app.title') }}</h1>

    <!-- Mobile: Spacer to center the title -->
    <div class="flex-1 md:hidden"></div>

    <!-- Mobile: Centered Application Title -->
    <h1 class="absolute left-1/2 -translate-x-1/2 text-lg font-bold md:hidden">
      {{ store.t('app.titleMobile') }}
    </h1>

    <!-- Desktop: Action Buttons Group (one consistent secondary style) -->
    <div class="hidden items-center gap-2 md:flex">
      <!-- Cloud sync status indicator -->
      <div class="mr-1 flex items-center gap-1.5 text-xs text-gray-500" :title="sync.statusLabel">
        <span class="inline-block h-2 w-2 rounded-full" :class="syncDotClass"></span>
        <span class="hidden lg:inline">{{ sync.statusLabel }}</span>
      </div>
      <button class="btn btn-sm btn-secondary" @click="store.openImportModal()">
        <ArrowDownTrayIcon class="h-4 w-4" />
        {{ store.t('toolbar.import') }}
      </button>
      <button class="btn btn-sm btn-secondary" @click="store.openExportModal()">
        <ArrowUpTrayIcon class="h-4 w-4" />
        {{ store.t('toolbar.export') }}
      </button>
      <button class="btn btn-sm btn-secondary" @click="store.openPresetManager()">
        <BookmarkIcon class="h-4 w-4" />
        {{ store.t('toolbar.presets') }}
      </button>
      <button class="btn btn-sm btn-secondary" @click="store.isSettingsModalOpen = true">
        <Cog6ToothIcon class="h-4 w-4" />
        {{ store.t('toolbar.settings') }}
      </button>
    </div>

    <!-- Mobile: Action Group with Right Sidebar Toggle and Menu -->
    <div class="flex items-center md:hidden">
      <!-- Cloud sync status dot -->
      <span
        class="mr-1 inline-block h-2 w-2 rounded-full"
        :class="syncDotClass"
        :title="sync.statusLabel"
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
            class="absolute right-0 z-10 mt-2 w-56 origin-top-right divide-y divide-gray-100 rounded-md bg-white shadow-md ring-1 ring-gray-200 focus:outline-none"
          >
            <!-- Import / Export -->
            <div class="px-1 py-1">
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100' : '', menuItemClass]"
                  @click="store.openImportModal()"
                >
                  <ArrowDownTrayIcon class="mr-2 h-5 w-5 text-gray-500" />
                  {{ store.t('toolbar.importFromJson') }}
                </button>
              </MenuItem>
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100' : '', menuItemClass]"
                  @click="store.openExportModal()"
                >
                  <ArrowUpTrayIcon class="mr-2 h-5 w-5 text-gray-500" />
                  {{ store.t('toolbar.exportToJson') }}
                </button>
              </MenuItem>
            </div>
            <!-- Presets / Settings -->
            <div class="px-1 py-1">
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100' : '', menuItemClass]"
                  @click="store.openPresetManager()"
                >
                  <BookmarkIcon class="mr-2 h-5 w-5 text-gray-500" />
                  {{ store.t('toolbar.presets') }}
                </button>
              </MenuItem>
              <MenuItem v-slot="{ active }">
                <button
                  :class="[active ? 'bg-gray-100' : '', menuItemClass]"
                  @click="store.isSettingsModalOpen = true"
                >
                  <Cog6ToothIcon class="mr-2 h-5 w-5 text-gray-500" />
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
