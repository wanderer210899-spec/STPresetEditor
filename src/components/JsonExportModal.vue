<script setup>
import { ArrowDownTrayIcon, CheckIcon, ClipboardDocumentIcon } from '@heroicons/vue/24/outline';
import { computed, ref, watch } from 'vue';
import { usePresetStore } from '../stores/presetStore';
import BaseModal from './BaseModal.vue';

const store = usePresetStore();

const finalJson = computed(() => store.finalJson);
const copyButtonText = ref('');
const downloadButtonText = ref('');
const exportFilename = ref('');

// Initialize export filename
function initializeExportFilename() {
  exportFilename.value = store.generateExportFilename();
}

// When modal opens, initialize filename and button labels
watch(
  () => store.isExportModalOpen,
  (isOpen) => {
    if (isOpen) {
      initializeExportFilename();
      // Initialize button labels
      copyButtonText.value = store.t('exportModal.copy');
      downloadButtonText.value = store.t('exportModal.download');
    }
  },
);

async function copyToClipboard() {
  try {
    await navigator.clipboard.writeText(finalJson.value);
    copyButtonText.value = store.t('exportModal.copied');
    window.setTimeout(() => {
      copyButtonText.value = store.t('exportModal.copy');
    }, 2000);
  } catch (err) {
    console.error('Failed to copy: ', err);
    copyButtonText.value = store.t('exportModal.copyFailed');
  }
}

function downloadJsonFile() {
  try {
    const blob = new Blob([finalJson.value], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = exportFilename.value || 'preset.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    downloadButtonText.value = store.t('exportModal.downloaded');
    window.setTimeout(() => {
      downloadButtonText.value = store.t('exportModal.download');
    }, 2000);
  } catch (err) {
    console.error('Failed to download: ', err);
    downloadButtonText.value = store.t('exportModal.downloadFailed');
  }
}
</script>

<template>
  <BaseModal
    :show="store.isExportModalOpen"
    :title="store.t('exportModal.title')"
    size="lg"
    @close="store.closeExportModal"
  >
    <p class="text-sm text-gray-500 dark:text-gray-400">{{ store.t('exportModal.description') }}</p>

    <!-- Filename input section -->
    <div class="mt-4">
      <label class="field-label mb-2">{{ store.t('exportModal.filename') }}</label>
      <div class="flex gap-2">
        <input
          v-model="exportFilename"
          type="text"
          class="input flex-1"
          placeholder="preset.json"
        />
        <button type="button" class="btn btn-secondary shrink-0" @click="initializeExportFilename">
          {{ store.t('exportModal.autoGenerate') }}
        </button>
      </div>
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {{ store.t('exportModal.filenameHint') }}
      </p>
    </div>

    <div class="mt-4">
      <textarea
        :value="finalJson"
        readonly
        class="input h-64 bg-gray-50 font-mono dark:bg-gray-900"
      />
    </div>

    <template #footer>
      <button type="button" class="btn btn-secondary" @click="store.closeExportModal">
        {{ store.t('exportModal.cancel') }}
      </button>
      <button type="button" class="btn btn-secondary" @click="copyToClipboard">
        <ClipboardDocumentIcon
          v-if="copyButtonText === store.t('exportModal.copy')"
          class="h-5 w-5"
        />
        <CheckIcon v-else class="h-5 w-5" />
        {{ copyButtonText }}
      </button>
      <button type="button" class="btn btn-primary" @click="downloadJsonFile">
        <ArrowDownTrayIcon class="h-5 w-5" />
        {{ downloadButtonText }}
      </button>
    </template>
  </BaseModal>
</template>
