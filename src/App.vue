<script setup>
import { onBeforeUnmount, onMounted } from 'vue';
import AppLayout from './components/AppLayout.vue';
import AppToolbar from './components/AppToolbar.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import FocusEditorModal from './components/FocusEditorModal.vue';
import GlobalSearchModal from './components/GlobalSearchModal.vue';
import JsonExportModal from './components/JsonExportModal.vue';
import JsonImportModal from './components/JsonImportModal.vue';
import LeftSidebar from './components/LeftSidebar/PromptLibrary.vue';
import EditorView from './components/MainEditor/EditorView.vue';
import PresetManagerModal from './components/PresetManagerModal.vue';
import RightSidebar from './components/RightSidebar/RightSidebar.vue';
import SettingsModal from './components/SettingsModal.vue';
import ToastHost from './components/ToastHost.vue';
import { usePresetStore } from './stores/presetStore';

// Initialize the preset store. App startup (cloud reconcile + example fallback)
// is handled in main.js so the cloud library loads before any default content.
const store = usePresetStore();

// Global shortcuts (F6): Ctrl/Cmd+F focuses the editor search, Ctrl/Cmd+K
// opens the cross-preset search palette.
const onGlobalKeydown = (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === 'k') {
    event.preventDefault();
    store.openGlobalSearch();
  } else if (key === 'f' && !store.isGlobalSearchOpen) {
    event.preventDefault();
    document.getElementById('editor-search-input')?.focus();
  }
};
onMounted(() => window.addEventListener('keydown', onGlobalKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown));
</script>

<template>
  <!-- Main application container with full height layout -->
  <div
    id="app-container"
    class="flex h-screen flex-col bg-gray-100 font-sans text-gray-800 dark:bg-gray-900 dark:text-gray-200"
  >
    <!-- Application header with toolbar -->
    <header
      class="relative z-10 flex-shrink-0 bg-white px-3 py-1.5 shadow-md md:py-1 dark:bg-gray-800"
    >
      <AppToolbar />
    </header>

    <!-- Main layout with three sections: left sidebar, main editor, right sidebar -->
    <AppLayout class="flex-grow overflow-hidden">
      <!-- Left sidebar: Prompt library for browsing and managing prompts -->
      <template #left>
        <LeftSidebar />
      </template>

      <!-- Main editor: Central area for editing and organizing prompts -->
      <template #main>
        <EditorView />
      </template>

      <!-- Right sidebar: Details view and variable management -->
      <template #right>
        <RightSidebar />
      </template>
    </AppLayout>

    <!-- Global modals for import/export functionality -->
    <JsonImportModal />
    <JsonExportModal />
    <PresetManagerModal :is-open="store.isPresetManagerOpen" />
    <SettingsModal :is-open="store.isSettingsModalOpen" />

    <!-- Distraction-free focus editor (opened from a prompt card) -->
    <FocusEditorModal />

    <!-- Cross-preset search palette (Ctrl/Cmd+K) -->
    <GlobalSearchModal />

    <!-- Global in-app confirmation dialog + toast notifications -->
    <ConfirmDialog />
    <ToastHost />
  </div>
</template>

<style>
body {
  margin: 0;
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}
</style>
