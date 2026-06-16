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
      <textarea
        :id="`${idPrefix}-content`"
        ref="contentTextarea"
        :value="prompt.content"
        :readonly="prompt.marker"
        :rows="contentRows"
        class="input font-mono"
        :class="[
          autoGrow ? 'resize-none overflow-hidden' : '',
          prompt.marker ? 'cursor-not-allowed bg-gray-100' : '',
        ]"
        @input="onContentInput"
      />
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue';
import { usePresetStore } from '../../stores/presetStore';

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

// Auto-grow logic for content textarea to remove the inner scrollbar
const contentTextarea = ref(null);
const adjustTextareaHeight = () => {
  if (!props.autoGrow) return;
  const el = contentTextarea.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
};

const onContentInput = (event) => {
  update('content', event.target.value);
  adjustTextareaHeight();
};

onMounted(() => {
  adjustTextareaHeight();
});

watch(
  () => props.prompt?.content,
  () => {
    adjustTextareaHeight();
  },
);
</script>
