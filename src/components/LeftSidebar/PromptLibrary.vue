<template>
  <div class="flex h-full flex-col">
    <!-- Library Toolbar -->
    <div class="mb-2 flex flex-shrink-0 items-center justify-between">
      <h2 class="section-title">{{ store.t('promptLibrary.title') }}</h2>
      <div class="flex items-center gap-1">
        <!-- Multi-select Button -->
        <button
          class="btn-icon btn-icon-sm"
          :class="{ 'btn-icon-active': store.isMultiSelectActive }"
          :title="store.t('promptLibrary.multiSelect')"
          :aria-pressed="store.isMultiSelectActive"
          @click="store.toggleMultiSelect()"
        >
          <ClipboardDocumentCheckIcon class="h-5 w-5" />
        </button>
        <!-- Delete Selected Button -->
        <button
          :disabled="store.selectedLibraryPrompts.length === 0"
          class="btn-icon btn-icon-sm"
          :class="{ 'btn-icon-danger': store.selectedLibraryPrompts.length > 0 }"
          :title="store.t('promptLibrary.deleteSelected')"
          @click="store.deleteSelectedPrompts()"
        >
          <TrashIcon class="h-5 w-5" />
        </button>
      </div>
    </div>

    <!-- Search Box -->
    <div class="relative mb-4 flex-shrink-0">
      <div class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
        <MagnifyingGlassIcon class="h-5 w-5 text-gray-400" aria-hidden="true" />
      </div>
      <input
        type="text"
        :value="store.librarySearchTerm"
        class="input pl-10"
        :placeholder="store.t('promptLibrary.searchPlaceholder')"
        @input="onSearch"
      />
    </div>

    <!-- Prompt List -->
    <div ref="scrollContainer" class="overflow-y-auto">
      <!-- List Header with Count -->
      <div class="mb-2 flex items-center justify-between text-xs text-gray-500">
        <span>{{ store.t('promptLibrary.sortedByName') }}</span>
        <span>{{ store.t('promptLibrary.count', { count: libraryPrompts.length }) }}</span>
      </div>
      <div class="space-y-2">
        <PromptLibraryItem v-for="prompt in libraryPrompts" :key="prompt.id" :prompt="prompt" />
      </div>
      <!-- Empty State -->
      <div
        v-if="libraryPrompts.length === 0"
        class="flex flex-col items-center justify-center py-8 text-gray-500"
      >
        <MagnifyingGlassIcon class="mb-2 h-12 w-12 text-gray-300" />
        <p class="text-sm">{{ store.t('promptLibrary.noResults') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import {
  ClipboardDocumentCheckIcon,
  MagnifyingGlassIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline';
import { debounce } from 'lodash-es';
import { computed, ref, watch } from 'vue';
import { usePresetStore } from '../../stores/presetStore';
import PromptLibraryItem from './PromptLibraryItem.vue';

const store = usePresetStore();

// Computed list of prompts in the library
const libraryPrompts = computed(() => store.libraryPrompts);

// Use lodash-es for a more robust and consistent debounce implementation
const onSearch = debounce((event) => {
  store.setLibrarySearch(event.target.value);
}, 500); // 500ms debounce delay as requested

// Left-side library scroll container ref
const scrollContainer = ref(null);

// Watch for right-pane navigation requests and scroll to the corresponding item in the library
watch(
  () => store.scrollToLibraryPromptId,
  (newId) => {
    if (!newId) return;

    // 仅在库的滚动容器内查找元素
    const element = scrollContainer.value?.querySelector(`[data-id="${newId}"]`);
    if (element && scrollContainer.value) {
      const containerRect = scrollContainer.value.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const scrollTop = elementRect.top - containerRect.top + scrollContainer.value.scrollTop;

      scrollContainer.value.scrollTo({
        top: scrollTop,
        behavior: 'smooth',
      });

      element.classList.add('flash-highlight');
      window.setTimeout(() => {
        element.classList.remove('flash-highlight');
        store.clearLibraryScrollToRequest();
      }, 1500);
    } else {
      store.clearLibraryScrollToRequest();
    }
  },
);
</script>

<style scoped>
@keyframes flash {
  0% {
    background-color: rgba(74, 144, 226, 0);
  }
  50% {
    background-color: rgba(74, 144, 226, 0.2);
  }
  100% {
    background-color: rgba(74, 144, 226, 0);
  }
}
.flash-highlight {
  animation: flash 1.5s ease-out;
}
</style>
