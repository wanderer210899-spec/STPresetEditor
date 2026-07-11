<template>
  <!-- Prompt block: a bordered card on mobile, a borderless Notion-style block
       on desktop (F3). Hover-reveal of the controls is handled by the
       .prompt-block/.block-controls CSS, gated on md + a real pointer. -->
  <div
    :data-id="prompt.id"
    class="prompt-block relative mx-1 my-2 rounded-lg border p-4 shadow-sm transition-shadow duration-200 md:mx-0 md:my-0 md:border-transparent md:p-2 md:py-1.5 md:shadow-none"
    :class="[
      isSelected
        ? 'border-blue-500 ring-2 ring-blue-500/50 md:ring-0'
        : 'border-gray-200 dark:border-gray-700',
      cardBackground,
      isDragging ? 'scale-105 opacity-50 shadow-lg' : '',
      dragOver ? 'border-blue-400 ring-2 ring-blue-400/30 md:ring-2' : '',
    ]"
    :draggable="store.isMobile ? true : dragArmed"
    @click="selectPrompt"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Header: Title and Actions -->
    <div class="mb-2 flex items-center justify-between md:mb-0.5">
      <div class="flex min-w-0 flex-1 items-center">
        <!-- Desktop drag handle (hover-revealed); dragging is armed from here
             so text selection inside the block never starts a drag.
             In the VS Code webview desktop mode is FORCED (isMobile is false at
             any width), so the handle must exist below md too — otherwise a
             docked panel < 768px has no way to arm a drag at all. -->
        <span
          class="block-controls cursor-grab rounded p-0.5 text-gray-400 dark:text-gray-500"
          :class="isHostDesktop ? 'inline-flex' : 'hidden md:inline-flex'"
          :title="store.t('promptCard.dragHandle')"
          @mousedown="dragArmed = true"
          @mouseup="dragArmed = false"
        >
          <EllipsisVerticalIcon class="-mr-2.5 h-4 w-4" />
          <EllipsisVerticalIcon class="h-4 w-4" />
        </span>
        <!-- Multi-select checkbox (only show when multi-select is active) -->
        <div v-if="store.isEditorMultiSelectActive" class="mr-3" @click.stop>
          <input
            type="checkbox"
            :checked="isSelectedForBatch"
            :disabled="prompt.system_prompt"
            class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-blue-400"
            @change="toggleBatchSelection"
          />
        </div>
        <!-- Collapse chevron -->
        <button
          class="flex items-center rounded p-1 transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
          :title="store.t('promptCard.toggleCollapse')"
          @click.stop="toggleCollapse"
        >
          <ChevronDownIcon
            class="h-4 w-4 flex-shrink-0 text-gray-500 transition-transform duration-200 dark:text-gray-400"
            :class="{ 'rotate-[-90deg]': finalCollapsedState }"
          />
        </button>
        <!-- Title: tap toggles collapse on mobile (as before); click edits
             in place on desktop (F3) -->
        <input
          v-if="isEditingTitle"
          ref="titleInput"
          v-model="titleDraft"
          class="min-w-0 flex-1 border-0 bg-transparent p-1 text-base font-bold text-gray-900 focus:ring-0 focus:outline-none dark:text-gray-100"
          @click.stop
          @blur="commitTitle"
          @keydown.enter.prevent="commitTitle"
          @keydown.esc.prevent="commitTitle"
        />
        <h3
          v-else
          class="min-w-0 truncate p-1 text-base font-bold md:cursor-text"
          :class="{ 'text-gray-500 dark:text-gray-400': !isEnabled }"
          :title="prompt.name"
          @click.stop="onTitleClick"
        >
          <template v-for="(seg, i) in nameParts" :key="i">
            <mark v-if="seg.hit" class="search-mark">{{ seg.text }}</mark>
            <template v-else>{{ seg.text }}</template>
          </template>
        </h3>
        <!-- Idle "off" chip: keeps the enable state legible while the switch
             is hover-hidden on desktop -->
        <span
          v-if="!isEnabled"
          class="ml-2 hidden shrink-0 rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 md:inline-block dark:bg-gray-700 dark:text-gray-400"
        >
          {{ store.t('promptCard.offChip') }}
        </span>
        <!-- Approximate token count (F8d) -->
        <span
          class="ml-2 hidden shrink-0 text-[11px] text-gray-400 tabular-nums md:inline dark:text-gray-500"
          :title="store.t('promptCard.tokenEstimate')"
        >
          ≈{{ tokenLabel }}
        </span>
        <!-- Collapsed one-line preview (F3) -->
        <span
          v-if="finalCollapsedState"
          class="ml-2 min-w-0 flex-1 truncate text-xs text-gray-400 dark:text-gray-500"
        >
          {{ firstLinePreview }}
        </span>
      </div>
      <div class="block-controls flex flex-shrink-0 items-center gap-1">
        <!-- Open the distraction-free focus editor for this prompt -->
        <button
          class="btn-icon btn-icon-sm"
          :title="store.t('promptCard.expandEditor')"
          @click.stop="store.openFocusEditor(prompt.id)"
        >
          <ArrowsPointingOutIcon class="h-4 w-4" />
        </button>
        <!-- Role selector -->
        <Menu as="div" class="relative inline-block text-left">
          <MenuButton class="btn-icon btn-icon-sm" :title="roleTitle" @click.stop>
            <component :is="RoleIcon" class="h-5 w-5" aria-hidden="true" />
          </MenuButton>

          <transition
            enter-active-class="transition duration-100 ease-out"
            enter-from-class="transform scale-95 opacity-0"
            enter-to-class="transform scale-100 opacity-100"
            leave-active-class="transition duration-75 ease-in"
            leave-from-class="transform scale-100 opacity-100"
            leave-to-class="transform scale-95 opacity-0"
          >
            <MenuItems
              class="absolute right-0 z-10 mt-2 w-40 origin-top-right divide-y divide-gray-100 rounded-md bg-white shadow-md ring-1 ring-gray-200 focus:outline-none dark:divide-gray-700 dark:bg-gray-800 dark:ring-gray-700"
            >
              <div class="px-1 py-1">
                <MenuItem v-slot="{ active }">
                  <button
                    :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                    @click.stop="setRole('system')"
                  >
                    <Cog6ToothIcon class="h-5 w-5 text-gray-500 dark:text-gray-400" />
                    {{ store.t('promptCard.role.system') }}
                  </button>
                </MenuItem>
                <MenuItem v-slot="{ active }">
                  <button
                    :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                    @click.stop="setRole('user')"
                  >
                    <UserIcon class="h-5 w-5 text-gray-500 dark:text-gray-400" />
                    {{ store.t('promptCard.role.user') }}
                  </button>
                </MenuItem>
                <MenuItem v-slot="{ active }">
                  <button
                    :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                    @click.stop="setRole('assistant')"
                  >
                    <ChatBubbleOvalLeftIcon class="h-5 w-5 text-gray-500 dark:text-gray-400" />
                    {{ store.t('promptCard.role.assistant') }}
                  </button>
                </MenuItem>
              </div>
            </MenuItems>
          </transition>
        </Menu>

        <!-- Enable / disable -->
        <div @click.stop>
          <Switch
            v-model="isEnabled"
            :class="isEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'"
            class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
          >
            <span
              :class="isEnabled ? 'translate-x-6' : 'translate-x-1'"
              class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform dark:bg-gray-200"
            />
          </Switch>
        </div>

        <!-- Delete -->
        <button
          :disabled="prompt.system_prompt"
          class="btn-icon btn-icon-sm"
          :class="{ 'btn-icon-danger': !prompt.system_prompt }"
          :title="
            prompt.system_prompt
              ? store.t('promptCard.systemPromptCannotDelete')
              : store.t('promptCard.delete')
          "
          @click.stop="removePrompt"
        >
          <TrashIcon class="h-4 w-4" />
        </button>

        <!-- Overflow menu -->
        <Menu as="div" class="relative inline-block text-left">
          <MenuButton class="btn-icon btn-icon-sm" @click.stop>
            <EllipsisVerticalIcon class="h-5 w-5" aria-hidden="true" />
          </MenuButton>
          <transition
            enter-active-class="transition duration-100 ease-out"
            enter-from-class="transform scale-95 opacity-0"
            enter-to-class="transform scale-100 opacity-100"
            leave-active-class="transition duration-75 ease-in"
            leave-from-class="transform scale-100 opacity-100"
            leave-to-class="transform scale-95 opacity-0"
          >
            <MenuItems
              class="absolute right-0 z-10 mt-2 w-56 origin-top-right divide-y divide-gray-100 rounded-md bg-white shadow-lg ring-1 ring-black/5 focus:outline-none dark:divide-gray-700 dark:bg-gray-800"
            >
              <div class="px-1 py-1">
                <MenuItem v-slot="{ active }">
                  <button
                    :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                    @click.stop="store.movePromptTop(prompt.id)"
                  >
                    <ArrowUpCircleIcon class="h-5 w-5 text-gray-500 dark:text-gray-400" />
                    {{ store.t('promptCard.moveToTop') }}
                  </button>
                </MenuItem>
                <MenuItem v-slot="{ active }">
                  <button
                    :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                    @click.stop="store.movePromptBottom(prompt.id)"
                  >
                    <ArrowDownCircleIcon class="h-5 w-5 text-gray-500 dark:text-gray-400" />
                    {{ store.t('promptCard.moveToBottom') }}
                  </button>
                </MenuItem>
              </div>
              <div class="px-1 py-1">
                <MenuItem v-slot="{ active }">
                  <button
                    :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                    @click.stop="store.duplicatePrompt(prompt.id)"
                  >
                    <DocumentDuplicateIcon class="h-5 w-5 text-gray-500 dark:text-gray-400" />
                    {{ store.t('promptCard.duplicate') }}
                  </button>
                </MenuItem>
                <MenuItem v-slot="{ active }">
                  <button
                    :class="[active ? 'bg-gray-100 dark:bg-gray-700' : '', menuItemClass]"
                    @click.stop="hidePrompt"
                  >
                    <EyeSlashIcon
                      class="h-5 w-5 text-gray-500 dark:text-gray-400"
                      aria-hidden="true"
                    />
                    {{ store.t('promptCard.hide') }}
                  </button>
                </MenuItem>
              </div>
            </MenuItems>
          </transition>
        </Menu>
      </div>
    </div>
    <!-- Content: rendered text (click to edit in place on desktop, F3;
         double-tap opens the focus editor on mobile as before) -->
    <div v-show="!finalCollapsedState" class="px-8 md:max-w-[85ch] md:pr-2 md:pl-7">
      <div v-if="isEditingContent" @keydown.esc="stopContentEdit">
        <MacroAutocompleteTextarea
          ref="inlineEditor"
          :model-value="prompt.content || ''"
          auto-grow
          :rows="1"
          textarea-class="block w-full resize-none overflow-hidden border-0 bg-transparent p-0 font-sans text-sm leading-[inherit] whitespace-pre-wrap text-gray-800 focus:ring-0 focus:outline-none dark:text-gray-200"
          @update:model-value="onContentInput"
          @blur="stopContentEdit"
        />
      </div>
      <div
        v-else
        class="cursor-text text-sm whitespace-pre-wrap"
        :class="{ 'text-gray-600 dark:text-gray-400': !isEnabled }"
        @click="onContentClick"
        @dblclick.stop="onContentDblclick"
      >
        <template v-for="(part, index) in contentParts" :key="index">
          <MacroRenderer
            v-if="part.isMacro"
            :macro="part.macroData"
            :display-mode="store.macroDisplayMode"
          />
          <mark v-else-if="part.isMatch" class="search-mark" :data-off="part.start">
            {{ part.content }}
          </mark>
          <span v-else :data-off="part.start">{{ part.content }}</span>
        </template>
        <!-- Empty prompt affordance so there is something to click/tap -->
        <span v-if="!(prompt.content || '').length" class="text-gray-400 italic dark:text-gray-500">
          {{ store.t('promptCard.emptyClickToEdit') }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { Menu, MenuButton, MenuItem, MenuItems, Switch } from '@headlessui/vue';
import {
  ArrowDownCircleIcon,
  ArrowsPointingOutIcon,
  ArrowUpCircleIcon,
  ChatBubbleOvalLeftIcon,
  ChevronDownIcon,
  Cog6ToothIcon,
  DocumentDuplicateIcon,
  EllipsisVerticalIcon,
  EyeSlashIcon,
  TrashIcon,
  UserIcon,
} from '@heroicons/vue/20/solid';
import { computed, nextTick, ref } from 'vue';
import { usePresetStore } from '../../stores/presetStore';
import { isVsCodeHost } from '../../utils/host';
import { splitByTerm } from '../../utils/highlight';
import { categoryOf } from '../../utils/macros';
import { estimateTokens, formatTokenCount } from '../../utils/tokens';
import MacroAutocompleteTextarea from '../MacroAutocompleteTextarea.vue';
import MacroRenderer from './MacroRenderer.vue';

// Define component props
const props = defineProps({
  /** @type {import('vue').PropType<import('../../stores/presetStore').PartialPrompt>} */
  prompt: {
    type: Object,
    required: true,
  },
});

// Initialize the preset store
const store = usePresetStore();

// The VS Code webview forces desktop interactions at any panel width
// (AppLayout), so the drag handle must not be width-gated there.
const isHostDesktop = isVsCodeHost();

// Shared class for dropdown menu items (kept neutral for a restrained palette)
const menuItemClass =
  'group flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-gray-900 dark:text-gray-100';

// Drag and drop state. On desktop a drag must start from the handle
// (dragArmed) so selecting text in the inline editor never drags the block.
const isDragging = ref(false);
const dragOver = ref(false);
const dragArmed = ref(false);

// Inline click-to-edit state (F3, desktop only)
const isEditingContent = ref(false);
const inlineEditor = ref(null);
const isEditingTitle = ref(false);
const titleInput = ref(null);
const titleDraft = ref('');

// Mobile keeps the card look; desktop blocks are transparent. Selection gets
// a subtle tint on desktop (replaces the blue ring).
const cardBackground = computed(() => {
  const mobile =
    props.prompt.enabled === false
      ? 'bg-gray-100 dark:bg-gray-900/60'
      : 'bg-white dark:bg-gray-800';
  const desktop = isSelected.value
    ? 'md:bg-blue-50/70 md:dark:bg-blue-900/20'
    : 'md:bg-transparent md:dark:bg-transparent md:hover:bg-gray-50 md:dark:hover:bg-gray-800/60';
  return `${mobile} ${desktop}`;
});

// Approximate token count for the header chip (F8d)
const tokenLabel = computed(() => formatTokenCount(estimateTokens(props.prompt.content || '')));

// First non-empty content line, for the collapsed one-liner (F3)
const firstLinePreview = computed(() => {
  const line = (props.prompt.content || '').split('\n').find((l) => l.trim());
  return line ? line.trim().slice(0, 160) : '';
});

// Compute final collapsed state using store's centralized logic
const finalCollapsedState = computed(() => {
  return store.getPromptCollapseState(props.prompt.id);
});

// Check if this prompt is currently selected
const isSelected = computed(() => store.selectedPromptId === props.prompt.id);

// Check if this prompt is selected for batch operations
const isSelectedForBatch = computed(() => store.selectedEditorPrompts.includes(props.prompt.id));

// Two-way binding for prompt enabled state
const isEnabled = computed({
  get() {
    return props.prompt.enabled !== false;
  },
  set() {
    store.togglePromptEnabled(props.prompt.id);
  },
});

// Get current prompt role with fallback to 'system'
const currentRole = computed(() => props.prompt.role || 'system');

// Icon mapping for different prompt roles
const roleIcons = {
  system: Cog6ToothIcon,
  user: UserIcon,
  assistant: ChatBubbleOvalLeftIcon,
};

// Get the appropriate icon for the current role
const RoleIcon = computed(() => roleIcons[currentRole.value]);

// Tooltip text for the role selector
const roleTitle = computed(
  () => `${store.t('promptCard.roleLabel')}: ${store.t('promptCard.role.' + currentRole.value)}`,
);

/**
 * Update the prompt role
 * @param {string} newRole - The new role to set
 */
const setRole = (newRole) => {
  store.updatePromptDetail({
    promptId: props.prompt.id,
    field: 'role',
    value: newRole,
  });
};

// Title segments with search-hit marks (F6a)
const nameParts = computed(() => splitByTerm(props.prompt.name || '', store.editorSearchTerm));

// Push a plain-text run, split into highlight segments while a search is
// active. Macro chips are never split — only the text between them is.
// `baseOffset` is the run's position in the raw content; each segment carries
// its own offset (data-off) so a click can be mapped back to a caret position.
const pushText = (parts, text, baseOffset) => {
  const term = store.editorSearchTerm;
  if (!term) {
    parts.push({ isMacro: false, content: text, start: baseOffset });
    return;
  }
  let consumed = 0;
  splitByTerm(text, term).forEach((seg) => {
    if (seg.text) {
      parts.push({
        isMacro: false,
        content: seg.text,
        isMatch: seg.hit,
        start: baseOffset + consumed,
      });
    }
    consumed += seg.text.length;
  });
};

/**
 * @returns {Array<{isMacro: boolean, content?: string, isMatch?: boolean, start?: number, macroData?: import('../../stores/presetStore').MacroData}>}
 */
const contentParts = computed(() => {
  const content = props.prompt.content || '';
  const macros = props.prompt.macros || [];
  const mode = store.macroDisplayMode;

  if (macros.length === 0) {
    const parts = [];
    pushText(parts, content, 0);
    return parts;
  }

  const parts = [];
  let lastIndex = 0;

  macros.forEach((macro) => {
    // Prefer the exact offsets captured by the tokenizer (robust to nested /
    // duplicate macro text); fall back to indexOf for any legacy macro data.
    const macroStartIndex =
      typeof macro.start === 'number' ? macro.start : content.indexOf(macro.full, lastIndex);
    if (macroStartIndex === -1) return; // Should not happen
    const macroEndIndex =
      typeof macro.end === 'number' ? macro.end : macroStartIndex + macro.full.length;

    // Add text part before the macro
    if (macroStartIndex > lastIndex) {
      pushText(parts, content.substring(lastIndex, macroStartIndex), lastIndex);
    }

    // Add the macro part, applying mode logic
    if (mode === 'preview') {
      // In preview, macros that produce no output (set/add/inc/dec, comments,
      // noop/newline/trim) are hidden; value-returning and other macros render.
      const category = categoryOf(macro);
      if (category !== 'write' && category !== 'comment' && category !== 'noop') {
        parts.push({ isMacro: true, macroData: macro });
      }
    } else {
      // In raw mode, always show the macro
      parts.push({ isMacro: true, macroData: macro });
    }

    lastIndex = macroEndIndex;
  });

  // Add remaining text part after the last macro
  if (lastIndex < content.length) {
    pushText(parts, content.substring(lastIndex), lastIndex);
  }

  return parts;
});

const selectPrompt = () => {
  // Clicking the card selects it (does not toggle batch checkbox)
  store.selectPrompt(props.prompt.id);
  // Sync left library scroll position
  store.navigateLibraryToPrompt(props.prompt.id);
};

const toggleBatchSelection = () => {
  store.toggleEditorSelection(props.prompt.id);
};

const hidePrompt = () => {
  store.hidePrompt(props.prompt.id);
};

const removePrompt = () => {
  if (props.prompt.system_prompt) {
    store.showToast(store.t('promptCard.systemPromptCannotDelete'), 'error');
    return;
  }

  // If skipping confirmation is enabled, delete immediately
  if (store.skipDeleteConfirmation) {
    store.removePrompt(props.prompt.id);
    return;
  }

  // Otherwise show the in-app confirm dialog with a "don't ask again" option
  store.requestConfirm({
    message: store.t('promptCard.deleteConfirm', { name: props.prompt.name }),
    confirmLabel: store.t('common.delete'),
    danger: true,
    showSkip: true,
    skipLabel: store.t('promptCard.skipDeleteConfirmation'),
    onConfirm: ({ skip }) => {
      if (skip) store.setSkipDeleteConfirmation(true);
      store.removePrompt(props.prompt.id);
    },
  });
};

// Toggle collapsed state; state management is centralized in the store
const toggleCollapse = () => {
  store.togglePromptCollapse(props.prompt.id);
};

// --- Click-to-edit in place (F3, desktop only) -------------------------------

// Title: click/tap edits the name in place on every view (collapse still lives
// on the dedicated chevron button, so nothing is lost on mobile).
const onTitleClick = () => {
  titleDraft.value = props.prompt.name || '';
  isEditingTitle.value = true;
  nextTick(() => titleInput.value?.focus());
};

const commitTitle = () => {
  if (!isEditingTitle.value) return;
  isEditingTitle.value = false;
  const value = titleDraft.value.trim();
  if (value && value !== props.prompt.name) {
    store.updatePromptDetail({ promptId: props.prompt.id, field: 'name', value });
  }
};

/** Map a click inside the rendered content to a raw-content caret offset.
 *  Text segments carry their raw offset in data-off; macro chips stop click
 *  propagation, so only plain text ever reaches here. Returns null when the
 *  browser API is unavailable or the click missed a text segment. */
const clickTextOffset = (event) => {
  let pos = null;
  if (document.caretPositionFromPoint) {
    pos = document.caretPositionFromPoint(event.clientX, event.clientY);
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (range) pos = { offsetNode: range.startContainer, offset: range.startOffset };
  }
  if (!pos || !pos.offsetNode) return null;
  const node = pos.offsetNode;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const holder = el?.closest?.('[data-off]');
  if (!holder) return null;
  const base = Number(holder.dataset.off);
  if (!Number.isFinite(base)) return null;
  return base + (node.nodeType === Node.TEXT_NODE ? pos.offset : 0);
};

const startContentEdit = (caret = null) => {
  isEditingContent.value = true;
  nextTick(() => {
    if (caret != null) inlineEditor.value?.setCaret(caret);
    else inlineEditor.value?.setCaret((props.prompt.content || '').length);
  });
};

const onContentClick = (event) => {
  // Type right where you tap/click — same on phone, web and the extension.
  startContentEdit(clickTextOffset(event));
};

const onContentDblclick = () => {
  // Rarely reached now that a single click swaps in the inline editor; harmless
  // as a fallback path to the full-screen editor.
  store.openFocusEditor(props.prompt.id);
};

// Text changes flow through the normal store path (debounced analysis +
// autosave), so exiting edit mode is purely presentational.
const onContentInput = (value) => {
  store.updatePromptDetail({ promptId: props.prompt.id, field: 'content', value });
};

const stopContentEdit = () => {
  isEditingContent.value = false;
};

// Drag-and-drop event handlers
const onDragStart = (event) => {
  isDragging.value = true;
  event.dataTransfer.setData('text/plain', props.prompt.id);
  event.dataTransfer.effectAllowed = 'move';

  // Apply dragging cursor style
  event.target.style.cursor = 'grabbing';
};

const onDragEnd = (event) => {
  isDragging.value = false;
  dragOver.value = false;
  dragArmed.value = false;
  event.target.style.cursor = 'grab';
};

const onDragOver = (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  dragOver.value = true;
};

const onDragLeave = (event) => {
  // Clear dragOver only when leaving the entire element
  if (!event.currentTarget.contains(event.relatedTarget)) {
    dragOver.value = false;
  }
};

const onDrop = (event) => {
  event.preventDefault();
  dragOver.value = false;

  const draggedPromptId = event.dataTransfer.getData('text/plain');
  const source = (() => {
    try {
      return event.dataTransfer.getData('application/x-stpe-source');
    } catch {
      return '';
    }
  })();
  const targetPromptId = props.prompt.id;

  // No-op when dragging onto the same element
  if (draggedPromptId === targetPromptId) {
    return;
  }

  // Choose behavior based on drag source
  if (source === 'library') {
    // Insert from the left library after the target prompt
    store.insertPromptAfter(draggedPromptId, targetPromptId);
  } else {
    // Reorder within the editor list
    store.movePromptAfter(draggedPromptId, targetPromptId);
  }
};
</script>
