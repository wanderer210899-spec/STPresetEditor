<template>
  <BaseModal :show="isOpen" :title="store.t('presetManager.title')" size="2xl" @close="closeModal">
    <template #header-actions>
      <button class="btn btn-sm btn-secondary" @click="openImportModal">
        <ArrowDownTrayIcon class="h-4 w-4" />
        {{ store.t('presetManager.import') }}
      </button>
      <button class="btn btn-sm btn-secondary" @click="openExportModal">
        <ArrowUpTrayIcon class="h-4 w-4" />
        {{ store.t('presetManager.export') }}
      </button>
    </template>

    <!-- Save current preset section -->
    <div class="mb-6">
      <h4 class="mb-3 text-sm font-medium text-gray-900">
        {{ store.t('presetManager.saveCurrent') }}
      </h4>
      <div class="flex items-center gap-3">
        <div
          class="flex-1 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700"
        >
          {{ store.getCurrentPresetName }}
        </div>
        <button class="btn btn-primary" @click="saveCurrentPreset">
          <BookmarkIcon class="h-4 w-4" />
          {{ store.t('presetManager.save') }}
        </button>
      </div>
      <p class="mt-2 text-xs text-gray-500">{{ store.t('presetManager.autoNameNote') }}</p>
    </div>

    <!-- Factory settings management -->
    <div class="mb-6">
      <h4 class="mb-3 text-sm font-medium text-gray-900">
        {{ store.t('presetManager.factorySettings.title') }}
      </h4>
      <div class="flex items-center gap-3">
        <button class="btn btn-secondary" @click="saveFactoryAsDefault">
          <BookmarkIcon class="h-4 w-4" />
          {{ store.t('presetManager.factorySettings.addDefaultPreset') }}
        </button>
        <button
          class="btn btn-secondary"
          :disabled="!store.defaultPresetId"
          @click="loadDefaultPreset"
        >
          <ArrowDownTrayIcon class="h-4 w-4" />
          {{ store.t('presetManager.factorySettings.loadDefaultPreset') }}
        </button>
      </div>
    </div>

    <!-- Saved presets list -->
    <div>
      <div class="mb-3 flex items-center justify-between gap-2">
        <h4 class="text-sm font-medium text-gray-900">
          {{ store.t('presetManager.savedPresets') }}
        </h4>
        <div class="flex items-center gap-2">
          <input
            v-model="presetSearchTerm"
            type="text"
            :placeholder="store.t('presetManager.searchPlaceholder')"
            class="input input-sm w-48"
          />
          <select v-model="presetSortBy" class="input input-sm w-auto">
            <option value="updated">{{ store.t('presetManager.sortByUpdated') }}</option>
            <option value="created">{{ store.t('presetManager.sortByCreated') }}</option>
            <option value="name">{{ store.t('presetManager.sortByName') }}</option>
          </select>
          <button
            class="btn btn-sm"
            :class="store.presetMultiSelectActive ? 'btn-primary' : 'btn-secondary'"
            @click="togglePresetMultiSelect"
          >
            {{ store.t('presetManager.multiSelect') }}
          </button>
        </div>
      </div>

      <!-- Multi-select controls -->
      <div
        v-if="store.presetMultiSelectActive"
        class="mb-3 flex items-center justify-between rounded-lg bg-blue-50 p-3"
      >
        <div class="flex items-center gap-2">
          <button class="btn btn-sm btn-ghost" @click="selectAllPresets">
            {{ store.t('presetManager.selectAll') }}
          </button>
          <button class="btn btn-sm btn-ghost" @click="deselectAllPresets">
            {{ store.t('presetManager.deselectAll') }}
          </button>
          <span v-if="store.selectedPresetsCount > 0" class="text-sm text-gray-600">
            ({{ store.selectedPresetsCount }} {{ store.t('presetManager.selected') }})
          </span>
        </div>
        <button
          v-if="store.selectedPresets.size > 0"
          class="btn btn-sm btn-danger"
          @click="deleteSelectedPresets"
        >
          <TrashIcon class="h-4 w-4" />
          {{ store.t('presetManager.deleteSelected') }}
        </button>
      </div>

      <div v-if="store.savedPresetsList.length === 0" class="py-8 text-center text-gray-500">
        {{ store.t('presetManager.noPresets') }}
      </div>
      <div v-else class="max-h-96 space-y-2 overflow-y-auto">
        <div
          v-for="preset in store.savedPresetsList"
          :key="preset.id"
          class="flex items-center justify-between rounded-lg border border-gray-200 p-4 hover:bg-gray-50"
          :class="{
            'border-blue-200 bg-blue-50': preset.id === store.currentPresetId,
            'border-yellow-200 bg-yellow-50':
              store.presetMultiSelectActive && store.isPresetSelected(preset.id),
          }"
        >
          <div class="flex flex-1 items-center">
            <div v-if="store.presetMultiSelectActive" class="mr-3">
              <input
                type="checkbox"
                :checked="store.isPresetSelected(preset.id)"
                class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                @change="togglePresetSelection(preset.id)"
              />
            </div>
            <div class="flex-1">
              <div class="flex items-center">
                <h5 class="text-sm font-medium text-gray-900">{{ preset.name }}</h5>
                <span
                  v-if="preset.id === store.currentPresetId"
                  class="ml-2 inline-flex items-center rounded-full bg-blue-100 px-2 py-1 text-xs font-medium text-blue-800"
                >
                  {{ store.t('presetManager.current') }}
                </span>
              </div>
              <p class="mt-1 text-xs text-gray-500">
                {{ store.t('presetManager.created') }}: {{ formatDate(preset.createdAt) }}
                {{ store.t('presetManager.updated') }}: {{ formatDate(preset.updatedAt) }}
              </p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="btn btn-sm btn-primary"
              :disabled="preset.id === store.currentPresetId"
              @click="loadPreset(preset.id)"
            >
              <ArrowDownTrayIcon class="h-3.5 w-3.5" />
              {{ store.t('presetManager.load') }}
            </button>
            <button class="btn btn-sm btn-secondary" @click="startRename(preset)">
              <PencilIcon class="h-3.5 w-3.5" />
              {{ store.t('presetManager.rename') }}
            </button>
            <button class="btn btn-sm btn-secondary" @click="duplicatePreset(preset)">
              <DocumentDuplicateIcon class="h-3.5 w-3.5" />
              {{ store.t('presetManager.duplicate') }}
            </button>
            <button class="btn btn-sm btn-danger" @click="deletePreset(preset.id)">
              <TrashIcon class="h-3.5 w-3.5" />
              {{ store.t('presetManager.delete') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </BaseModal>

  <!-- Rename modal -->
  <BaseModal
    :show="isRenameModalOpen"
    :title="store.t('presetManager.renamePreset')"
    size="sm"
    @close="cancelRename"
  >
    <input
      ref="renameInput"
      v-model="renameValue"
      type="text"
      class="input"
      @keyup.enter="confirmRename"
    />
    <template #footer>
      <button class="btn btn-secondary" @click="cancelRename">
        {{ store.t('presetManager.cancel') }}
      </button>
      <button class="btn btn-primary" @click="confirmRename">
        {{ store.t('presetManager.rename') }}
      </button>
    </template>
  </BaseModal>
</template>

<script setup>
import {
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  BookmarkIcon,
  DocumentDuplicateIcon,
  PencilIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline';
import { nextTick, ref, watch } from 'vue';
import { usePresetStore } from '../stores/presetStore';
import BaseModal from './BaseModal.vue';

defineProps({
  isOpen: {
    type: Boolean,
    default: false,
  },
});

const store = usePresetStore();

const isRenameModalOpen = ref(false);
const renameValue = ref('');
const renamePresetId = ref(null);
const renameInput = ref(null);

// Preset management reactive variables
const presetSearchTerm = ref('');
const presetSortBy = ref('updated');

const closeModal = () => {
  store.closePresetManager();
};

const openImportModal = () => {
  store.openImportModal();
};

const openExportModal = () => {
  store.openExportModal();
};

const saveCurrentPreset = () => {
  store.savePreset();
};

const saveFactoryAsDefault = () => {
  store.saveFactorySettingsAsDefault();
};

const loadDefaultPreset = () => {
  if (store.loadDefaultPreset()) {
    closeModal();
  }
};

const loadPreset = (presetId) => {
  if (store.loadPreset(presetId)) {
    closeModal();
  }
};

const startRename = (preset) => {
  renamePresetId.value = preset.id;
  renameValue.value = preset.name;
  isRenameModalOpen.value = true;
  nextTick(() => {
    renameInput.value?.focus();
    renameInput.value?.select();
  });
};

const confirmRename = () => {
  if (renameValue.value.trim() && renamePresetId.value) {
    store.updatePreset(renamePresetId.value, renameValue.value.trim());
    cancelRename();
  }
};

const cancelRename = () => {
  isRenameModalOpen.value = false;
  renameValue.value = '';
  renamePresetId.value = null;
};

const duplicatePreset = (preset) => {
  const newName = `${preset.name} (${store.t('presetManager.copy')})`;
  store.duplicatePreset(preset.id, newName);
};

const deletePreset = (presetId) => {
  store.requestConfirm({
    message: store.t('presetManager.deleteConfirm'),
    confirmLabel: store.t('common.delete'),
    danger: true,
    onConfirm: () => store.deletePreset(presetId),
  });
};

const formatDate = (dateString) => {
  const date = new Date(dateString);
  return (
    date.toLocaleDateString() +
    ' ' +
    date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
};

// Preset management methods
const togglePresetMultiSelect = () => {
  store.togglePresetMultiSelect();
};

const togglePresetSelection = (presetId) => {
  store.togglePresetSelection(presetId);
};

const selectAllPresets = () => {
  store.selectAllPresets();
};

const deselectAllPresets = () => {
  store.deselectAllPresets();
};

const deleteSelectedPresets = () => {
  store.deleteSelectedPresets();
};

// Watch for search and sort changes
watch(presetSearchTerm, (newValue) => {
  store.setPresetSearchTerm(newValue);
});

watch(presetSortBy, (newValue) => {
  store.setPresetSortBy(newValue);
});
</script>
