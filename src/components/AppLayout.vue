<script setup>
import { Dialog, DialogPanel, TransitionChild, TransitionRoot } from '@headlessui/vue';
import { computed, ref, watchEffect } from 'vue';
import { isVsCodeHost } from '../utils/host';
import { usePresetStore } from '../stores/presetStore';

// Track Tailwind's 'md' breakpoint with a plain matchMedia listener (this was
// the sole @vueuse/core usage). AppLayout lives for the whole app, so the
// listener needs no teardown.
const desktopQuery = window.matchMedia('(min-width: 768px)');
const gteDesktop = ref(desktopQuery.matches);
desktopQuery.addEventListener('change', (event) => {
  gteDesktop.value = event.matches;
});
// The VS Code / Cursor extension always runs on a desktop, but its panel is
// often docked narrow (< 768px). Width-based mobile detection would then drop it
// into the phone layout — no click-to-edit, drawer nav — which is the "extension
// is missing desktop features" bug. Force the desktop UI in the extension; the
// collapsible columns already handle a narrow panel.
const isDesktop = computed(() => isVsCodeHost() || gteDesktop.value);

const store = usePresetStore();

// Watch for changes in the breakpoint and update the store
watchEffect(() => {
  store.setIsMobile(!isDesktop.value);
});
</script>

<template>
  <!-- DESKTOP LAYOUT: main editor always visible, with collapsible left/right
       columns (toggled from the toolbar) instead of draggable splitters. -->
  <div v-if="isDesktop" class="flex min-h-0">
    <!-- Left: prompt library (hidden while the right pane is maximized) -->
    <transition
      enter-active-class="transition-all duration-200 ease-out"
      enter-from-class="w-0 opacity-0"
      leave-active-class="transition-all duration-200 ease-in"
      leave-to-class="w-0 opacity-0"
    >
      <aside
        v-if="store.desktopLeftOpen && !store.isRightPaneMaximized"
        class="w-72 shrink-0 overflow-auto border-r border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900"
      >
        <slot name="left" />
      </aside>
    </transition>

    <!-- Main editor: the focus — a bright white canvas that fills the space -->
    <main class="min-w-0 flex-1 overflow-auto bg-white p-4 dark:bg-gray-800">
      <slot name="main" />
    </main>

    <!-- Right: details / variables (widens when maximized) -->
    <transition
      enter-active-class="transition-all duration-200 ease-out"
      enter-from-class="w-0 opacity-0"
      leave-active-class="transition-all duration-200 ease-in"
      leave-to-class="w-0 opacity-0"
    >
      <aside
        v-if="store.desktopRightOpen"
        class="relative shrink-0 overflow-auto border-l border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900"
        :class="store.isRightPaneMaximized ? 'w-[40rem] max-w-[55vw]' : 'w-96'"
      >
        <slot name="right" />
      </aside>
    </transition>
  </div>

  <!-- MOBILE LAYOUT: Main view with off-canvas drawers -->
  <div v-else class="flex-grow overflow-hidden">
    <!-- Main content is always visible -->
    <div class="h-full overflow-auto bg-white p-2 dark:bg-gray-800">
      <slot name="main" />
    </div>

    <!-- Left Sidebar as a Drawer -->
    <TransitionRoot :show="store.isLeftSidebarOpen" as="template">
      <Dialog class="relative z-50" @close="store.toggleLeftSidebar(false)">
        <TransitionChild
          as="template"
          enter="transition-opacity ease-linear duration-300"
          enter-from="opacity-0"
          enter-to="opacity-100"
          leave="transition-opacity ease-linear duration-300"
          leave-from="opacity-100"
          leave-to="opacity-0"
        >
          <div class="fixed inset-0 bg-black/30" />
        </TransitionChild>
        <TransitionChild
          as="template"
          enter="transition ease-in-out duration-300 transform"
          enter-from="-translate-x-full"
          enter-to="translate-x-0"
          leave="transition ease-in-out duration-300 transform"
          leave-from="translate-x-0"
          leave-to="-translate-x-full"
        >
          <DialogPanel
            class="fixed inset-y-0 left-0 w-4/5 max-w-sm bg-white p-4 shadow-xl dark:bg-gray-800"
          >
            <slot name="left" />
          </DialogPanel>
        </TransitionChild>
      </Dialog>
    </TransitionRoot>

    <!-- Right Sidebar as a Drawer -->
    <TransitionRoot :show="store.isRightSidebarOpen" as="template">
      <Dialog class="relative z-50" @close="store.toggleRightSidebar(false)">
        <TransitionChild
          as="template"
          enter="transition-opacity ease-linear duration-300"
          enter-from="opacity-0"
          enter-to="opacity-100"
          leave="transition-opacity ease-linear duration-300"
          leave-from="opacity-100"
          leave-to="opacity-0"
        >
          <div class="fixed inset-0 bg-black/30" />
        </TransitionChild>
        <TransitionChild
          as="template"
          enter="transition ease-in-out duration-300 transform"
          enter-from="translate-x-full"
          enter-to="translate-x-0"
          leave="transition ease-in-out duration-300 transform"
          leave-from="translate-x-0"
          leave-to="translate-x-full"
        >
          <DialogPanel
            class="fixed inset-y-0 right-0 w-4/5 max-w-sm bg-white p-4 shadow-xl dark:bg-gray-800"
          >
            <slot name="right" />
          </DialogPanel>
        </TransitionChild>
      </Dialog>
    </TransitionRoot>
  </div>
</template>
