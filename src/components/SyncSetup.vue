<template>
  <div>
    <label class="field-label mb-2">{{ store.t('sync.title') }}</label>

    <!-- VS Code extension: connect with a Cloud URL + a pasted API key -->
    <template v-if="isExtension">
      <div v-if="!extConnected" class="space-y-2">
        <p class="text-xs text-gray-500">{{ store.t('sync.extIntro') }}</p>
        <input
          v-model="extUrl"
          type="text"
          spellcheck="false"
          :placeholder="store.t('sync.extUrlPlaceholder')"
          class="input"
        />
        <input
          v-model="extKey"
          type="password"
          autocomplete="off"
          :placeholder="store.t('sync.extKeyPlaceholder')"
          class="input"
          @keyup.enter="connectExt"
        />
        <button class="btn btn-primary" :disabled="busy" @click="connectExt">
          {{ busy ? store.t('sync.extConnecting') : store.t('sync.extConnect') }}
        </button>
        <p class="text-xs text-gray-500">{{ store.t('sync.extKeyHint') }}</p>
        <p v-if="message" class="text-xs" :class="error ? 'text-red-600' : 'text-green-600'">
          {{ message }}
        </p>
      </div>
      <div v-else>
        <div class="flex items-center justify-between">
          <p class="text-sm">
            {{ store.t('sync.signedInAs') }}
            <span class="font-medium">{{ extEmail }}</span>
          </p>
          <button class="btn btn-secondary btn-sm" :disabled="busy" @click="disconnectExt">
            {{ store.t('sync.extDisconnect') }}
          </button>
        </div>
        <p class="mt-1 text-xs text-gray-500">
          {{ store.t('sync.status') }}:
          <span class="font-medium">{{ sync.statusLabel }}</span>
        </p>
        <button class="btn btn-secondary btn-sm mt-2" :disabled="busy" @click="syncNow">
          {{ store.t('sync.extSyncNow') }}
        </button>
        <p class="mt-2 text-xs text-gray-500">{{ store.t('sync.extConnectedHint') }}</p>
      </div>
    </template>

    <!-- Web / mobile app: account sign-in + API-key management -->
    <template v-else>
      <!-- Signed OUT: sign in / create account -->
      <div v-if="!auth.authenticated">
        <p v-if="auth.needsSetup" class="mb-2 text-xs text-gray-500">
          {{ store.t('sync.createHint') }}
        </p>
        <div class="space-y-2">
          <input
            v-model="email"
            type="email"
            autocomplete="username"
            :placeholder="store.t('sync.emailPlaceholder')"
            class="input"
            @keyup.enter="submit"
          />
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            :placeholder="store.t('sync.passwordPlaceholder')"
            class="input"
            @keyup.enter="submit"
          />
          <div class="flex items-center gap-2">
            <button class="btn btn-primary shrink-0" :disabled="busy" @click="submit">
              {{ auth.needsSetup ? store.t('sync.createAccount') : store.t('sync.signIn') }}
            </button>
            <button class="btn btn-secondary btn-sm" type="button" @click="showReset = !showReset">
              {{ store.t('sync.forgotPassword') }}
            </button>
          </div>
        </div>

        <!-- Owner recovery (env-var backdoor) -->
        <div v-if="showReset" class="mt-3 rounded border border-gray-200 bg-gray-50 p-3">
          <p class="text-xs text-gray-600">{{ store.t('sync.resetInstructions') }}</p>
          <div class="mt-2 space-y-2">
            <input
              v-model="resetToken"
              type="text"
              :placeholder="store.t('sync.resetToken')"
              class="input"
            />
            <input
              v-model="resetPassword"
              type="password"
              autocomplete="new-password"
              :placeholder="store.t('sync.newPassword')"
              class="input"
            />
            <button class="btn btn-primary btn-sm" :disabled="busy" @click="doReset">
              {{ store.t('sync.resetSubmit') }}
            </button>
          </div>
        </div>

        <p v-if="message" class="mt-2 text-xs" :class="error ? 'text-red-600' : 'text-green-600'">
          {{ message }}
        </p>
        <p v-else class="mt-2 text-xs text-gray-500">{{ store.t('sync.localOnly') }}</p>
      </div>

      <!-- Signed IN: account + API keys -->
      <div v-else>
        <div class="flex items-center justify-between">
          <p class="text-sm">
            {{ store.t('sync.signedInAs') }}
            <span class="font-medium">{{ auth.email }}</span>
          </p>
          <button class="btn btn-secondary btn-sm" :disabled="busy" @click="doLogout">
            {{ store.t('sync.signOut') }}
          </button>
        </div>
        <p class="mt-1 text-xs text-gray-500">
          {{ store.t('sync.status') }}:
          <span class="font-medium">{{ sync.statusLabel }}</span>
        </p>

        <!-- API keys for the VS Code extension -->
        <div class="mt-4">
          <label class="field-label mb-1">{{ store.t('sync.apiKeysTitle') }}</label>
          <p class="text-xs text-gray-500">{{ store.t('sync.apiKeysNote') }}</p>

          <div class="mt-2 flex items-center gap-2">
            <input
              v-model="keyName"
              type="text"
              :placeholder="store.t('sync.keyNamePlaceholder')"
              class="input"
              @keyup.enter="doCreateKey"
            />
            <button class="btn btn-primary shrink-0" :disabled="busy" @click="doCreateKey">
              {{ store.t('sync.generateKey') }}
            </button>
          </div>

          <!-- The freshly generated key, shown once -->
          <div v-if="auth.newKey" class="mt-2 rounded border border-amber-300 bg-amber-50 p-2">
            <p class="text-xs font-medium text-amber-800">{{ store.t('sync.copyKeyNote') }}</p>
            <div class="mt-1 flex items-center gap-2">
              <code class="flex-1 truncate rounded bg-white px-2 py-1 text-xs">
                {{ auth.newKey }}
              </code>
              <button class="btn btn-secondary btn-sm shrink-0" @click="copyKey">
                {{ copied ? store.t('sync.copied') : store.t('sync.copy') }}
              </button>
            </div>
          </div>

          <!-- Existing keys -->
          <ul v-if="auth.keys.length" class="mt-2 divide-y divide-gray-100">
            <li v-for="k in auth.keys" :key="k.id" class="flex items-center justify-between py-1.5">
              <span class="text-xs text-gray-700">
                <span class="font-medium">{{ k.name || k.prefix }}</span>
                <span class="text-gray-400">· {{ k.prefix }}…</span>
              </span>
              <button class="btn btn-secondary btn-sm" @click="auth.revokeKey(k.id)">
                {{ store.t('sync.revoke') }}
              </button>
            </li>
          </ul>
          <p v-else class="mt-2 text-xs text-gray-400">{{ store.t('sync.noKeys') }}</p>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { reconnectCloudSync } from '../stores/cloudSync';
import {
  connectCloud,
  disconnectCloud,
  isVsCodeHost,
  pullLibraryNow,
  requestCloudState,
} from '../stores/localBridge';
import { useAuthStore } from '../stores/authStore';
import { usePresetStore } from '../stores/presetStore';
import { useSyncStore } from '../stores/syncStore';

const store = usePresetStore();
const auth = useAuthStore();
const sync = useSyncStore();

// VS Code extension mode: the webview can't ride the web session cookie, so the
// user pastes a Cloud URL + API key here and the host validates/holds it.
const isExtension = isVsCodeHost();
const extUrl = ref('');
const extKey = ref('');
const extConnected = ref(false);
const extEmail = ref('');

const email = ref('');
const password = ref('');
const busy = ref(false);
const message = ref('');
const error = ref(false);
const showReset = ref(false);
const resetToken = ref('');
const resetPassword = ref('');
const keyName = ref('');
const copied = ref(false);

// Map worker error codes to friendly, translated strings.
function explain(data) {
  const code = data && data.error;
  const key =
    {
      invalid_credentials: 'sync.errInvalidCreds',
      weak_password: 'sync.errWeakPassword',
      email_not_allowed: 'sync.errEmailNotAllowed',
      invalid_email: 'sync.errInvalidEmail',
      owner_exists: 'sync.errOwnerExists',
      invalid_token: 'sync.errInvalidToken',
      token_already_used: 'sync.errTokenUsed',
      reset_disabled: 'sync.errResetDisabled',
    }[code] || 'sync.errGeneric';
  return store.t(key);
}

async function submit() {
  busy.value = true;
  message.value = '';
  const r = auth.needsSetup
    ? await auth.register(email.value.trim(), password.value)
    : await auth.login(email.value.trim(), password.value);
  busy.value = false;
  if (r.ok) {
    password.value = '';
    error.value = false;
    await auth.loadKeys();
    await reconnectCloudSync(); // pull the cloud library now that we're authed
  } else {
    error.value = true;
    message.value = explain(r.data);
  }
}

async function doReset() {
  busy.value = true;
  message.value = '';
  const r = await auth.resetPassword(resetToken.value.trim(), resetPassword.value);
  busy.value = false;
  error.value = !r.ok;
  if (r.ok) {
    message.value = store.t('sync.resetDone');
    showReset.value = false;
    resetToken.value = '';
    resetPassword.value = '';
  } else {
    message.value = explain(r.data);
  }
}

async function doLogout() {
  busy.value = true;
  await auth.logout();
  busy.value = false;
  await reconnectCloudSync(); // drop to local-only
}

async function doCreateKey() {
  busy.value = true;
  await auth.createKey(keyName.value.trim());
  busy.value = false;
  keyName.value = '';
}

function copyKey() {
  if (!auth.newKey) return;
  navigator.clipboard?.writeText(auth.newKey);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

// Map host connect failures to friendly, translated strings.
function explainExt(reason) {
  const key =
    {
      no_url: 'sync.extErrNoUrl',
      no_key: 'sync.extErrNoKey',
      invalid_key: 'sync.extErrInvalidKey',
      unreachable: 'sync.extErrUnreachable',
      bad_response: 'sync.extErrUnreachable',
      timeout: 'sync.extErrUnreachable',
    }[reason] || 'sync.extErrGeneric';
  return store.t(key);
}

async function connectExt() {
  busy.value = true;
  message.value = '';
  const r = await connectCloud(extUrl.value.trim(), extKey.value.trim());
  busy.value = false;
  if (r.ok) {
    extConnected.value = true;
    extEmail.value = r.email || '';
    extKey.value = ''; // never keep the plaintext key around
    error.value = false;
  } else {
    error.value = true;
    message.value = explainExt(r.reason);
  }
}

async function disconnectExt() {
  busy.value = true;
  await disconnectCloud();
  busy.value = false;
  extConnected.value = false;
  extEmail.value = '';
  message.value = '';
}

// Manually pull the cloud library down into this editor (the open file is untouched).
function syncNow() {
  pullLibraryNow();
}

onMounted(async () => {
  if (isExtension) {
    // Ask the host for the saved URL + whether the stored key still validates.
    const state = await requestCloudState();
    extUrl.value = state.url || '';
    extConnected.value = Boolean(state.connected);
    extEmail.value = state.email || '';
    return;
  }
  if (!auth.checked) await auth.refresh();
  if (auth.authenticated) await auth.loadKeys();
});
</script>
