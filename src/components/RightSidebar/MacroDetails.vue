<template>
  <div v-if="variableInfo" class="space-y-4">
    <h3 class="section-title">{{ store.t('macroDetails.title') }}</h3>

    <div>
      <label class="field-label">{{ store.t('macroDetails.variable') }}</label>
      <div
        class="mt-1 block w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 shadow-sm dark:border-gray-600 dark:bg-gray-800"
      >
        <span class="font-mono text-sm">{{ variableName }}</span>
      </div>
    </div>

    <!-- Roomy lists when the right pane is maximized (F7), dense otherwise -->
    <VariableUsageList
      :label="store.t('macroDetails.definedIn')"
      :count="variableInfo.definedIn.length"
      :items="variableInfo.definedIn"
      variant="defined"
      :dense="!store.isRightPaneMaximized"
      :empty-text="store.t('macroDetails.notDefinedAnywhere')"
      empty-is-error
      @navigate="navigateTo"
    />

    <VariableUsageList
      :label="store.t('macroDetails.referencedIn')"
      :count="variableInfo.referencedIn.length"
      :items="variableInfo.referencedIn"
      variant="referenced"
      :dense="!store.isRightPaneMaximized"
      :empty-text="store.t('macroDetails.notReferencedByAnyPrompt')"
      @navigate="navigateTo"
    />

    <!-- Execution-order timeline (F4c) -->
    <VariableTimeline :name="variableName" />
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { usePresetStore } from '../../stores/presetStore';
import VariableTimeline from './VariableTimeline.vue';
import VariableUsageList from './VariableUsageList.vue';

const store = usePresetStore();

const variableName = computed(() => store.selectedMacro?.variableName);
const variableInfo = computed(() => {
  if (!variableName.value) return null;
  return store.variables[variableName.value] || { definedIn: [], referencedIn: [] };
});

const navigateTo = (promptId) => {
  store.navigateToPrompt(promptId);
};
</script>
