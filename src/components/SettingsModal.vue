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
        <label class="field-label mb-2">Cloud sync</label>
        <div class="flex items-center gap-2">
          <input
            v-model="syncKeyInput"
            type="password"
            autocomplete="off"
            placeholder="Sync passphrase"
            class="input"
            @keyup.enter="connectSync"
          />
          <button class="btn btn-primary shrink-0" @click="connectSync">Connect</button>
        </div>
        <p class="mt-2 text-xs text-gray-500">
          Status:
          <span class="font-medium">{{ sync.statusLabel }}</span>
          . Enter the same passphrase on each device to sync. On your Worker, set it once with
          <code class="rounded bg-gray-100 px-1">wrangler secret put SYNC_PASSWORD</code>
          (or leave blank if you use Cloudflare Access instead).
        </p>
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
import { reconnectCloudSync } from '../stores/cloudSync';
import { usePresetStore } from '../stores/presetStore';
import { useSyncStore } from '../stores/syncStore';
import BaseModal from './BaseModal.vue';

defineProps({
  isOpen: {
    type: Boolean,
    default: false,
  },
});

const store = usePresetStore();
const sync = useSyncStore();

const appVersion = import.meta.env.VITE_APP_VERSION || 'dev';

const syncKeyInput = ref(sync.syncKey || '');
const connectSync = async () => {
  sync.setSyncKey(syncKeyInput.value.trim());
  await reconnectCloudSync();
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
