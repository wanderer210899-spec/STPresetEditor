<template>
  <div v-if="variableInfo" class="space-y-4">
    <h3 class="section-title">{{ store.t('macroDetails.title') }}</h3>

    <div>
      <label class="field-label">{{ store.t('macroDetails.variable') }}</label>
      <div
        class="mt-1 block w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 shadow-sm"
      >
        <span class="font-mono text-sm">{{ variableName }}</span>
      </div>
    </div>

    <VariableUsageList
      :label="store.t('macroDetails.definedIn')"
      :count="variableInfo.definedIn.length"
      :items="variableInfo.definedIn"
      variant="defined"
      dense
      :empty-text="store.t('macroDetails.notDefinedAnywhere')"
      empty-is-error
      @navigate="navigateTo"
    />

    <VariableUsageList
      :label="store.t('macroDetails.referencedIn')"
      :count="variableInfo.referencedIn.length"
      :items="variableInfo.referencedIn"
      variant="referenced"
      dense
      :empty-text="store.t('macroDetails.notReferencedByAnyPrompt')"
      @navigate="navigateTo"
    >
      <template #action>
        <button class="btn btn-sm btn-secondary" @click="store.openDetailsModal()">
          <ArrowsPointingOutIcon class="h-3.5 w-3.5" />
          {{ store.t('macroDetails.expand') }}
        </button>
      </template>
    </VariableUsageList>

    <!-- Expanded view in a modal (same lists, roomier) -->
    <DetailsModal
      :is-open="store.isDetailsModalOpen"
      :title="`${store.t('macroDetails.title')} - ${variableName}`"
    >
      <div class="space-y-6">
        <div>
          <label class="field-label">{{ store.t('macroDetails.variable') }}</label>
          <div
            class="mt-1 block w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 shadow-sm"
          >
            <span class="font-mono text-lg">{{ variableName }}</span>
          </div>
        </div>

        <VariableUsageList
          :label="store.t('macroDetails.definedIn')"
          :count="variableInfo.definedIn.length"
          :items="variableInfo.definedIn"
          variant="defined"
          :empty-text="store.t('macroDetails.notDefinedAnywhere')"
          empty-is-error
          @navigate="navigateTo"
        />

        <VariableUsageList
          :label="store.t('macroDetails.referencedIn')"
          :count="variableInfo.referencedIn.length"
          :items="variableInfo.referencedIn"
          variant="referenced"
          :empty-text="store.t('macroDetails.notReferencedByAnyPrompt')"
          @navigate="navigateTo"
        />
      </div>
    </DetailsModal>
  </div>
</template>

<script setup>
import { ArrowsPointingOutIcon } from '@heroicons/vue/24/outline';
import { computed } from 'vue';
import { usePresetStore } from '../../stores/presetStore';
import DetailsModal from '../DetailsModal.vue';
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
