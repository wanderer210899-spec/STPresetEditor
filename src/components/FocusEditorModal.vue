<template>
  <BaseModal :show="!!prompt" size="2xl" @close="store.closeFocusEditor()">
    <!-- Editable name as the heading; no identifier, maximum writing space -->
    <template #title>
      <input
        v-if="prompt"
        :value="prompt.name"
        class="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-lg font-semibold text-gray-900 hover:border-gray-200 focus:border-blue-500 focus:bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none dark:text-gray-100"
        :placeholder="store.t('promptDetails.name')"
        @input="updateName($event.target.value)"
      />
    </template>

    <MacroAutocompleteTextarea
      v-if="prompt"
      ref="editor"
      :model-value="prompt.content || ''"
      :readonly="!!prompt.marker"
      :rows="20"
      textarea-class="input h-[60vh] resize-none font-mono"
      @update:model-value="updateContent"
    />

    <template #footer-start>
      <span class="text-xs text-gray-400 dark:text-gray-500">
        {{ store.t('focusEditor.hint') }}
      </span>
    </template>
    <template #footer>
      <button class="btn btn-primary" @click="store.closeFocusEditor()">
        {{ store.t('common.close') }}
      </button>
    </template>
  </BaseModal>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { usePresetStore } from '../stores/presetStore';
import BaseModal from './BaseModal.vue';
import MacroAutocompleteTextarea from './MacroAutocompleteTextarea.vue';

const store = usePresetStore();

const prompt = computed(() =>
  store.focusEditorPromptId ? store.getPromptById(store.focusEditorPromptId) : null,
);

const editor = ref(null);

const updateName = (value) => {
  store.updatePromptDetail({ promptId: store.focusEditorPromptId, field: 'name', value });
};
const updateContent = (value) => {
  store.updatePromptDetail({ promptId: store.focusEditorPromptId, field: 'content', value });
};

// Focus the writing area when the editor opens.
watch(
  () => store.focusEditorPromptId,
  (id) => {
    if (id) nextTick(() => editor.value?.focus());
  },
);
</script>
