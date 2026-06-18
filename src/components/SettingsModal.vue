<template>
  <BaseModal
    :show="isOpen"
    :title="store.t('settings.title')"
    size="md"
    @close="store.closeSettingsModal()"
  >
    <div class="divide-y divide-gray-200">
      <!-- Language Setting -->
      <div class="pb-6">
        <label class="field-label mb-2">{{ store.t('toolbar.settings') }} - Language</label>
        <div class="flex items-center gap-2">
          <button
            class="btn btn-sm"
            :class="store.currentLanguage === 'en' ? 'btn-primary' : 'btn-secondary'"
            @click="store.setLanguage('en')"
          >
            EN
          </button>
          <button
            class="btn btn-sm"
            :class="store.currentLanguage === 'zh' ? 'btn-primary' : 'btn-secondary'"
            @click="store.setLanguage('zh')"
          >
            中文
          </button>
        </div>
      </div>

      <!-- Cloud Sync Setting -->
      <div class="py-6">
        <SyncSetup />
      </div>

      <!-- Delete Confirmation Setting -->
      <div class="py-6">
        <label class="flex items-center">
          <input
            type="checkbox"
            :checked="!store.skipDeleteConfirmation"
            class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            @change="toggleDeleteConfirmation"
          />
          <span class="ml-3 text-sm font-medium text-gray-700">
            {{ store.t('settings.showDeleteConfirmation') }}
          </span>
        </label>
        <p class="mt-1 text-xs text-gray-500">
          {{ store.t('settings.showDeleteConfirmationNote') }}
        </p>
      </div>

      <!-- Autocomplete Dictionary -->
      <div class="py-6">
        <label class="field-label mb-1">{{ store.t('settings.autocomplete.title') }}</label>
        <p class="mb-3 text-xs text-gray-500">{{ store.t('settings.autocomplete.note') }}</p>

        <!-- Custom macros -->
        <div class="mb-4">
          <p class="section-title mb-1">{{ store.t('settings.autocomplete.macrosTitle') }}</p>
          <ul v-if="store.customMacros.length" class="mb-2 space-y-1">
            <li
              v-for="m in store.customMacros"
              :key="m.name"
              class="flex items-center justify-between gap-2 rounded bg-gray-50 px-2 py-1 text-sm"
            >
              <span class="font-mono">{{ macroDisplay(m.name) }}</span>
              <span class="flex-1 truncate text-xs text-gray-400">{{ m.hint }}</span>
              <button
                class="btn-icon btn-icon-sm btn-icon-danger"
                :title="store.t('common.delete')"
                @click="store.removeCustomMacro(m.name)"
              >
                ✕
              </button>
            </li>
          </ul>
          <div class="flex items-center gap-2">
            <input
              v-model="macroName"
              class="input"
              :placeholder="store.t('settings.autocomplete.macroNamePlaceholder')"
              @keyup.enter="addMacro"
            />
            <input
              v-model="macroHint"
              class="input"
              :placeholder="store.t('settings.autocomplete.hintPlaceholder')"
              @keyup.enter="addMacro"
            />
            <button class="btn btn-secondary shrink-0" @click="addMacro">
              {{ store.t('common.add') }}
            </button>
          </div>
        </div>

        <!-- Wrapping pairs -->
        <div>
          <p class="section-title mb-1">{{ store.t('settings.autocomplete.wrapsTitle') }}</p>
          <p class="mb-1 text-xs text-gray-500">{{ store.t('settings.autocomplete.wrapsNote') }}</p>
          <ul v-if="store.customWraps.length" class="mb-2 space-y-1">
            <li
              v-for="(w, i) in store.customWraps"
              :key="i"
              class="flex items-center justify-between gap-2 rounded bg-gray-50 px-2 py-1 text-sm"
            >
              <span class="font-medium">{{ w.label }}</span>
              <span class="flex-1 truncate font-mono text-xs text-gray-500">
                {{ w.open }}…{{ w.close }}
              </span>
              <button
                class="btn-icon btn-icon-sm btn-icon-danger"
                :title="store.t('common.delete')"
                @click="store.removeCustomWrap(i)"
              >
                ✕
              </button>
            </li>
          </ul>
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model="wrapLabel"
              class="input w-32"
              :placeholder="store.t('settings.autocomplete.labelPlaceholder')"
              @keyup.enter="addWrap"
            />
            <input
              v-model="wrapOpen"
              class="input w-28 font-mono"
              :placeholder="store.t('settings.autocomplete.openPlaceholder')"
              @keyup.enter="addWrap"
            />
            <input
              v-model="wrapClose"
              class="input w-28 font-mono"
              :placeholder="store.t('settings.autocomplete.closePlaceholder')"
              @keyup.enter="addWrap"
            />
            <button class="btn btn-secondary shrink-0" @click="addWrap">
              {{ store.t('common.add') }}
            </button>
          </div>
        </div>

        <button class="btn btn-ghost btn-sm mt-3" @click="onResetDictionary">
          {{ store.t('settings.autocomplete.reset') }}
        </button>
      </div>

      <!-- Reset to Factory Default -->
      <div class="pt-6">
        <label class="field-label mb-2">{{ store.t('toolbar.resetToDefault') }}</label>
        <button class="btn btn-danger" @click="onResetToDefault">
          {{ store.t('toolbar.reset') }}
        </button>
        <p class="mt-2 text-xs text-gray-500">{{ store.t('reset.confirm') }}</p>
      </div>
    </div>

    <template #footer-start>
      <span class="text-xs text-gray-400" title="Deployed build (commit)">
        Build {{ appVersion }}
      </span>
    </template>
    <template #footer>
      <button class="btn btn-secondary" @click="store.closeSettingsModal()">
        {{ store.t('common.close') }}
      </button>
    </template>
  </BaseModal>
</template>

<script setup>
import { ref } from 'vue';
import { usePresetStore } from '../stores/presetStore';
import BaseModal from './BaseModal.vue';
import SyncSetup from './SyncSetup.vue';

defineProps({
  isOpen: {
    type: Boolean,
    default: false,
  },
});

const store = usePresetStore();

const appVersion = import.meta.env.VITE_APP_VERSION || 'dev';

// Custom autocomplete dictionary form state
const macroDisplay = (name) => `{{${name}}}`;
const macroName = ref('');
const macroHint = ref('');
const addMacro = () => {
  if (store.addCustomMacro({ name: macroName.value, hint: macroHint.value })) {
    macroName.value = '';
    macroHint.value = '';
  }
};

const wrapLabel = ref('');
const wrapOpen = ref('');
const wrapClose = ref('');
const addWrap = () => {
  if (
    store.addCustomWrap({
      label: wrapLabel.value,
      open: wrapOpen.value,
      close: wrapClose.value,
    })
  ) {
    wrapLabel.value = '';
    wrapOpen.value = '';
    wrapClose.value = '';
  }
};

const onResetDictionary = () => {
  store.requestConfirm({
    message: store.t('settings.autocomplete.resetConfirm'),
    confirmLabel: store.t('settings.autocomplete.reset'),
    danger: true,
    onConfirm: () => store.resetCustomDictionary(),
  });
};

const toggleDeleteConfirmation = (event) => {
  store.setSkipDeleteConfirmation(!event.target.checked);
};

const onResetToDefault = () => {
  store.requestConfirm({
    message: store.t('reset.confirm'),
    confirmLabel: store.t('toolbar.reset'),
    danger: true,
    onConfirm: () => {
      store.resetToFactoryDefault();
      store.closeSettingsModal();
    },
  });
};
</script>
