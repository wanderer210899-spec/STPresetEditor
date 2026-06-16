<template>
  <div v-if="prompt" class="space-y-4">
    <h3 class="section-title">{{ store.t('promptDetails.title') }}</h3>

    <!-- Inline editable fields; "Expand" opens the distraction-free focus editor -->
    <PromptFields :prompt="prompt" id-prefix="pd" :content-rows="8" :auto-grow="true">
      <template #content-action>
        <button class="btn btn-sm btn-secondary" @click="store.openFocusEditor(prompt.id)">
          <ArrowsPointingOutIcon class="h-3.5 w-3.5" />
          {{ store.t('promptDetails.expand') }}
        </button>
      </template>
    </PromptFields>
  </div>
</template>

<script setup>
import { ArrowsPointingOutIcon } from '@heroicons/vue/24/outline';
import { usePresetStore } from '../../stores/presetStore';
import PromptFields from './PromptFields.vue';

defineProps({
  prompt: {
    type: Object,
    required: true,
  },
});

const store = usePresetStore();
</script>
