<script setup>
import { DocumentIcon } from '@heroicons/vue/24/outline';
import { ref } from 'vue';
import { usePresetStore } from '../stores/presetStore';
import BaseModal from './BaseModal.vue';

const store = usePresetStore();
const jsonInput = ref('');
const fileInput = ref(null);
const isDragOver = ref(false);
const currentFilename = ref('');

function importJson() {
  try {
    // Basic validation
    JSON.parse(jsonInput.value);
  } catch {
    store.showToast(store.t('importModal.invalidContent'), 'error');
    return;
  }

  const result = store.importPresetWithDuplicateCheck(jsonInput.value, currentFilename.value);
  if (result?.result === 'failed') {
    store.showToast(store.t('importModal.invalidContent'), 'error');
    return;
  }

  // A name collision defers to the in-app confirm dialog, which reports the
  // outcome (overwrite vs. save-a-copy) via its own toast + closes the modal.
  if (result?.result === 'deferred') {
    return;
  }

  store.showToast(store.t('importModal.savedDone', { name: result?.name || '' }), 'success');
  store.closeImportModal();
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file && file.type === 'application/json') {
    readFileContent(file);
  } else {
    store.showToast(store.t('importModal.invalidFile'), 'error');
  }
}

function handleFileDrop(event) {
  event.preventDefault();
  isDragOver.value = false;

  const files = event.dataTransfer.files;
  if (files.length > 0) {
    const file = files[0];
    if (file.type === 'application/json') {
      readFileContent(file);
    } else {
      store.showToast(store.t('importModal.invalidDrop'), 'error');
    }
  }
}

function handleDragOver(event) {
  event.preventDefault();
  isDragOver.value = true;
}

function handleDragLeave(event) {
  event.preventDefault();
  isDragOver.value = false;
}

function readFileContent(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const content = e.target.result;
      // Validate JSON format before accepting content
      JSON.parse(content);
      jsonInput.value = content;
      currentFilename.value = file.name;
    } catch {
      store.showToast(store.t('importModal.invalidContent'), 'error');
    }
  };
  reader.readAsText(file);
}

function triggerFileInput() {
  fileInput.value.click();
}
</script>

<template>
  <BaseModal
    :show="store.isImportModalOpen"
    :title="store.t('importModal.title')"
    size="lg"
    @close="store.closeImportModal"
  >
    <p class="text-sm text-gray-500 dark:text-gray-400">{{ store.t('importModal.description') }}</p>

    <!-- File selection area -->
    <div class="mt-4">
      <div
        :class="[
          'relative rounded-lg border-2 border-dashed p-6 text-center transition-colors',
          isDragOver
            ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/30'
            : 'border-gray-300 hover:border-gray-400 dark:border-gray-600',
        ]"
        @dragover="handleDragOver"
        @dragleave="handleDragLeave"
        @drop="handleFileDrop"
      >
        <DocumentIcon class="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500" />
        <div class="mt-2">
          <p class="text-sm text-gray-600 dark:text-gray-400">
            {{ store.t('importModal.dragText') }}
            <button
              type="button"
              class="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
              @click="triggerFileInput"
            >
              {{ store.t('importModal.clickToSelect') }}
            </button>
          </p>
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {{ store.t('importModal.supportedFormat') }}
          </p>
        </div>
      </div>

      <!-- Hidden file input -->
      <input
        ref="fileInput"
        type="file"
        accept=".json,application/json"
        class="hidden"
        @change="handleFileSelect"
      />
    </div>

    <!-- Separator line -->
    <div class="mt-6 flex items-center">
      <div class="flex-1 border-t border-gray-300 dark:border-gray-600"></div>
      <span class="px-3 text-sm text-gray-500 dark:text-gray-400">
        {{ store.t('importModal.or') }}
      </span>
      <div class="flex-1 border-t border-gray-300 dark:border-gray-600"></div>
    </div>

    <!-- Text input area -->
    <div class="mt-4">
      <label class="field-label mb-2">{{ store.t('importModal.pasteContent') }}</label>
      <textarea
        v-model="jsonInput"
        class="input h-32 font-mono"
        :placeholder="store.t('importModal.placeholder')"
      />
    </div>

    <template #footer>
      <button type="button" class="btn btn-secondary" @click="store.closeImportModal">
        {{ store.t('importModal.cancel') }}
      </button>
      <button type="button" class="btn btn-primary" @click="importJson">
        {{ store.t('importModal.import') }}
      </button>
    </template>
  </BaseModal>
</template>
