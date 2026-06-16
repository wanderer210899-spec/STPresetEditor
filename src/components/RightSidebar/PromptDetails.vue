<template>
  <div v-if="prompt" class="space-y-4">
    <h3 class="section-title">{{ store.t('promptDetails.title') }}</h3>

    <!-- Inline editable fields -->
    <PromptFields :prompt="prompt" id-prefix="pd" :content-rows="8" :auto-grow="true">
      <template #content-action>
        <button class="btn btn-sm btn-secondary" @click="store.openDetailsModal()">
          <ArrowsPointingOutIcon class="h-3.5 w-3.5" />
          {{ store.t('promptDetails.expand') }}
        </button>
      </template>
    </PromptFields>

    <!-- Expanded editor in a modal (same fields, larger content area) -->
    <DetailsModal
      :is-open="store.isDetailsModalOpen"
      :title="`${store.t('promptDetails.title')} - ${prompt.name}`"
    >
      <PromptFields :prompt="prompt" id-prefix="pd-modal" :content-rows="14" />
    </DetailsModal>
  </div>
</template>

<script setup>
import { ArrowsPointingOutIcon } from '@heroicons/vue/24/outline';
import { usePresetStore } from '../../stores/presetStore';
import DetailsModal from '../DetailsModal.vue';
import PromptFields from './PromptFields.vue';

defineProps({
  prompt: {
    type: Object,
    required: true,
  },
});

const store = usePresetStore();
</script>
