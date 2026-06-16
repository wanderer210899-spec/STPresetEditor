<template>
  <!-- Inline panel rendered inside the right-pane overlay -->
  <div class="flex h-full flex-col space-y-2">
    <TabGroup>
      <TabList class="flex flex-shrink-0 space-x-1 rounded-xl bg-gray-200 p-1">
        <Tab v-for="tab in tabs" :key="tab.key" v-slot="{ selected }" as="template">
          <button
            :class="[
              'w-full rounded-lg py-2 text-sm leading-5 font-medium',
              'ring-white/60 ring-offset-2 ring-offset-blue-400 focus:ring-2 focus:outline-none',
              selected ? 'bg-white text-blue-700 shadow' : 'text-blue-700/60 hover:text-blue-700',
            ]"
          >
            {{ tab.label }}
          </button>
        </Tab>
      </TabList>

      <TabPanels class="rounded-xl bg-white shadow-sm">
        <!-- Replace tab -->
        <TabPanel :key="'replace'" class="p-4">
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label class="field-label mb-1">{{ store.t('batchReplaceModal.find') }}</label>
              <input v-model="form.find" type="text" class="input" />
            </div>
            <div>
              <label class="field-label mb-1">{{ store.t('batchReplaceModal.replaceWith') }}</label>
              <input v-model="form.replace" type="text" class="input" />
            </div>
          </div>

          <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div class="space-y-4">
              <div>
                <div class="field-label mb-2">{{ store.t('batchReplaceModal.targetFields') }}</div>
                <div class="space-y-2">
                  <label class="flex items-center gap-2">
                    <input v-model="form.targetFields.title" type="checkbox" />
                    <span>{{ store.t('batchReplaceModal.fieldTitle') }}</span>
                  </label>
                  <label class="flex items-center gap-2">
                    <input v-model="form.targetFields.content" type="checkbox" />
                    <span>{{ store.t('batchReplaceModal.fieldContent') }}</span>
                  </label>
                </div>
              </div>
              <div>
                <div class="field-label mb-2">{{ store.t('batchReplaceModal.scope') }}</div>
                <div class="space-y-2">
                  <label class="flex items-center gap-2">
                    <input
                      v-model="form.scope"
                      type="radio"
                      name="scope"
                      value="selected"
                      :disabled="
                        !store.isEditorMultiSelectActive || store.selectedEditorPrompts.length === 0
                      "
                    />
                    <span
                      :class="{
                        'text-gray-400':
                          !store.isEditorMultiSelectActive ||
                          store.selectedEditorPrompts.length === 0,
                      }"
                    >
                      {{ store.t('batchReplaceModal.scopeSelected') }}
                    </span>
                  </label>
                  <label class="flex items-center gap-2">
                    <input v-model="form.scope" type="radio" name="scope" value="all" />
                    <span>{{ store.t('batchReplaceModal.scopeAll') }}</span>
                  </label>
                </div>
              </div>
            </div>
            <div>
              <div class="field-label mb-2">{{ store.t('batchReplaceModal.options') }}</div>
              <div class="space-y-2">
                <label class="flex items-center gap-2">
                  <input v-model="form.useRegex" type="checkbox" />
                  <span>{{ store.t('batchReplaceModal.useRegex') }}</span>
                </label>
                <label class="flex items-center gap-2">
                  <input v-model="form.caseSensitive" type="checkbox" />
                  <span>{{ store.t('batchReplaceModal.caseSensitive') }}</span>
                </label>
                <label class="flex items-center gap-2">
                  <input v-model="form.wholeWord" type="checkbox" :disabled="form.useRegex" />
                  <span :class="{ 'text-gray-400': form.useRegex }">
                    {{ store.t('batchReplaceModal.wholeWord') }}
                  </span>
                </label>
              </div>
            </div>
          </div>
        </TabPanel>

        <!-- Additions tab -->
        <TabPanel :key="'additions'" class="p-4">
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <div class="field-label mb-2">{{ store.t('batchReplaceModal.addPrefix') }}</div>
              <div class="space-y-2">
                <label class="flex items-center gap-2">
                  <input v-model="form.addPrefix" type="checkbox" />
                  <span>{{ store.t('batchReplaceModal.addPrefix') }}</span>
                </label>
                <input
                  v-model="form.prefixText"
                  type="text"
                  :placeholder="store.t('batchReplaceModal.prefixText')"
                  class="input"
                  :disabled="!form.addPrefix"
                />
              </div>
            </div>
            <div>
              <div class="field-label mb-2">{{ store.t('batchReplaceModal.addSuffix') }}</div>
              <div class="space-y-2">
                <label class="flex items-center gap-2">
                  <input v-model="form.addSuffix" type="checkbox" />
                  <span>{{ store.t('batchReplaceModal.addSuffix') }}</span>
                </label>
                <input
                  v-model="form.suffixText"
                  type="text"
                  :placeholder="store.t('batchReplaceModal.suffixText')"
                  class="input"
                  :disabled="!form.addSuffix"
                />
              </div>
            </div>
          </div>

          <div class="mt-4">
            <div class="field-label mb-2">{{ store.t('batchReplaceModal.addSerial') }}</div>
            <div class="space-y-2">
              <label class="flex items-center gap-2">
                <input v-model="form.addSerial" type="checkbox" />
                <span>{{ store.t('batchReplaceModal.addSerial') }}</span>
              </label>
              <div class="flex items-center gap-4" :class="{ 'opacity-50': !form.addSerial }">
                <label class="flex items-center gap-2">
                  <input
                    v-model="form.serialPosition"
                    type="radio"
                    name="serialPosition"
                    value="before"
                    :disabled="!form.addSerial"
                  />
                  <span>{{ store.t('batchReplaceModal.serialBefore') }}</span>
                </label>
                <label class="flex items-center gap-2">
                  <input
                    v-model="form.serialPosition"
                    type="radio"
                    name="serialPosition"
                    value="after"
                    :disabled="!form.addSerial"
                  />
                  <span>{{ store.t('batchReplaceModal.serialAfter') }}</span>
                </label>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="mb-1 block text-xs text-gray-500">
                    {{ store.t('batchReplaceModal.serialStart') }}
                  </label>
                  <input
                    v-model.number="form.serialStart"
                    type="number"
                    min="0"
                    class="input"
                    :disabled="!form.addSerial"
                  />
                </div>
                <div>
                  <label class="mb-1 block text-xs text-gray-500">
                    {{ store.t('batchReplaceModal.serialDigits') }}
                  </label>
                  <input
                    v-model.number="form.serialDigits"
                    type="number"
                    min="1"
                    class="input"
                    :disabled="!form.addSerial"
                  />
                </div>
              </div>
            </div>
          </div>
        </TabPanel>
      </TabPanels>
    </TabGroup>

    <div v-if="errorMessage" class="mt-2 text-xs text-gray-500">{{ errorMessage }}</div>
    <div v-if="resultMessage" class="mt-2 text-xs text-gray-600">{{ resultMessage }}</div>

    <div class="mt-4 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          :disabled="!store.canUndoBatchReplace"
          @click="onUndo"
        >
          {{ store.t('batchReplaceModal.undo') }}
        </button>
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          :disabled="!store.canRedoBatchReplace"
          @click="onRedo"
        >
          {{ store.t('batchReplaceModal.redo') }}
        </button>
      </div>
      <div class="flex gap-3">
        <button type="button" class="btn btn-secondary" @click="store.closeBatchReplaceModal()">
          {{ store.t('batchReplaceModal.cancel') }}
        </button>
        <button type="button" class="btn btn-primary" @click="onReplace">
          {{ store.t('batchReplaceModal.replace') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from '@headlessui/vue';
import { reactive, ref } from 'vue';
import { usePresetStore } from '../../stores/presetStore';

const store = usePresetStore();

const tabs = [
  { key: 'replace', label: store.t('batchReplaceModal.title') },
  { key: 'additions', label: store.t('batchReplaceModal.additionsSection') },
];

const form = reactive({
  find: '',
  replace: '',
  targetFields: { title: true, content: true },
  scope: 'selected',
  useRegex: false,
  caseSensitive: false,
  wholeWord: false,
  addPrefix: false,
  prefixText: '',
  addSuffix: false,
  suffixText: '',
  addSerial: false,
  serialPosition: 'before',
  serialStart: 1,
  serialDigits: 2,
});

const errorMessage = ref('');
const resultMessage = ref('');

function onReplace() {
  errorMessage.value = '';
  resultMessage.value = '';
  const hasFind = Boolean(form.find);
  const hasAdditions = form.addPrefix || form.addSuffix || form.addSerial;
  if (!hasFind && !hasAdditions) {
    errorMessage.value = store.t('batchReplaceModal.noMatches');
    return;
  }
  if (!form.targetFields.title && !form.targetFields.content) {
    errorMessage.value = store.t('batchReplaceModal.noMatches');
    return;
  }
  // If scope is selected but none selected, show noMatches and stop
  if (form.scope === 'selected' && store.selectedEditorPrompts.length === 0) {
    resultMessage.value = store.t('batchReplaceModal.noMatches');
    return;
  }
  try {
    const summary = store.batchReplaceText({
      find: form.find,
      replace: form.replace,
      targetFields: { ...form.targetFields },
      scope: form.scope,
      useRegex: form.useRegex,
      caseSensitive: form.caseSensitive,
      wholeWord: form.wholeWord,
      addPrefix: form.addPrefix,
      prefixText: form.prefixText,
      addSuffix: form.addSuffix,
      suffixText: form.suffixText,
      addSerial: form.addSerial,
      serialPosition: form.serialPosition,
      serialStart: form.serialStart,
      serialDigits: form.serialDigits,
    });
    resultMessage.value = store.t('batchReplaceModal.resultSummary2', {
      matches: summary.matches,
      prompts: summary.prompts,
    });
  } catch (e) {
    if (e && e.message === 'INVALID_REGEX') {
      errorMessage.value = store.t('batchReplaceModal.invalidRegex');
    }
  }
}

function onUndo() {
  const result = store.undoLastBatchChange();
  if (result && result.prompts >= 0) {
    resultMessage.value = store.t('batchReplaceModal.resultSummary', {
      matches: 0,
      prompts: result.prompts,
    });
    errorMessage.value = '';
  }
}

function onRedo() {
  const result = store.redoLastBatchChange();
  if (result && result.prompts >= 0) {
    resultMessage.value = store.t('batchReplaceModal.resultSummary', {
      matches: 0,
      prompts: result.prompts,
    });
    errorMessage.value = '';
  }
}
</script>
