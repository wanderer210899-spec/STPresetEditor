<template>
  <BaseModal
    :show="store.confirmState.open"
    :title="store.confirmState.title"
    size="sm"
    @close="store.cancelConfirm()"
  >
    <p class="text-sm whitespace-pre-line text-gray-600">{{ store.confirmState.message }}</p>

    <label
      v-if="store.confirmState.showSkip"
      class="mt-4 flex items-center gap-2 text-sm text-gray-700"
    >
      <input
        type="checkbox"
        :checked="store.confirmState.skipChecked"
        class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        @change="store.setConfirmSkip($event.target.checked)"
      />
      {{ store.confirmState.skipLabel || store.t('common.dontAskAgain') }}
    </label>

    <template #footer>
      <button class="btn btn-secondary" @click="store.cancelConfirm()">
        {{ store.confirmState.cancelLabel }}
      </button>
      <button
        class="btn"
        :class="store.confirmState.danger ? 'btn-danger' : 'btn-primary'"
        @click="store.resolveConfirm()"
      >
        {{ store.confirmState.confirmLabel }}
      </button>
    </template>
  </BaseModal>
</template>

<script setup>
import { usePresetStore } from '../stores/presetStore';
import BaseModal from './BaseModal.vue';

const store = usePresetStore();
</script>
