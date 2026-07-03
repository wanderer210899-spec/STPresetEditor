<template>
  <div class="flex h-full flex-col space-y-4">
    <!-- Variable List for Navigation -->
    <div class="flex-shrink-0 rounded-lg border border-gray-200 p-2 dark:border-gray-700">
      <!-- Header with next/prev use walkers (F4b) + stats -->
      <div
        class="mb-2 flex items-center justify-between border-b border-gray-200 pb-1 dark:border-gray-700"
      >
        <h4 class="px-2 text-base font-semibold">{{ store.t('variableManager.variableList') }}</h4>
        <div class="flex items-center gap-1 px-2">
          <!-- Walk the selected variable's timeline through the editor -->
          <template v-if="selectedVariable && selectedTimeline.length">
            <button
              v-tooltip="store.t('variableManager.prevUse')"
              class="btn-icon btn-icon-sm"
              @click="stepUse(-1)"
            >
              <ChevronUpIcon class="h-4 w-4" />
            </button>
            <span class="text-[10px] text-gray-400 tabular-nums dark:text-gray-500">
              {{ useIndex >= 0 ? useIndex + 1 : '–' }}/{{ selectedTimeline.length }}
            </span>
            <button
              v-tooltip="store.t('variableManager.nextUse')"
              class="btn-icon btn-icon-sm"
              @click="stepUse(1)"
            >
              <ChevronDownIcon class="h-4 w-4" />
            </button>
          </template>
          <!-- Stats display -->
          <span
            v-if="stats.unreferencedCount > 0"
            v-tooltip="store.t('variableManager.definedButNeverReferenced')"
            class="ml-2 flex items-center text-xs font-medium text-yellow-500"
          >
            <QuestionMarkCircleIcon class="mr-1 h-4 w-4" />
            {{ stats.unreferencedCount }}
          </span>
          <span
            v-if="stats.undefinedCount > 0"
            v-tooltip="store.t('variableManager.referencedButNeverDefined')"
            class="ml-2 flex items-center text-xs font-medium text-red-500"
          >
            <ExclamationCircleIcon class="mr-1 h-4 w-4" />
            {{ stats.undefinedCount }}
          </span>
        </div>
      </div>
      <div class="max-h-48 overflow-y-auto">
        <ul class="space-y-1">
          <li v-for="variable in variables" :key="`nav-${variable}`">
            <!-- Row click highlights the variable in the editor without leaving
                 this tab; the jump icon opens the full details view. -->
            <div
              class="group relative flex w-full cursor-pointer items-center justify-between gap-2 rounded-md p-2 text-left font-mono text-sm transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
              :class="{ 'bg-blue-50 dark:bg-blue-900/30': selectedVariable === variable }"
              role="button"
              tabindex="0"
              @click="highlightVariable(variable)"
              @keydown.enter="highlightVariable(variable)"
            >
              <div class="flex min-w-0 items-center">
                <VariableIcon class="mr-2 h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
                <span class="truncate">{{ variable }}</span>
                <!-- Unused variable icon -->
                <QuestionMarkCircleIcon
                  v-if="isDefinedButUnused(variable)"
                  v-tooltip="{
                    content: store.t('variableManager.definedButNeverReferenced'),
                    placement: 'top',
                  }"
                  class="ml-2 h-4 w-4 shrink-0 text-yellow-500"
                />
                <ExclamationCircleIcon
                  v-if="isUnresolved(variable)"
                  v-tooltip="{
                    content: store.t('variableManager.referencedButNeverDefined'),
                    placement: 'top',
                  }"
                  class="ml-2 h-4 w-4 shrink-0 text-red-500"
                />
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <!-- Simulated end value (F4b) -->
                <span
                  v-tooltip="{
                    content: `${store.t('variableManager.endValue')}: ${endValueOf(variable).text}`,
                    placement: 'top',
                  }"
                  class="max-w-28 truncate text-xs"
                  :class="
                    endValueOf(variable).dim
                      ? 'text-gray-400 italic dark:text-gray-500'
                      : 'text-gray-600 dark:text-gray-300'
                  "
                >
                  {{ endValueOf(variable).text }}
                </span>
                <button
                  v-tooltip="store.t('variableManager.openDetails')"
                  class="btn-icon btn-icon-sm md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                  @click.stop="goToVariableDetails(variable)"
                >
                  <ArrowTopRightOnSquareIcon class="h-4 w-4" />
                </button>
              </div>
            </div>
          </li>
        </ul>
      </div>
    </div>

    <!-- Rename Tool -->
    <div class="flex-grow rounded-lg border border-gray-200 p-3 dark:border-gray-700">
      <h4 class="mb-2 text-base font-semibold">{{ store.t('variableManager.renameVariable') }}</h4>
      <div class="space-y-4">
        <Combobox v-model="selectedVariableForRename" nullable>
          <div class="relative">
            <ComboboxLabel class="field-label">
              {{ store.t('variableManager.variableToRename') }}
            </ComboboxLabel>
            <div class="relative mt-1">
              <ComboboxInput
                class="input pr-10"
                :display-value="(variable) => variable"
                :placeholder="store.t('variableManager.selectVariable')"
                @change="query = $event.target.value"
              />
              <ComboboxButton
                class="absolute inset-y-0 right-0 flex items-center rounded-r-md px-2 focus:outline-none"
              >
                <ChevronUpDownIcon
                  class="h-5 w-5 text-gray-400 dark:text-gray-500"
                  aria-hidden="true"
                />
              </ComboboxButton>
            </div>
            <transition
              leave-active-class="transition duration-100 ease-in"
              leave-from-class="opacity-100"
              leave-to-class="opacity-0"
            >
              <ComboboxOptions
                class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md bg-white py-1 text-base shadow-lg ring-1 ring-black/5 focus:outline-none sm:text-sm dark:bg-gray-800"
              >
                <div
                  v-if="filteredVariables.length === 0 && query !== ''"
                  class="relative cursor-default px-4 py-2 text-gray-700 select-none dark:text-gray-300"
                >
                  {{ store.t('variableManager.nothingFound') }}
                </div>
                <ComboboxOption
                  v-for="variable in filteredVariables"
                  :key="`rename-${variable}`"
                  v-slot="{ active, selected }"
                  :value="variable"
                  as="template"
                >
                  <li
                    :class="[
                      'relative cursor-default py-2 pr-4 pl-10 select-none',
                      active ? 'bg-blue-600 text-white' : 'text-gray-900 dark:text-gray-100',
                    ]"
                  >
                    <span :class="['block truncate', selected ? 'font-medium' : 'font-normal']">
                      {{ variable }}
                    </span>
                    <span
                      v-if="selected"
                      :class="[
                        'absolute inset-y-0 left-0 flex items-center pl-3',
                        active ? 'text-white' : 'text-blue-600 dark:text-blue-400',
                      ]"
                    >
                      <CheckIcon class="h-5 w-5" aria-hidden="true" />
                    </span>
                  </li>
                </ComboboxOption>
              </ComboboxOptions>
            </transition>
          </div>
        </Combobox>

        <div>
          <label for="new-var-name" class="field-label">
            {{ store.t('variableManager.newName') }}
          </label>
          <input
            id="new-var-name"
            v-model="newName"
            type="text"
            :disabled="!selectedVariableForRename"
            :placeholder="store.t('variableManager.enterNewName')"
            class="input mt-1"
          />
        </div>

        <button :disabled="!isRenameValid" class="btn btn-primary w-full" @click="executeRename">
          {{ store.t('variableManager.rename') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxLabel,
  ComboboxOption,
  ComboboxOptions,
} from '@headlessui/vue';
import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpDownIcon,
  ChevronUpIcon,
  ExclamationCircleIcon,
  QuestionMarkCircleIcon,
  VariableIcon,
} from '@heroicons/vue/24/solid';
import { computed, ref, watch } from 'vue';
import { usePresetStore } from '../../stores/presetStore';

const isDefinedButUnused = (variable) => {
  const info = store.variables[variable];
  return (
    info &&
    info.definedIn &&
    info.definedIn.length > 0 &&
    (!info.referencedIn || info.referencedIn.length === 0)
  );
};

const isUnresolved = (variable) => {
  // store.unresolvedVariables: [{ varName, promptId }]
  return store.unresolvedVariables.some((item) => item.varName === variable);
};

const store = usePresetStore();
const variables = computed(() => store.definedVariables);
const stats = computed(() => store.variableStats);

// For Rename Tool
const selectedVariableForRename = ref(null);
const newName = ref('');
const query = ref('');

const filteredVariables = computed(() =>
  query.value === ''
    ? variables.value
    : variables.value.filter((variable) =>
        variable.toLowerCase().includes(query.value.toLowerCase()),
      ),
);

const isRenameValid = computed(() => {
  if (!newName.value || !selectedVariableForRename.value) return false;
  const trimmedNewName = newName.value.trim();
  if (trimmedNewName === '') return false;
  if (trimmedNewName.includes(' ')) return false;
  if (store.variables[trimmedNewName] && trimmedNewName !== selectedVariableForRename.value)
    return false;
  return true;
});

const executeRename = () => {
  if (!isRenameValid.value) return;

  const trimmedNewName = newName.value.trim();
  store.renameVariable({
    oldName: selectedVariableForRename.value,
    newName: trimmedNewName,
  });

  selectedVariableForRename.value = trimmedNewName;
  newName.value = '';
  query.value = '';
};

// --- Navigation list (F4b) -------------------------------------------------

// Simulated end value per row; placeholders render dimmed.
const endValueOf = (variable) => {
  const value = store.variableEndValues[variable];
  if (value === undefined) return { text: store.t('macroCard.undefined'), dim: true };
  if (value === '') return { text: store.t('macroCard.empty'), dim: true };
  return { text: value, dim: false };
};

// Row click: highlight every occurrence in the editor, stay on this tab.
const highlightVariable = (variable) => {
  store.selectMacro(variable, { keepTab: true });
};

// Jump icon: open the full variable details view.
const goToVariableDetails = (variable) => {
  store.selectMacro(variable);
};

// Next/prev use: walk the selected variable's timeline through the editor.
const selectedVariable = computed(() => store.selectedMacro?.variableName || null);
const selectedTimeline = computed(() =>
  selectedVariable.value ? store.variableTimelines[selectedVariable.value] || [] : [],
);
const useIndex = ref(-1);
watch(selectedVariable, () => {
  useIndex.value = -1;
});
const stepUse = (direction) => {
  const events = selectedTimeline.value;
  if (!events.length) return;
  if (useIndex.value === -1) {
    useIndex.value = direction > 0 ? 0 : events.length - 1;
  } else {
    useIndex.value = (useIndex.value + direction + events.length) % events.length;
  }
  store.navigateToPrompt(events[useIndex.value].promptId);
};

watch(selectedVariableForRename, (newVal) => {
  if (!newVal) {
    newName.value = '';
  }
});
</script>
