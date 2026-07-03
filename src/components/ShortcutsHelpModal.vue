<template>
  <!-- Keyboard shortcuts reference (F8c), opened with `?` or from Settings -->
  <BaseModal
    :show="store.isShortcutsHelpOpen"
    :title="store.t('shortcuts.title')"
    size="md"
    @close="store.closeShortcutsHelp()"
  >
    <ul class="divide-y divide-gray-100 dark:divide-gray-700">
      <li v-for="row in rows" :key="row.label" class="flex items-center justify-between py-2">
        <span class="text-sm text-gray-700 dark:text-gray-300">{{ store.t(row.label) }}</span>
        <span class="flex items-center gap-1">
          <template v-for="(keyLabel, index) in row.keys" :key="index">
            <span v-if="index > 0" class="text-xs text-gray-400">+</span>
            <kbd
              class="rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
            >
              {{ keyLabel }}
            </kbd>
          </template>
        </span>
      </li>
    </ul>

    <template #footer>
      <button class="btn btn-secondary" @click="store.closeShortcutsHelp()">
        {{ store.t('common.close') }}
      </button>
    </template>
  </BaseModal>
</template>

<script setup>
import { usePresetStore } from '../stores/presetStore';
import BaseModal from './BaseModal.vue';

const store = usePresetStore();

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
const mod = isMac ? '⌘' : 'Ctrl';

const rows = [
  { keys: [mod, 'Z'], label: 'shortcuts.undo' },
  { keys: [mod, 'Shift', 'Z'], label: 'shortcuts.redo' },
  { keys: [mod, 'Y'], label: 'shortcuts.redoAlt' },
  { keys: [mod, 'F'], label: 'shortcuts.findInEditor' },
  { keys: [mod, 'K'], label: 'shortcuts.globalSearch' },
  { keys: [mod, 'S'], label: 'shortcuts.snapshot' },
  { keys: [mod, 'E'], label: 'shortcuts.toggleDisplayMode' },
  { keys: ['Alt', '↑ / ↓'], label: 'shortcuts.movePrompt' },
  { keys: ['N'], label: 'shortcuts.newPrompt' },
  { keys: ['?'], label: 'shortcuts.help' },
];
</script>
