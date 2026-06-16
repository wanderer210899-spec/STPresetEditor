<template>
  <!-- Render the variable value in preview mode (getvar / getglobalvar) -->
  <span
    v-if="isGet && displayMode === 'preview'"
    v-tooltip="{ content: macro.full, placement: 'top' }"
    class="mx-0.5 cursor-pointer rounded bg-yellow-100 px-1 py-0.5 font-mono text-yellow-800 ring-yellow-500 transition-all duration-150 hover:ring-2"
    :class="{ '!bg-red-100 !text-red-700': isUnresolved }"
    @click.stop="onClick"
  >
    {{ currentValueForPopover }}
  </span>

  <!-- Render the raw getvar/getglobalvar with its value in a tooltip -->
  <span
    v-else-if="isGet"
    v-tooltip="{ content: currentValueForPopover, placement: 'top' }"
    :class="macroStyle"
    class="mx-0.5 cursor-pointer rounded px-1 py-0.5 font-mono transition-all duration-150"
    @click.stop="onClick"
  >
    {{ macro.full }}
  </span>

  <!-- Render the raw macro for all other cases -->
  <span
    v-else
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
import { categoryOf } from '../../utils/macros';

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
  if (value === undefined) return '<undefined>';
  if (value === '') return '<empty string>';
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
  get: 'bg-green-100 text-green-700 hover:bg-green-200',
  write: 'bg-blue-100 text-blue-700 hover:bg-blue-200',
  random: 'bg-purple-100 text-purple-700 hover:bg-purple-200',
  identity: 'bg-amber-100 text-amber-700 hover:bg-amber-200',
  time: 'bg-teal-100 text-teal-700 hover:bg-teal-200',
  comment: 'text-gray-500 italic',
  noop: 'bg-gray-100 text-gray-500',
  unknown: 'bg-gray-200 text-gray-800',
};

const macroStyle = computed(() => {
  const styles = [];
  if (isSelected.value) {
    styles.push('ring-2 ring-offset-1 ring-yellow-500');
  }

  if (isUnresolved.value) {
    styles.push('bg-red-100 text-red-700 underline decoration-red-500 decoration-wavy');
    return styles;
  }

  styles.push(CATEGORY_STYLES[categoryOf(props.macro)] || CATEGORY_STYLES.unknown);
  return styles;
});

const onClick = () => {
  if (props.macro.varName) {
    store.selectMacro(props.macro.varName);
  }
};
</script>
