<template>
  <!-- Main prompt card container with conditional styling -->
  <div
    :data-id="prompt.id"
    class="relative mx-1 my-2 rounded-lg border p-4 shadow-sm transition-shadow duration-200"
    :class="[
      isSelected ? 'border-blue-500 ring-2 ring-blue-500/50' : 'border-gray-200',
      !isEnabled ? 'bg-gray-100' : 'bg-white',
      isDragging ? 'scale-105 opacity-50 shadow-lg' : '',
      dragOver ? 'border-blue-400 ring-2 ring-blue-400/30' : '',
    ]"
    draggable="true"
    @click="selectPrompt"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Header: Title and Actions -->
    <div class="mb-2 flex items-center justify-between">
      <div class="flex min-w-0 items-center">
        <!-- Multi-select checkbox (only show when multi-select is active) -->
        <div v-if="store.isEditorMultiSelectActive" class="mr-3" @click.stop>
          <input
            type="checkbox"
            :checked="isSelectedForBatch"
            :disabled="prompt.system_prompt"
            class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            @change="toggleBatchSelection"
          />
        </div>
        <!-- Collapse toggle button with prompt title -->
        <button
          class="flex min-w-0 items-center rounded p-1 transition-colors hover:bg-gray-100"
          @click.stop="toggleCollapse"
        >
          <ChevronDownIcon
            class="mr-2 h-4 w-4 flex-shrink-0 text-gray-500 transition-transform duration-200"
            :class="{ 'rotate-[-90deg]': finalCollapsedState }"
          />
          <h3
            class="truncate text-base font-bold"
            :class="{ 'text-gray-500': !isEnabled }"
            :title="prompt.name"
          >
            {{ prompt.name }}
          </h3>
        </button>
      </div>
      <div class="flex flex-shrink-0 items-center gap-1">
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
              class="absolute right-0 z-10 mt-2 w-40 origin-top-right divide-y divide-gray-100 rounded-md bg-white shadow-md ring-1 ring-gray-200 focus:outline-none"
            >
              <div class="px-1 py-1">
                <MenuItem v-slot="{ active }">
                  <button
                    :class="[active ? 'bg-gray-100' : '', menuItemClass]"
                    @click.stop="setRole('system')"
                  >
                    <Cog6ToothIcon class="h-5 w-5 text-gray-500" />
                    {{ store.t('promptCard.role.system') }}
                  </button>
                </MenuItem>
                <MenuItem v-slot="{ active }">
                  <button
                    :class="[active ? 'bg-gray-100' : '', menuItemClass]"
                    @click.stop="setRole('user')"
                  >
                    <UserIcon class="h-5 w-5 text-gray-500" />
                    {{ store.t('promptCard.role.user') }}
                  </button>
                </MenuItem>
                <MenuItem v-slot="{ active }">
                  <button
                    :class="[active ? 'bg-gray-100' : '', menuItemClass]"
                    @click.stop="setRole('assistant')"
                  >
                    <ChatBubbleOvalLeftIcon class="h-5 w-5 text-gray-500" />
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
            :class="isEnabled ? 'bg-blue-600' : 'bg-gray-300'"
            class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
          >
            <span
              :class="isEnabled ? 'translate-x-6' : 'translate-x-1'"
              class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
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
              class="absolute right-0 z-10 mt-2 w-56 origin-top-right divide-y divide-gray-100 rounded-md bg-white shadow-lg ring-1 ring-black/5 focus:outline-none"
            >
              <div class="px-1 py-1">
                <MenuItem v-slot="{ active }">
                  <button
                    :class="[active ? 'bg-gray-100' : '', menuItemClass]"
                    @click.stop="store.movePromptTop(prompt.id)"
                  >
                    <ArrowUpCircleIcon class="h-5 w-5 text-gray-500" />
                    {{ store.t('promptCard.moveToTop') }}
                  </button>
                </MenuItem>
                <MenuItem v-slot="{ active }">
                  <button
                    :class="[active ? 'bg-gray-100' : '', menuItemClass]"
                    @click.stop="store.movePromptBottom(prompt.id)"
                  >
                    <ArrowDownCircleIcon class="h-5 w-5 text-gray-500" />
                    {{ store.t('promptCard.moveToBottom') }}
                  </button>
                </MenuItem>
              </div>
              <div class="px-1 py-1">
                <MenuItem v-slot="{ active }">
                  <button
                    :class="[active ? 'bg-gray-100' : '', menuItemClass]"
                    @click.stop="store.duplicatePrompt(prompt.id)"
                  >
                    <DocumentDuplicateIcon class="h-5 w-5 text-gray-500" />
                    {{ store.t('promptCard.duplicate') }}
                  </button>
                </MenuItem>
                <MenuItem v-slot="{ active }">
                  <button
                    :class="[active ? 'bg-gray-100' : '', menuItemClass]"
                    @click.stop="hidePrompt"
                  >
                    <EyeSlashIcon class="h-5 w-5 text-gray-500" aria-hidden="true" />
                    {{ store.t('promptCard.hide') }}
                  </button>
                </MenuItem>
              </div>
            </MenuItems>
          </transition>
        </Menu>
      </div>
    </div>
    <!-- Text (double-click to open the focus editor) -->
    <div
      v-show="!finalCollapsedState"
      class="px-8 text-sm whitespace-pre-wrap"
      :class="{ 'text-gray-600': !isEnabled }"
      :title="store.t('promptCard.expandEditor')"
      @dblclick.stop="store.openFocusEditor(prompt.id)"
    >
      <template v-for="(part, index) in contentParts" :key="index">
        <MacroRenderer
          v-if="part.isMacro"
          :macro="part.macroData"
          :display-mode="store.macroDisplayMode"
        />
        <span v-else>{{ part.content }}</span>
      </template>
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
import { computed, ref } from 'vue';
import { usePresetStore } from '../../stores/presetStore';
import { categoryOf } from '../../utils/macros';
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

// Shared class for dropdown menu items (kept neutral for a restrained palette)
const menuItemClass =
  'group flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-gray-900';

// Drag and drop state
const isDragging = ref(false);
const dragOver = ref(false);

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

/**
 * @returns {Array<{isMacro: boolean, content?: string, macroData?: import('../../stores/presetStore').MacroData}>}
 */
const contentParts = computed(() => {
  const content = props.prompt.content || '';
  const macros = props.prompt.macros || [];
  const mode = store.macroDisplayMode;

  if (macros.length === 0) {
    return [{ isMacro: false, content: content }];
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
      parts.push({ isMacro: false, content: content.substring(lastIndex, macroStartIndex) });
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
    parts.push({ isMacro: false, content: content.substring(lastIndex) });
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
