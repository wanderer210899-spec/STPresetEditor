<template>
  <div class="space-y-4">
    <div>
      <label :for="`${idPrefix}-name`" class="field-label">
        {{ store.t('promptDetails.name') }}
      </label>
      <input
        :id="`${idPrefix}-name`"
        type="text"
        :value="prompt.name"
        class="input mt-1"
        @input="update('name', $event.target.value)"
      />
    </div>
    <div>
      <label :for="`${idPrefix}-id`" class="field-label">
        {{ store.t('promptDetails.identifier') }}
      </label>
      <input
        :id="`${idPrefix}-id`"
        type="text"
        :value="prompt.identifier"
        readonly
        class="input mt-1 cursor-not-allowed bg-gray-100"
      />
    </div>
    <div>
      <div class="mb-1 flex items-center justify-between">
        <label :for="`${idPrefix}-content`" class="field-label">
          {{ store.t('promptDetails.content') }}
        </label>
        <slot name="content-action" />
      </div>
      <MacroAutocompleteTextarea
        :id="`${idPrefix}-content`"
        :model-value="prompt.content || ''"
        :rows="contentRows"
        :readonly="!!prompt.marker"
        :auto-grow="autoGrow"
        :textarea-class="contentClass"
        @update:model-value="update('content', $event)"
      />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { usePresetStore } from '../../stores/presetStore';
import MacroAutocompleteTextarea from '../MacroAutocompleteTextarea.vue';

const props = defineProps({
  prompt: { type: Object, required: true },
  // Unique prefix so duplicated instances (inline + modal) don't share input ids
  idPrefix: { type: String, default: 'prompt' },
  contentRows: { type: [Number, String], default: 8 },
  autoGrow: { type: Boolean, default: false },
});

const store = usePresetStore();

const update = (field, value) => {
  store.updatePromptDetail({ promptId: props.prompt.id, field, value });
};

const contentClass = computed(() =>
  [
    'input font-mono',
    props.autoGrow ? 'resize-none overflow-hidden' : '',
    props.prompt.marker ? 'cursor-not-allowed bg-gray-100' : '',
  ]
    .filter(Boolean)
    .join(' '),
);
</script>
