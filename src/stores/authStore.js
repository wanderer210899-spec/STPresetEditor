import { defineStore } from 'pinia';

// Account/session state for cloud sync (separate from syncStore, which tracks
// only push/pull status). Talks to the worker's /api/auth/* + /api/keys
// endpoints. The session lives in an HttpOnly cookie, so we never hold a token
// here — `me` is the source of truth for "am I signed in".
const API = '/api';

async function call(path, { method = 'GET', body } = {}) {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      credentials: 'include', // send/receive the session cookie (also works cross-origin)
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data: data || {} };
  } catch {
    return { ok: false, status: 0, data: {} }; // network/offline
  }
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    checked: false, // have we asked the server yet?
    reachable: true, // false when the API can't be reached (local-only)
    authenticated: false,
    email: '',
    needsSetup: false, // no owner yet → show "Create account"
    keys: [], // API keys (no secrets, just metadata)
    newKey: null, // the plaintext of a just-generated key, shown once
  }),
  actions: {
    /** Ask the worker who we are; drives the whole UI. */
    async refresh() {
      const { ok, status, data } = await call('/auth/me');
      this.checked = true;
      this.reachable = status !== 0;
      if (ok && data.authenticated) {
        this.authenticated = true;
        this.email = data.email || '';
        this.needsSetup = false;
      } else {
        this.authenticated = false;
        this.email = '';
        this.needsSetup = Boolean(data.needsSetup);
      }
      return this.authenticated;
    },

    async register(email, password) {
      const r = await call('/auth/register', { method: 'POST', body: { email, password } });
      if (r.ok) await this.refresh();
      return r;
    },

    async login(email, password) {
      const r = await call('/auth/login', { method: 'POST', body: { email, password } });
      if (r.ok) await this.refresh();
      return r;
    },

    async logout() {
      const r = await call('/auth/logout', { method: 'POST' });
      await this.refresh();
      this.keys = [];
      this.newKey = null;
      return r;
    },

    async resetPassword(token, newPassword) {
      return call('/auth/emergency-reset', { method: 'POST', body: { token, newPassword } });
    },

    async loadKeys() {
      const r = await call('/keys');
      if (r.ok) this.keys = Array.isArray(r.data.keys) ? r.data.keys : [];
      return r;
    },

    async createKey(name) {
      const r = await call('/keys', { method: 'POST', body: { name } });
      if (r.ok) {
        this.newKey = r.data.key; // shown once
        await this.loadKeys();
      }
      return r;
    },

    dismissNewKey() {
      this.newKey = null;
    },

    async revokeKey(id) {
      const r = await call(`/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (r.ok) await this.loadKeys();
      return r;
    },
  },
});
