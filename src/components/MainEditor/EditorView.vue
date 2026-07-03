<template>
  <!-- Main editor container with full height layout -->
  <div class="flex h-full flex-col">
    <!-- Editor header with title and controls -->
    <div class="mb-3 flex flex-shrink-0 flex-col gap-2">
      <!-- Row 1: title, search, and view/action controls. Wraps on narrow
           screens (320px phones) instead of pushing buttons off-screen. -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 class="section-title shrink-0">{{ store.t('editor.title') }}</h2>
        <!-- Inline search box -->
        <div class="relative min-w-0 flex-1 basis-40">
          <div class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
            <MagnifyingGlassIcon
              class="h-5 w-5 text-gray-400 dark:text-gray-500"
              aria-hidden="true"
            />
          </div>
          <input
            id="editor-search-input"
            type="text"
            :value="store.editorSearchTerm"
            class="input pl-10"
            :class="{ 'pr-16': store.editorSearchTerm }"
            :placeholder="store.t('editor.searchPlaceholder')"
            @input="onSearch"
            @keydown.enter.prevent="onSearchEnter"
          />
          <!-- "x / N" find-next counter inside the box -->
          <div
            v-if="store.editorSearchTerm"
            class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-gray-400 tabular-nums dark:text-gray-500"
            :title="matchStatsLabel"
          >
            {{ matchPositionLabel }}
          </div>
        </div>

        <!-- Find-next navigation (visible only while searching) -->
        <div v-if="store.editorSearchTerm" class="flex shrink-0 items-center">
          <button
            class="btn-icon btn-icon-sm"
            :disabled="!store.editorSearchStats.matches"
            :title="store.t('editor.prevMatch')"
            @click="store.editorSearchPrev()"
          >
            <ChevronUpIcon class="h-4 w-4" />
          </button>
          <button
            class="btn-icon btn-icon-sm"
            :disabled="!store.editorSearchStats.matches"
            :title="store.t('editor.nextMatch')"
            @click="store.editorSearchNext()"
          >
            <ChevronDownIcon class="h-4 w-4" />
          </button>
        </div>

        <!-- View + action controls -->
        <div class="flex shrink-0 items-center gap-2">
          <!-- Macro display mode toggle -->
          <SwitchGroup as="div" class="flex items-center">
            <SwitchLabel
              as="span"
              class="mr-2 hidden text-sm font-medium text-gray-700 lg:inline dark:text-gray-300"
            >
              {{ isPreviewMode ? store.t('editor.previewMode') : store.t('editor.rawMode') }}
            </SwitchLabel>
            <Switch
              :model-value="isPreviewMode"
              :class="isPreviewMode ? 'bg-green-500' : 'bg-gray-400'"
              class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out"
              @update:model-value="store.toggleMacroDisplayMode()"
            >
              <span
                aria-hidden="true"
                :class="isPreviewMode ? 'translate-x-5' : 'translate-x-0'"
                class="pointer-events-none relative inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out dark:bg-gray-200"
              >
                <span
                  :class="
                    isPreviewMode
                      ? 'opacity-0 duration-100 ease-out'
                      : 'opacity-100 duration-200 ease-in'
                  "
                  class="absolute inset-0 flex h-full w-full items-center justify-center transition-opacity"
                  aria-hidden="true"
                >
                  <CodeBracketIcon class="h-3 w-3 text-gray-400 dark:text-gray-500" />
                </span>
                <span
                  :class="
                    isPreviewMode
                      ? 'opacity-100 duration-200 ease-in'
                      : 'opacity-0 duration-100 ease-out'
                  "
                  class="absolute inset-0 flex h-full w-full items-center justify-center transition-opacity"
                  aria-hidden="true"
                >
                  <EyeIcon class="h-3 w-3 text-green-600 dark:text-green-400" />
                </span>
              </span>
            </Switch>
          </SwitchGroup>

          <span class="mx-0.5 h-6 w-px bg-gray-200 dark:bg-gray-700" aria-hidden="true"></span>

          <!-- Primary action: new prompt (icon-only on narrow phones) -->
          <button
            class="btn btn-sm btn-primary"
            :title="store.t('promptLibrary.newPrompt')"
            @click="store.createNewPrompt()"
          >
            <PlusIcon class="h-4 w-4" />
            <span class="hidden sm:inline">{{ store.t('promptLibrary.newPrompt') }}</span>
          </button>
          <!-- Toggle multi-select (reveals checkboxes + batch bar) -->
          <button
            class="btn-icon btn-icon-sm"
            :class="{ 'btn-icon-active': store.isEditorMultiSelectActive }"
            :title="store.t('editor.multiSelect')"
            :aria-pressed="store.isEditorMultiSelectActive"
            @click="store.toggleEditorMultiSelect()"
          >
            <ClipboardDocumentCheckIcon class="h-5 w-5" />
          </button>
          <!-- Collapse / expand all -->
          <button
            class="btn-icon btn-icon-sm"
            :title="store.t('editor.collapseAll')"
            @click="store.collapseAllPrompts()"
          >
            <ChevronUpIcon class="h-4 w-4" />
          </button>
          <button
            class="btn-icon btn-icon-sm"
            :title="store.t('editor.expandAll')"
            @click="store.expandAllPrompts()"
          >
            <ChevronDownIcon class="h-4 w-4" />
          </button>
        </div>
      </div>

      <!-- Search result summary (F6a): "N matches in M prompts" -->
      <div v-if="store.editorSearchTerm" class="px-1 text-xs text-gray-500 dark:text-gray-400">
        {{ matchStatsLabel }}
      </div>

      <!-- Contextual batch bar: only shown while in multi-select mode -->
      <div
        v-if="store.isEditorMultiSelectActive"
        class="flex flex-wrap items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
      >
        <span class="mr-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          {{
            store.t('editor.selectedCount', {
              selected: store.selectedEditorPrompts.length,
              total: store.promptOrder.length,
            })
          }}
        </span>
        <button class="btn btn-sm btn-secondary" @click="store.selectAllEditorPrompts()">
          {{ store.t('editor.selectAll') }}
        </button>
        <button class="btn btn-sm btn-secondary" @click="store.deselectAllEditorPrompts()">
          {{ store.t('editor.deselectAll') }}
        </button>

        <span class="mx-1 h-5 w-px bg-gray-300 dark:bg-gray-600" aria-hidden="true"></span>

        <button
          class="btn-icon btn-icon-sm"
          :disabled="!hasSelection"
          :title="store.t('editor.batchMoveToTop')"
          @click="store.batchMoveSelectedToTop()"
        >
          <ArrowUpIcon class="h-4 w-4" />
        </button>
        <button
          class="btn-icon btn-icon-sm"
          :disabled="!hasSelection"
          :title="store.t('editor.batchMoveToBottom')"
          @click="store.batchMoveSelectedToBottom()"
        >
          <ArrowDownIcon class="h-4 w-4" />
        </button>
        <button
          class="btn btn-sm btn-secondary"
          :disabled="!hasSelection"
          @click="store.openBatchReplaceModal()"
        >
          {{ store.t('editor.batchReplace') }}
        </button>
        <button
          class="btn-icon btn-icon-sm btn-icon-danger ml-auto"
          :disabled="!hasSelection"
          :title="store.t('editor.batchDelete')"
          @click="store.batchDeleteSelected()"
        >
          <TrashIcon class="h-4 w-4" />
        </button>
      </div>
    </div>

    <!-- Prompt list container: cards on mobile, a centred column of
         Notion-style blocks on desktop (F3) -->
    <div ref="scrollContainer" class="overflow-y-auto">
      <div class="space-y-4 md:mx-auto md:w-full md:max-w-[92ch] md:space-y-0.5">
        <PromptCard
          v-for="prompt in prompts"
          :key="prompt.id"
          :ref="
            (el) => {
              if (el) promptCardRefs[prompt.id] = el;
            }
          "
          :prompt="prompt"
        />
      </div>
    </div>

    <!-- Modals moved to RightSidebar overlay -->
  </div>
</template>

<script setup>
import { Switch, SwitchGroup, SwitchLabel } from '@headlessui/vue';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClipboardDocumentCheckIcon,
  CodeBracketIcon,
  EyeIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/vue/20/solid';
import { debounce } from 'lodash-es';
import { computed, onBeforeUpdate, ref, watch } from 'vue';
import { usePresetStore } from '../../stores/presetStore';
import PromptCard from './PromptCard.vue';

// Initialize the preset store
const store = usePresetStore();

// Refs for prompt card components (used for scrolling and animations)
const promptCardRefs = ref({});
const scrollContainer = ref(null);

// Computed property for preview mode state
const isPreviewMode = computed(() => store.macroDisplayMode === 'preview');

// Whether any prompt is currently selected for batch operations
const hasSelection = computed(() => store.selectedEditorPrompts.length > 0);

// Debounced search function to avoid excessive API calls
// Use lodash-es for a more robust and consistent debounce implementation
const onSearch = debounce((event) => {
  store.setEditorSearch(event.target.value);
}, 500); // 500ms debounce delay as requested

// Enter / Shift+Enter cycles through matches (F6b). Commit any pending
// debounced input first so navigation uses what's visible in the box.
const onSearchEnter = (event) => {
  onSearch.cancel();
  store.setEditorSearch(event.target.value); // no-op if unchanged
  if (event.shiftKey) store.editorSearchPrev();
  else store.editorSearchNext();
};

// "x / N" and "N matches in M prompts" labels
const matchPositionLabel = computed(() => {
  const { matches } = store.editorSearchStats;
  const pos = store.editorSearchActiveIndex === -1 ? '–' : store.editorSearchActiveIndex + 1;
  return `${pos} / ${matches}`;
});
const matchStatsLabel = computed(() =>
  store.t('editor.matchStats', {
    matches: store.editorSearchStats.matches,
    prompts: store.editorSearchStats.prompts,
  }),
);

// Before each update, clear the refs object to avoid memory leaks
onBeforeUpdate(() => {
  promptCardRefs.value = {};
});

// Computed property for prompts
const prompts = computed(() => store.orderedPrompts);

// Public helper to request scrolling to a specific prompt
const scrollToPrompt = (promptId) => {
  store.navigateToPrompt(promptId);
};

// Scroll to top of the editor list
const scrollToTop = () => {
  if (scrollContainer.value) {
    scrollContainer.value.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  }
};

// Scroll to bottom of the editor list
const scrollToBottom = () => {
  if (scrollContainer.value) {
    scrollContainer.value.scrollTo({
      top: scrollContainer.value.scrollHeight,
      behavior: 'smooth',
    });
  }
};

// Expose methods for parent components to call
defineExpose({
  scrollToPrompt,
  scrollToTop,
  scrollToBottom,
});

// Watch for scroll-to-prompt requests and handle smooth scrolling with animation
watch(
  () => store.scrollToPromptId,
  (newId) => {
    if (newId) {
      console.log('[EditorView] Received scroll request. Target prompt ID:', newId);

      // Only query inside the right editor container to avoid matching left list items
      const element = scrollContainer.value?.querySelector(`[data-id="${newId}"]`);
      console.log('[EditorView] Found DOM element in the editor:', element);

      if (element && scrollContainer.value) {
        console.log('[EditorView] Scrolling to prompt:', newId);

        // Compute element position relative to scroll container
        const containerRect = scrollContainer.value.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();

        // Calculate required scroll distance
        const scrollTop = elementRect.top - containerRect.top + scrollContainer.value.scrollTop;
        console.log(
          '[EditorView] Scroll calc - containerTop:',
          containerRect.top,
          'elementTop:',
          elementRect.top,
          'scrollTop:',
          scrollTop,
        );

        // Perform smooth scroll
        scrollContainer.value.scrollTo({
          top: scrollTop,
          behavior: 'smooth',
        });

        // Flash animation
        element.classList.add('flash-highlight');
        window.setTimeout(() => {
          element.classList.remove('flash-highlight');
          store.clearScrollToRequest();
        }, 1500);
      } else {
        console.warn(
          '[EditorView] Unable to find DOM element in the right editor. Prompt ID:',
          newId,
        );
        console.warn(
          '[EditorView] element exists:',
          !!element,
          'scroll container exists:',
          !!scrollContainer.value,
        );
        store.clearScrollToRequest();
      }
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
