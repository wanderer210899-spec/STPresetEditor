<template>
  <BaseModal
    :show="store.isGlobalSearchOpen"
    :title="store.t('globalSearch.title')"
    size="lg"
    hide-footer
    @close="store.closeGlobalSearch()"
  >
    <div class="space-y-4">
      <!-- Query input -->
      <div class="relative">
        <div class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
          <MagnifyingGlassIcon class="h-5 w-5 text-gray-400" aria-hidden="true" />
        </div>
        <input
          ref="inputEl"
          v-model="query"
          type="text"
          class="input pl-10"
          :placeholder="store.t('globalSearch.placeholder')"
          @keydown="onKeydown"
        />
      </div>

      <!-- Results grouped by preset -->
      <div v-if="groups.length" class="max-h-[50vh] space-y-4 overflow-y-auto">
        <div v-for="group in groups" :key="group.presetId || 'active'">
          <!-- Group header: the preset. Clickable when it is not the active one. -->
          <button
            class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left"
            :class="[
              group.isActive ? 'cursor-default' : 'hover:bg-gray-100',
              isActiveRow(group.presetId, null) ? 'bg-blue-50 ring-1 ring-blue-300' : '',
            ]"
            @click="!group.isActive && open(group.presetId, null)"
          >
            <BookmarkIcon class="h-4 w-4 shrink-0 text-gray-400" />
            <span class="truncate text-sm font-semibold text-gray-700">
              <template v-for="(seg, i) in splitByTerm(group.presetName, committedQuery)" :key="i">
                <mark v-if="seg.hit" class="search-mark">{{ seg.text }}</mark>
                <template v-else>{{ seg.text }}</template>
              </template>
            </span>
            <span
              v-if="group.isActive"
              class="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700"
            >
              {{ store.t('globalSearch.activePreset') }}
            </span>
          </button>

          <!-- Prompt hits -->
          <button
            v-for="hit in group.hits"
            :key="hit.promptId"
            class="mt-1 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-gray-100"
            :class="{
              'bg-blue-50 ring-1 ring-blue-300': isActiveRow(group.presetId, hit.promptId),
            }"
            @click="open(group.presetId, hit.promptId)"
          >
            <span class="truncate text-sm font-medium text-gray-800">
              <template v-for="(seg, i) in splitByTerm(hit.promptName, committedQuery)" :key="i">
                <mark v-if="seg.hit" class="search-mark">{{ seg.text }}</mark>
                <template v-else>{{ seg.text }}</template>
              </template>
            </span>
            <span class="truncate text-xs text-gray-500">
              {{ hit.snippet.before }}
              <mark class="search-mark">{{ hit.snippet.match }}</mark>
              {{ hit.snippet.after }}
            </span>
          </button>
        </div>
      </div>

      <!-- Empty / idle states -->
      <p v-else-if="committedQuery" class="py-6 text-center text-sm text-gray-500">
        {{ store.t('globalSearch.noResults') }}
      </p>
      <p v-else class="py-6 text-center text-xs text-gray-400">
        {{ store.t('globalSearch.hint') }}
      </p>
    </div>
  </BaseModal>
</template>

<script setup>
import { BookmarkIcon, MagnifyingGlassIcon } from '@heroicons/vue/20/solid';
import { debounce } from 'lodash-es';
import { computed, nextTick, ref, watch } from 'vue';
import { usePresetStore } from '../stores/presetStore';
import { splitByTerm } from '../utils/highlight';
import BaseModal from './BaseModal.vue';

const store = usePresetStore();

const inputEl = ref(null);
const query = ref('');
const committedQuery = ref(''); // the term the visible results were computed for
const groups = ref([]);
const activeIndex = ref(0); // position in the flattened selectable rows

const runSearch = debounce((term) => {
  committedQuery.value = term.trim();
  groups.value = store.searchAllPresets(committedQuery.value);
  activeIndex.value = 0;
}, 250);

watch(query, (term) => runSearch(term));

// Reset and focus when the palette opens
watch(
  () => store.isGlobalSearchOpen,
  (open) => {
    if (!open) return;
    query.value = '';
    committedQuery.value = '';
    groups.value = [];
    activeIndex.value = 0;
    nextTick(() => inputEl.value?.focus());
  },
);

// Flattened keyboard-selectable rows: cross-preset group headers + all hits
const flatRows = computed(() => {
  const rows = [];
  groups.value.forEach((group) => {
    if (!group.isActive) rows.push({ presetId: group.presetId, promptId: null });
    group.hits.forEach((hit) => rows.push({ presetId: group.presetId, promptId: hit.promptId }));
  });
  return rows;
});

const isActiveRow = (presetId, promptId) => {
  const row = flatRows.value[activeIndex.value];
  return Boolean(row && row.presetId === presetId && row.promptId === promptId);
};

const open = (presetId, promptId) => {
  store.openGlobalSearchResult(presetId, promptId);
};

const onKeydown = (event) => {
  const rows = flatRows.value;
  if (event.key === 'ArrowDown' && rows.length) {
    event.preventDefault();
    activeIndex.value = (activeIndex.value + 1) % rows.length;
  } else if (event.key === 'ArrowUp' && rows.length) {
    event.preventDefault();
    activeIndex.value = (activeIndex.value - 1 + rows.length) % rows.length;
  } else if (event.key === 'Enter') {
    event.preventDefault();
    runSearch.flush();
    const row = flatRows.value[activeIndex.value];
    if (row) open(row.presetId, row.promptId);
  }
};
</script>
