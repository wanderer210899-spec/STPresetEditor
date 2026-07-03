<template>
  <!-- Variable macros get a rich hover card (F4a): value at this exact point,
       scope, operation, defined-in jump links, and use count. The VTooltip
       wrapper is forced display:inline (.macro-tip) so long macros still wrap
       inside the pre-wrap content. -->
  <VTooltip
    v-if="macro.varName"
    class="macro-tip"
    :delay="{ show: 150, hide: 150 }"
    :popper-triggers="['hover']"
    placement="top"
  >
    <span
      class="mx-0.5 cursor-pointer rounded px-1 py-0.5 font-mono transition-all duration-150"
      :class="chipStyle"
      @click.stop="onClick"
    >
      {{ chipText }}
    </span>

    <template #popper>
      <div class="w-64 max-w-full font-sans text-xs whitespace-normal">
        <div class="flex items-center gap-2">
          <span class="truncate font-mono font-semibold">{{ macro.varName }}</span>
          <span
            class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
            :class="
              macro.scope === 'global'
                ? 'bg-purple-200 text-purple-800'
                : 'bg-emerald-200 text-emerald-800'
            "
          >
            {{ store.t(macro.scope === 'global' ? 'macroCard.global' : 'macroCard.local') }}
          </span>
          <span class="ml-auto shrink-0 tracking-wide uppercase opacity-60">{{ opLabel }}</span>
        </div>

        <div class="mt-1.5 flex items-baseline gap-1.5">
          <span class="shrink-0 opacity-60">{{ store.t('macroCard.valueHere') }}</span>
          <span
            class="font-mono break-all"
            :class="{ 'italic opacity-50': valueHereIsPlaceholder }"
          >
            {{ valueHereDisplay }}
          </span>
        </div>

        <div v-if="definedIn.length" class="mt-2">
          <div class="text-[10px] tracking-wide uppercase opacity-50">
            {{ store.t('macroCard.definedIn') }}
          </div>
          <button
            v-for="def in definedIn"
            :key="def.promptId"
            class="block max-w-full truncate text-left underline decoration-dotted underline-offset-2 hover:opacity-80"
            @click.stop="store.navigateToPrompt(def.promptId)"
          >
            {{ promptNameOf(def.promptId) }}
          </button>
        </div>

        <div class="mt-1.5 opacity-60">
          {{ store.t('macroCard.useCount', { count: useCount }) }}
        </div>
      </div>
    </template>
  </VTooltip>

  <!-- Non-variable macros keep the plain-string tooltip behaviour -->
  <span
    v-else
    v-tooltip="{ content: macro.full, placement: 'top' }"
    :class="macroStyle"
    class="mx-0.5 cursor-pointer rounded px-1 py-0.5 font-mono transition-all duration-150"
    @click.stop="onClick"
  >
    {{ macro.full }}
  </span>
</template>

<script setup>
import { computed } from 'vue';
import { usePresetStore } from '../../stores/presetStore';
import { categoryOf, opLabelKey } from '../../utils/macros';

const props = defineProps({
  /** @type {import('vue').PropType<import('../../stores/presetStore').MacroData>} */
  macro: {
    type: Object,
    required: true,
  },
  displayMode: {
    type: String,
    required: true,
  },
});

const store = usePresetStore();

// getvar / getglobalvar are the value-returning variable macros.
const isGet = computed(() => props.macro.kind === 'get');

const currentValue = computed(() => {
  if (!isGet.value) return undefined;
  return store.macroStateSnapshots[props.macro.id];
});

const currentValueForPopover = computed(() => {
  const value = currentValue.value;
  if (value === undefined) return store.t('macroCard.undefined');
  if (value === '') return store.t('macroCard.empty');
  return value;
});

const isSelected = computed(() => {
  if (!store.selectedMacro || !props.macro.varName) return false;
  return store.selectedMacro.variableName === props.macro.varName;
});

const isUnresolved = computed(() => {
  if (!isGet.value) return false;
  // A getvar is unresolved if its specific snapshot value is undefined.
  return currentValue.value === undefined;
});

const CATEGORY_STYLES = {
  get: 'bg-green-100 dark:bg-green-900/60 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-800',
  write:
    'bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-800',
  random:
    'bg-purple-100 dark:bg-purple-900/60 text-purple-700 dark:text-purple-300 hover:bg-purple-200 dark:hover:bg-purple-800',
  identity:
    'bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800',
  time: 'bg-teal-100 dark:bg-teal-900/60 text-teal-700 dark:text-teal-300 hover:bg-teal-200 dark:hover:bg-teal-800',
  control:
    'bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-200 dark:hover:bg-indigo-800',
  comment: 'text-gray-500 dark:text-gray-400 italic',
  noop: 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400',
  unknown: 'bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200',
};

const macroStyle = computed(() => {
  const styles = [];
  if (isSelected.value) {
    styles.push('ring-2 ring-offset-1 ring-yellow-500');
  }

  if (isUnresolved.value) {
    styles.push(
      'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300 underline decoration-red-500 decoration-wavy',
    );
    return styles;
  }

  styles.push(CATEGORY_STYLES[categoryOf(props.macro)] || CATEGORY_STYLES.unknown);
  return styles;
});

// --- Chip rendering for variable macros ---------------------------------------

// In preview mode a getvar renders as its value (yellow); everywhere else the
// raw macro text with its category colour.
const isPreviewValue = computed(() => isGet.value && props.displayMode === 'preview');
const chipText = computed(() =>
  isPreviewValue.value ? currentValueForPopover.value : props.macro.full,
);
const chipStyle = computed(() => {
  if (isPreviewValue.value) {
    return [
      'bg-yellow-100 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-300 ring-yellow-500 hover:ring-2',
      isUnresolved.value ? '!bg-red-100 !text-red-700 dark:!bg-red-900/50 dark:!text-red-300' : '',
      isSelected.value ? 'ring-2 ring-offset-1' : '',
    ];
  }
  return macroStyle.value;
});

// --- Hover-card data (F4a) -----------------------------------------------------

const opLabel = computed(() => {
  const key = opLabelKey(props.macro);
  return key ? store.t(key) : props.macro.op || props.macro.kind;
});

// Simulated value at this exact execution point: reads/mutates have a
// snapshot; a plain set shows the value it assigns.
const valueHere = computed(() => {
  if (props.macro.kind === 'set') return props.macro.value;
  return store.macroStateSnapshots[props.macro.id];
});
const valueHereIsPlaceholder = computed(
  () => valueHere.value === undefined || valueHere.value === '',
);
const valueHereDisplay = computed(() => {
  if (valueHere.value === undefined) return store.t('macroCard.undefined');
  if (valueHere.value === '') return store.t('macroCard.empty');
  return valueHere.value;
});

const definedIn = computed(() => store.variables[props.macro.varName]?.definedIn || []);
const useCount = computed(() => store.variables[props.macro.varName]?.referencedIn?.length || 0);
const promptNameOf = (promptId) => store.prompts[promptId]?.name || promptId;

const onClick = () => {
  if (props.macro.varName) {
    store.selectMacro(props.macro.varName);
  }
};
</script>
