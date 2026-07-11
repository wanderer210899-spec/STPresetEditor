<template>
  <!-- Execution-order timeline for one variable (F4c): every def/ref as a
       step with its op, the prompt it lives in, and the simulated value after
       the step. Disabled prompts are greyed and tagged "skipped" (their
       writes don't affect the simulation — matches the analysis engine). -->
  <div>
    <label class="field-label">
      {{ store.t('variableTimeline.title') }}
      <span class="text-gray-400 dark:text-gray-500">({{ events.length }})</span>
    </label>
    <p v-if="!events.length" class="mt-1 text-sm text-gray-400 italic dark:text-gray-500">
      {{ store.t('variableTimeline.empty') }}
    </p>
    <ol v-else class="mt-1 space-y-0.5">
      <li v-for="(event, index) in events" :key="event.macroId">
        <button
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
          :class="{ 'opacity-50': !event.enabled }"
          @click="store.navigateToPrompt(event.promptId)"
        >
          <span class="w-5 shrink-0 text-right text-[10px] text-gray-400 tabular-nums">
            {{ index + 1 }}
          </span>
          <span
            class="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium"
            :class="badgeStyle(event)"
          >
            {{ opLabel(event) }}
          </span>
          <span class="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-300">
            {{ event.promptName }}
          </span>
          <span
            v-if="!event.enabled"
            class="shrink-0 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-400"
          >
            {{ store.t('variableTimeline.skipped') }}
          </span>
          <span
            class="max-w-28 shrink-0 truncate font-mono text-xs"
            :class="
              valueOf(event).dim
                ? 'text-gray-400 italic dark:text-gray-500'
                : 'text-gray-600 dark:text-gray-300'
            "
          >
            {{ valueOf(event).text }}
          </span>
        </button>
      </li>
    </ol>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { usePresetStore } from '../../stores/presetStore';
import { opLabelKey } from '../../utils/macros';

const props = defineProps({
  /** Variable name whose timeline to render */
  name: {
    type: String,
    required: true,
  },
});

const store = usePresetStore();

const events = computed(() => store.variableTimelines[props.name] || []);

// Badge colour follows the macro kind, matching the editor's chip palette:
// writes blue, mutates purple, reads green.
const KIND_BADGES = {
  set: 'bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300',
  mutate: 'bg-purple-100 text-purple-700 dark:bg-purple-900/60 dark:text-purple-300',
  get: 'bg-green-100 text-green-700 dark:bg-green-900/60 dark:text-green-300',
};
const badgeStyle = (event) =>
  KIND_BADGES[event.kind] || 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300';

const opLabel = (event) => {
  const key = opLabelKey(event);
  return key ? store.t(key) : event.op || event.kind;
};

const valueOf = (event) => {
  if (event.valueAfter === undefined) return { text: store.t('macroCard.undefined'), dim: true };
  if (event.valueAfter === '') return { text: store.t('macroCard.empty'), dim: true };
  return { text: event.valueAfter, dim: false };
};
</script>
