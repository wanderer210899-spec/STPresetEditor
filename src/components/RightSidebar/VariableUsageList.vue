<template>
  <div>
    <div class="mb-1 flex items-center justify-between">
      <label class="field-label">{{ label }} ({{ count }})</label>
      <slot name="action" />
    </div>
    <div class="w-full">
      <ul v-if="items.length > 0" :class="listClass">
        <li
          v-for="(item, index) in items"
          :key="index"
          class="cursor-pointer rounded-md border transition-colors"
          :class="[itemPadding, itemClass, { '!border-gray-200 !bg-gray-100': !item.enabled }]"
          @click="$emit('navigate', item.promptId)"
        >
          <p class="text-sm font-medium" :class="[textClass, { '!text-gray-500': !item.enabled }]">
            {{ getPromptName(item.promptId) }}
          </p>
          <p class="font-mono text-xs text-gray-500 dark:text-gray-400">{{ item.promptId }}</p>
        </li>
      </ul>
      <div v-else-if="emptyIsError" class="rounded-md border border-red-200 bg-red-50 p-2">
        <p class="text-sm font-medium text-red-700 dark:text-red-300">{{ emptyText }}</p>
      </div>
      <p v-else class="mt-1 text-sm text-gray-500 italic dark:text-gray-400">{{ emptyText }}</p>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { usePresetStore } from '../../stores/presetStore';

const props = defineProps({
  label: { type: String, required: true },
  count: { type: Number, default: 0 },
  items: { type: Array, default: () => [] },
  variant: { type: String, default: 'defined' }, // 'defined' (blue) | 'referenced' (green)
  emptyText: { type: String, default: '' },
  emptyIsError: { type: Boolean, default: false },
  dense: { type: Boolean, default: false },
});

defineEmits(['navigate']);

const store = usePresetStore();

const getPromptName = (promptId) => {
  const prompt = store.getPromptById(promptId);
  return prompt ? prompt.name : store.t('macroDetails.unknownPrompt');
};

const itemClass = computed(() =>
  props.variant === 'referenced'
    ? 'border-green-200 bg-green-50 hover:bg-green-100'
    : 'border-blue-200 bg-blue-50 dark:bg-blue-900/30 hover:bg-blue-100',
);

const textClass = computed(() =>
  props.variant === 'referenced' ? 'text-green-800' : 'text-blue-800',
);

const itemPadding = computed(() => (props.dense ? 'p-2' : 'p-3'));
const listClass = computed(() =>
  props.dense ? 'space-y-2 max-h-32 overflow-y-auto' : 'space-y-3',
);
</script>
