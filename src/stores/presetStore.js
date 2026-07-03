import { debounce } from 'lodash-es';
import { defineStore } from 'pinia';
import languageData from '../assets/languages.json';
import { isVsCodeHost } from '../utils/host';
import { VAR_MACRO_NAMES, classifyMacro, tokenizeMacros } from '../utils/macros';
import { estimateTokens } from '../utils/tokens';

/**
 * Holders for the in-app confirmation dialog's callbacks. Kept out of reactive
 * Pinia state because they are transient function references, not data.
 * @type {null | ((result: { skip: boolean }) => void)}
 */
let confirmCallback = null;
/** @type {null | (() => void)} */
let confirmCancelCallback = null;
/** @type {null | (() => void)} Called on Esc/backdrop dismissal when the caller
 *  distinguishes "dismiss" from the explicit cancel button (falls back to onCancel). */
let confirmDismissCallback = null;

/**
 * The state paths that make up a user's portable data and are synced to the
 * cloud (Cloudflare KV) so the same library is available on every device.
 * UI-only and derived state are intentionally excluded.
 */
export const SYNC_DATA_PATHS = [
  'rawJson',
  'originalFilename',
  'prompts',
  'promptOrder',
  'macroDisplayMode',
  'currentLanguage',
  'promptCollapseStates',
  'globalCollapseState',
  'skipDeleteConfirmation',
  'savedPresets',
  'currentPresetId',
  'defaultPresetId',
  'customMacros',
  'customWraps',
  'themeMode',
];

/**
 * Paths that are NOT synced by the VS Code extension. The extension edits a
 * local .json file directly — that file IS the active editing area — so these
 * active-area / per-file paths stay local and only the portable library (saved
 * presets) + preferences sync to the cloud. See stores/localBridge.js.
 */
const EXTENSION_LOCAL_ONLY_PATHS = [
  'rawJson',
  'originalFilename',
  'prompts',
  'promptOrder',
  'promptCollapseStates',
  'globalCollapseState',
];

/**
 * The library-only subset synced by the VS Code extension (cloud = central drive
 * for the saved-preset library + prefs, never the open file).
 */
export const EXTENSION_LIBRARY_PATHS = SYNC_DATA_PATHS.filter(
  (key) => !EXTENSION_LOCAL_ONLY_PATHS.includes(key),
);

/**
 * Seed set of wrapping/paired autocomplete snippets. Users can add their own and
 * delete these from Settings. `open`/`close` are inserted around the caret (or
 * the current selection). Kept as a factory so a fresh copy is used on reset.
 * @returns {{ label: string, open: string, close: string, hint: string }[]}
 */
export const defaultCustomWraps = () => [
  { label: 'HTML comment', open: '<!-- ', close: ' -->', hint: 'comment ignored by the model' },
  { label: 'Block comment', open: '{{// ', close: ' /// }}', hint: 'multi-line ST comment' },
  { label: 'if … /if', open: '{{if }}', close: '{{/if}}', hint: 'conditional block' },
  { label: 'XML example', open: '<example>\n', close: '\n</example>', hint: 'wrap an example' },
];

/** Maximum stored snapshots per preset; creating one past the cap prunes the oldest. */
export const MAX_SNAPSHOTS_PER_PRESET = 20;

/** Deep-clone store data to plain JSON (strips Vue reactive proxies). */
const toPlainClone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Snapshot the active editing area in the shape stored inside a library entry.
 * The derived `macros` arrays are excluded (re-attached by analyzeAllMacros on
 * load), as is `macroDisplayMode` — a preference, not preset data.
 */
function activeAreaData(state) {
  const prompts = {};
  Object.entries(state.prompts || {}).forEach(([id, prompt]) => {
    // eslint-disable-next-line no-unused-vars
    const { macros, ...rest } = prompt;
    prompts[id] = toPlainClone(rest);
  });
  return {
    rawJson: state.rawJson,
    originalFilename: state.originalFilename,
    prompts,
    promptOrder: [...(state.promptOrder || [])],
    promptCollapseStates: toPlainClone(state.promptCollapseStates || {}),
  };
}

/**
 * Compose an exportable SillyTavern preset JSON from stored editor data
 * ({ rawJson, prompts, promptOrder }). Shared by the finalJson getter (active
 * area) and by-preset export (Preset Manager / VS Code open-as-file).
 * @returns {string} pretty-printed JSON
 */
function composePresetJson({ rawJson, prompts, promptOrder }) {
  const preset = JSON.parse(rawJson || '{}');

  // Create a clean version of prompts for export, removing internal-use properties
  const cleanedPrompts = Object.values(prompts || {}).map((p) => {
    // eslint-disable-next-line no-unused-vars
    const { macros, ...rest } = p;
    return rest;
  });

  preset.prompts = cleanedPrompts;

  // Regenerate prompt_order based on current editor state
  // Only include prompts that are in the editor (promptOrder array)
  const editorPrompts = (promptOrder || [])
    .map((id) => ({
      identifier: id,
      enabled: prompts[id]?.enabled !== false,
    }))
    .filter((item) => prompts[item.identifier]); // Ensure prompt exists

  // Create or update prompt_order configuration
  if (Array.isArray(preset.prompt_order)) {
    // Prioritize updating character_id: 100001 order
    let characterOrderIndex = preset.prompt_order.findIndex((item) => item.character_id === 100001);

    // If 100001 not found, use the first available
    if (characterOrderIndex === -1 && preset.prompt_order.length > 0) {
      characterOrderIndex = 0;
    }

    if (characterOrderIndex !== -1) {
      preset.prompt_order[characterOrderIndex].order = editorPrompts;
    } else {
      // If no available order configuration found, create new one
      preset.prompt_order.push({
        character_id: 100001,
        order: editorPrompts,
      });
    }
  } else {
    // If no prompt_order exists, create a default one
    preset.prompt_order = [
      {
        character_id: 100001,
        order: editorPrompts,
      },
    ];
  }

  return JSON.stringify(preset, null, 2);
}

/**
 * @typedef {object} MacroData
 * @property {string} id - A unique identifier for this specific macro instance, e.g., "promptId-charIndex".
 * @property {string} full - The full, original macro string, e.g., "{{setvar::x::10}}".
 * @property {number} [start] - Start offset of `full` within the prompt content.
 * @property {number} [end] - End offset (exclusive) of `full` within the prompt content.
 * @property {string} type - The parsed type of the macro, e.g., "setvar", "getvar", "comment", "random".
 * @property {string|null} varName - The variable name, if applicable (variable macros).
 * @property {string|null} value - The value being set, if applicable (set/add macros).
 * @property {string[]} params - An array of parameters for other macro types like "random::a::b".
 * @property {'local'|'global'|null} [scope] - Variable scope for variable macros.
 * @property {'get'|'set'|'mutate'|null} [kind] - Whether the variable macro reads, writes, or both.
 * @property {string|null} [op] - Normalised variable operation (get/set/add/sub/inc/dec/setIfNull/setIfFalsy/has/delete/control).
 * @property {string[]} [refs] - Variable names referenced inside a conditional/nested macro.
 */

/**
 * @typedef {Object} PartialPrompt
 * @property {string} id - Unique identifier for the prompt
 * @property {string} [content] - The text content of the prompt
 * @property {MacroData[]} [macros] - Array of parsed macros found in the content
 */

/**
 * Helper function to create a debounced action wrapper
 * @param {Function} action - The function to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {Function} Debounced function
 */
function debouncedAction(action, delay) {
  const debounced = debounce(action, delay);
  return function (...args) {
    debounced.call(this, ...args);
  };
}

/**
 * Main Pinia store for managing preset data and application state
 * Handles prompt management, macro analysis, variable tracking, and UI state
 */
export const usePresetStore = defineStore('preset', {
  state: () => ({
    // Core data properties
    rawJson: '', // Raw JSON string of the imported preset
    originalFilename: '', // Original filename of the imported preset
    prompts: {}, // Object containing all prompts keyed by ID
    promptOrder: [], // Array of prompt IDs in execution order
    selectedPromptId: null, // Currently selected prompt ID
    selectedMacro: null, // Currently selected macro for details view
    viewOptions: {
      renderMacros: true, // Whether to render macros in the UI
    },

    // Variable management
    variables: {}, // Object containing variable definitions and references
    unresolvedVariables: [], // Array of variables that are referenced but not defined
    macroStateSnapshots: {}, // Stores the value of each getvar at its execution point
    variableEndValues: {}, // Simulated value of each variable after the full pass (F4, derived)
    variableTimelines: {}, // Ordered def/ref events per variable in execution order (F4, derived)

    // Multi-selection state
    isMultiSelectActive: false, // Whether multi-selection mode is active
    selectedLibraryPrompts: [], // Array of selected prompt IDs in library view

    // Editor multi-selection state
    isEditorMultiSelectActive: false, // Off by default; toggled to reveal checkboxes + the contextual batch bar
    selectedEditorPrompts: [], // Array of selected prompt IDs in editor view

    // Search functionality
    librarySearchTerm: '', // Search term for the prompt library
    editorSearchTerm: '', // Search term for the main editor
    editorSearchActiveIndex: -1, // Current hit in editorSearchMatches (-1 = none yet)
    searchVisitPromptId: null, // Prompt temporarily expanded while search-navigation visits it
    isGlobalSearchOpen: false, // Ctrl/Cmd+K palette across all presets
    scrollToPromptId: null, // ID of prompt to scroll to (for navigation)
    scrollToLibraryPromptId: null, // ID of prompt to scroll to in the left library

    // UI state
    activeRightSidebarTab: 'details', // Active tab in right sidebar: 'details' or 'variables'
    macroDisplayMode: 'raw', // Macro display mode: 'raw' or 'preview'

    // Mobile layout state
    isLeftSidebarOpen: false, // Whether left sidebar is open on mobile
    isRightSidebarOpen: false, // Whether right sidebar is open on mobile

    // Desktop 3-pane layout (persisted locally, never synced — device-specific)
    paneSizes: [20, 50, 30], // Splitpanes [left, main, right] percentages
    isRightPaneMaximized: false, // Right pane expanded to 60% (F7)
    _paneSizesBackup: null, // Sizes to restore when un-maximizing

    // Modal visibility state
    isImportModalOpen: false, // Whether import modal is visible
    isExportModalOpen: false, // Whether export modal is visible
    isSettingsModalOpen: false, // Whether settings modal is visible
    isBatchReplaceModalOpen: false, // Whether batch replace modal is visible
    focusEditorPromptId: null, // Prompt being edited in the distraction-free focus editor

    // In-app confirmation dialog (replaces native window.confirm)
    confirmState: {
      open: false,
      title: '',
      message: '',
      confirmLabel: '',
      cancelLabel: '',
      danger: false,
      showSkip: false, // Show a "don't ask again" checkbox
      skipLabel: '',
      skipChecked: false,
    },

    // Transient toast notifications (replaces native alert)
    toasts: [], // Array of { id, message, type: 'info' | 'success' | 'error' }
    _toastSeq: 0,

    // Responsive state
    isMobile: false, // Whether the app is in mobile view

    // Collapse state management
    globalCollapseState: 'expanded', // Global collapse state: 'expanded', 'collapsed', or 'mixed'
    promptCollapseStates: {}, // Individual prompt collapse states: { promptId: boolean }

    // Internationalization
    currentLanguage: 'en', // Current language: 'en' or 'zh'

    // User preferences
    skipDeleteConfirmation: false, // Whether to skip delete confirmation dialog
    themeMode: 'system', // 'light' | 'dark' | 'system' — ignored in the VS Code webview (follows the editor theme)

    // Custom autocomplete dictionary (additive; persisted + synced)
    customMacros: [], // Array<{ name, hint }> — extra {{name}} macros for the {{ menu
    customWraps: defaultCustomWraps(), // Array<{ label, open, close, hint }> — paired notations

    // Preset management
    savedPresets: {}, // Object containing saved presets: { presetId: { name, data, createdAt, updatedAt } }
    currentPresetId: null, // ID of currently loaded preset
    isPresetManagerOpen: false, // Whether preset manager modal is open
    defaultPresetId: null, // ID of the default preset (factory settings)

    // Preset manager UI state
    presetSearchTerm: '', // Search term for preset manager
    presetSortBy: 'updated', // Sort by: 'name', 'created', 'updated'
    presetMultiSelectActive: false, // Whether multi-select mode is active
    selectedPresets: new Set(), // Set of selected preset IDs
    // Batch replace history for undo
    batchReplaceHistory: [], // Array<{ timestamp, changes: Array<{ promptId, before: { name, content }, after: { name, content } }> }>
    batchReplaceRedoStack: [], // Redo stack storing same shape as history entries
  }),
  getters: {
    /**
     * Get a prompt by its ID
     * @param {Object} state - The store state
     * @returns {Function} Function that takes an ID and returns the prompt
     */
    getPromptById: (state) => (id) => {
      return state.prompts[id];
    },

    /**
     * Check if a prompt is in the current order
     * @param {Object} state - The store state
     * @returns {Function} Function that takes a prompt ID and returns boolean
     */
    isPromptInOrder: (state) => (promptId) => {
      return state.promptOrder.includes(promptId);
    },

    /**
     * Get all defined variable names sorted alphabetically
     * @param {Object} state - The store state
     * @returns {string[]} Array of variable names
     */
    definedVariables: (state) => {
      return Object.keys(state.variables).sort();
    },

    /**
     * Get prompts in execution order with search filtering
     * @param {Object} state - The store state
     * @returns {Object[]} Array of prompts in order, filtered by search term
     */
    orderedPrompts: (state) => {
      const prompts = state.promptOrder
        .map((id) => (state.prompts[id] ? { ...state.prompts[id], id } : null))
        .filter((p) => p !== null);

      // If no search term, return all prompts
      if (!state.editorSearchTerm) {
        return prompts;
      }

      // Filter prompts by search term (name, ID, or content — F6a)
      const searchTerm = state.editorSearchTerm.toLowerCase();
      return prompts.filter(
        (p) =>
          (p.name || '').toLowerCase().includes(searchTerm) ||
          (p.content || '').toLowerCase().includes(searchTerm) ||
          String(p.id || '')
            .toLowerCase()
            .includes(searchTerm),
      );
    },

    /**
     * Flat list of editor-search hits for find-next navigation (F6b): one
     * entry per occurrence of the term (name + content), in execution order.
     * A prompt matching only by id contributes a single entry.
     * @returns {string[]} prompt ids, repeated once per occurrence
     */
    editorSearchMatches: (state) => {
      const q = (state.editorSearchTerm || '').toLowerCase();
      if (!q) return [];
      const countIn = (text) => {
        let n = 0;
        let i = 0;
        while ((i = text.indexOf(q, i)) !== -1) {
          n += 1;
          i += q.length;
        }
        return n;
      };
      const hits = [];
      state.promptOrder.forEach((id) => {
        const p = state.prompts[id];
        if (!p) return;
        let count =
          countIn((p.name || '').toLowerCase()) + countIn((p.content || '').toLowerCase());
        if (
          count === 0 &&
          String(p.id || '')
            .toLowerCase()
            .includes(q)
        )
          count = 1;
        for (let k = 0; k < count; k += 1) hits.push(id);
      });
      return hits;
    },

    /** "N matches in M prompts" numbers for the editor search box (F6a). */
    editorSearchStats() {
      const hits = this.editorSearchMatches;
      return { matches: hits.length, prompts: new Set(hits).size };
    },

    /** Approximate token total of enabled, in-order prompts (F8d). */
    enabledTokenTotal: (state) => {
      return state.promptOrder.reduce((sum, id) => {
        const p = state.prompts[id];
        if (!p || p.enabled === false) return sum;
        return sum + estimateTokens(p.content || '');
      }, 0);
    },

    /**
     * Get all prompts for library view with search filtering
     * @param {Object} state - The store state
     * @returns {Object[]} Array of all prompts sorted by name, filtered by search term
     */
    libraryPrompts: (state) => {
      const allPrompts = Object.values(state.prompts).sort((a, b) =>
        (a.name || '').localeCompare(b.name || ''),
      );
      if (!state.librarySearchTerm) {
        return allPrompts;
      }
      const searchTerm = state.librarySearchTerm.toLowerCase();
      return allPrompts.filter(
        (p) =>
          (p.name || '').toLowerCase().includes(searchTerm) ||
          (p.content || '').toLowerCase().includes(searchTerm) ||
          String(p.id || '')
            .toLowerCase()
            .includes(searchTerm),
      );
    },
    /**
     * Generate the final JSON for export based on current editor state
     * @param {Object} state - The store state
     * @returns {string} JSON string ready for export
     */
    finalJson: (state) => {
      return composePresetJson({
        rawJson: state.rawJson,
        prompts: state.prompts,
        promptOrder: state.promptOrder,
      });
    },
    /**
     * Get variable statistics for the variable manager
     * @param {Object} state - The store state
     * @returns {Object} Object containing undefined and unreferenced variable counts
     */
    variableStats: (state) => {
      // Calculate the number of variables that are defined but never referenced
      const unreferencedCount = Object.values(state.variables).filter(
        (v) => v.definedIn.length > 0 && v.referencedIn.length === 0,
      ).length;

      return {
        // The count of variables that are referenced but never defined
        undefinedCount: state.unresolvedVariables.length,
        unreferencedCount: unreferencedCount,
      };
    },

    /**
     * Get all saved presets as an array with search and sort filtering
     * @param {Object} state - The store state
     * @returns {Object[]} Array of saved presets
     */
    savedPresetsList: (state) => {
      let presets = Object.entries(state.savedPresets).map(([id, preset]) => ({ id, ...preset }));

      // Apply search filter
      if (state.presetSearchTerm) {
        const searchTerm = state.presetSearchTerm.toLowerCase();
        presets = presets.filter((preset) => preset.name.toLowerCase().includes(searchTerm));
      }

      // Apply sorting
      switch (state.presetSortBy) {
        case 'name':
          presets.sort((a, b) => a.name.localeCompare(b.name));
          break;
        case 'created':
          presets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          break;
        case 'updated':
        default:
          presets.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
          break;
      }

      return presets;
    },

    // --- Helpers for reactive multi-select rendering ---
    isPresetSelected: (state) => (presetId) => {
      const sel = state.selectedPresets;
      if (!sel) return false;
      if (sel instanceof Set) return sel.has(presetId);
      if (Array.isArray(sel)) return sel.includes(presetId);
      if (typeof sel === 'object') return Boolean(sel[presetId]);
      return false;
    },
    selectedPresetsCount: (state) => {
      const sel = state.selectedPresets;
      if (!sel) return 0;
      if (sel instanceof Set) return sel.size;
      if (Array.isArray(sel)) return sel.length;
      if (typeof sel === 'object') return Object.keys(sel).length;
      return 0;
    },

    /**
     * Get current preset name
     * @param {Object} state - The store state
     * @returns {string|null} Current preset name or null
     */
    currentPresetName: (state) => {
      if (!state.currentPresetId || !state.savedPresets[state.currentPresetId]) {
        return null;
      }
      return state.savedPresets[state.currentPresetId].name;
    },

    /**
     * Get current file name for preset naming
     * @param {Object} state - The store state
     * @returns {string} Current file name or default name
     */
    getCurrentPresetName: (state) => {
      if (state.originalFilename) {
        // Remove file extension
        return state.originalFilename.replace(/\.[^/.]+$/, '');
      }
      // Return default name directly to avoid calling other getters
      return 'Untitled Preset';
    },

    /**
     * Translation function for internationalization
     * @param {Object} state - The store state
     * @returns {Function} Function that takes a key and optional parameters and returns translated text
     */
    t:
      (state) =>
      (key, params = {}) => {
        const keys = key.split('.');
        let value = languageData[state.currentLanguage];
        for (const k of keys) {
          value = value?.[k];
        }
        if (!value) return key;

        // Replace parameters in the string
        let result = value;
        for (const [paramKey, paramValue] of Object.entries(params)) {
          result = result.replace(`{${paramKey}}`, paramValue);
        }
        return result;
      },
    /** Whether there is a batch replace operation to undo */
    canUndoBatchReplace: (state) => {
      return (state.batchReplaceHistory?.length || 0) > 0;
    },
    canRedoBatchReplace: (state) => {
      return (state.batchReplaceRedoStack?.length || 0) > 0;
    },
  },
  actions: {
    // --- Initialization and Core Logic ---

    /**
     * Initialize the store with default data when no persisted data exists
     * @param {string} jsonString - JSON string of the default preset data
     */
    initializeDefaultData(jsonString) {
      // This is called only when no persisted data exists
      console.log('[Persistence] No persisted data found, loading default example.json');
      this.parseFromJson(jsonString);
    },

    /**
     * Import new JSON data from user
     * @param {string} jsonString - JSON string to import
     * @param {string} filename - Original filename of the imported data
     */
    importNewJson(jsonString, filename = '') {
      // This is called when user imports new JSON
      // It will automatically be persisted by the plugin
      console.log('[Persistence] User imported new JSON, will be auto-saved');
      this.originalFilename = filename;
      this.parseFromJson(jsonString);
    },
    /**
     * Parse JSON data and populate the store
     * @param {string} jsonString - JSON string to parse
     */
    parseFromJson(jsonString) {
      try {
        this.rawJson = jsonString;
        const parsed = JSON.parse(jsonString);
        const promptsArray = Array.isArray(parsed.prompts) ? parsed.prompts : [];

        // Build prompts object from array
        this.prompts = promptsArray.reduce((acc, prompt) => {
          const id = prompt.identifier || prompt.name;
          if (id) acc[id] = { ...prompt, id };
          return acc;
        }, {});

        // Process prompt_order sorting
        if (Array.isArray(parsed.prompt_order)) {
          // Prioritize character_id: 100001 order, fallback to first available
          let characterOrder = parsed.prompt_order.find((item) => item.character_id === 100001);
          if (!characterOrder && parsed.prompt_order.length > 0) {
            characterOrder = parsed.prompt_order[0];
          }

          if (characterOrder && Array.isArray(characterOrder.order)) {
            const orderData = characterOrder.order;

            // Build promptOrder array based on prompt_order sequence
            this.promptOrder = orderData
              .map((item) => item.identifier)
              .filter((id) => id in this.prompts);

            // Set enabled state for each prompt
            orderData.forEach((item) => {
              if (this.prompts[item.identifier]) {
                this.prompts[item.identifier].enabled = item.enabled;
              }
            });

            // Add prompts that exist but are not in prompt_order
            const orderedIds = new Set(this.promptOrder);
            const unorderedPrompts = Object.values(this.prompts)
              .filter((p) => !orderedIds.has(p.id))
              .sort((a, b) => {
                // Sort by injection_order, then system_prompt, then name
                const orderA = a.injection_order || 0;
                const orderB = b.injection_order || 0;
                if (orderA !== orderB) return orderA - orderB;
                if (a.system_prompt !== b.system_prompt) return b.system_prompt - a.system_prompt;
                return (a.name || '').localeCompare(b.name || '');
              });

            // Add unordered prompts to the end
            this.promptOrder.push(...unorderedPrompts.map((p) => p.id));
          } else {
            // If no valid prompt_order, use default sorting
            this.promptOrder = promptsArray
              .filter((p) => p.enabled !== false)
              .sort((a, b) => (a.injection_order || 0) - (b.injection_order || 0))
              .map((p) => p.identifier || p.name)
              .filter(Boolean);
          }
        } else {
          // If no prompt_order exists, use default sorting
          this.promptOrder = promptsArray
            .filter((p) => p.enabled !== false)
            .sort((a, b) => (a.injection_order || 0) - (b.injection_order || 0))
            .map((p) => p.identifier || p.name)
            .filter(Boolean);
        }

        this.analyzeAllMacros();
      } catch (error) {
        console.error('Failed to parse JSON string:', error);
        this.prompts = {};
        this.promptOrder = [];
      }
    },

    /**
     * Reset the application to factory default settings
     * Only resets current editing content, preserves saved presets
     */
    async resetToFactoryDefault() {
      console.log(
        '[resetToFactoryDefault] Resetting to factory default while preserving saved presets...',
      );

      // Preserve currently saved presets
      const savedPresets = this.savedPresets;
      const defaultPresetId = this.defaultPresetId;

      try {
        // Load factory settings data
        const factoryData = await import('../assets/example.json');

        // Parse factory settings JSON
        const jsonString = JSON.stringify(factoryData.default || factoryData);
        const parsed = JSON.parse(jsonString);
        const promptsArray = Array.isArray(parsed.prompts) ? parsed.prompts : [];

        // Build prompts object
        const prompts = promptsArray.reduce((acc, prompt) => {
          const id = prompt.identifier || prompt.name;
          if (id) acc[id] = { ...prompt, id };
          return acc;
        }, {});

        // Build promptOrder array
        let promptOrder = [];
        if (Array.isArray(parsed.prompt_order)) {
          let characterOrder = parsed.prompt_order.find((item) => item.character_id === 100001);
          if (!characterOrder && parsed.prompt_order.length > 0) {
            characterOrder = parsed.prompt_order[0];
          }

          if (characterOrder && Array.isArray(characterOrder.order)) {
            promptOrder = characterOrder.order
              .map((item) => item.identifier)
              .filter((id) => id in prompts);
          }
        }

        // Reset editor content to factory settings
        this.rawJson = jsonString;
        this.originalFilename = 'factory-default.json';
        this.prompts = prompts;
        this.promptOrder = promptOrder;
        this.macroDisplayMode = 'raw';
        this.promptCollapseStates = {};
        this.currentPresetId = null;

        // Restore user's saved presets metadata
        this.savedPresets = savedPresets;
        this.defaultPresetId = defaultPresetId;

        // Re-analyze macros
        this.analyzeAllMacros();

        console.log(
          '[resetToFactoryDefault] Reset to factory default completed, saved presets preserved',
        );
      } catch (error) {
        console.error('[resetToFactoryDefault] Failed to load factory settings:', error);
      }
    },

    // --- Unified Macro Analysis ---

    /**
     * Analyze all macros in the current prompt order
     * This is the core function that parses macros, tracks variables, and simulates execution
     */
    analyzeAllMacros() {
      console.log('[analyzeAllMacros] Starting analysis macros...');

      // --- Pre-analysis: Clear stale macro data from all prompts ---
      Object.values(this.prompts).forEach((p) => {
        p.macros = [];
      });

      // --- Pass 1: Parse macros only for prompts currently in the order ---
      // tokenizeMacros balances nested braces, so a macro whose value contains
      // another macro (or XML, or spans lines) is captured whole.
      this.promptOrder.forEach((promptId) => {
        /** @type {PartialPrompt} */
        const prompt = this.prompts[promptId];
        if (!prompt) return;

        const content = prompt.content || '';
        /** @type {MacroData[]} */
        const macros = tokenizeMacros(content).map((token) => ({
          id: `${prompt.id}-${token.start}`,
          full: token.full,
          start: token.start,
          end: token.end,
          ...classifyMacro(token.inner),
        }));

        prompt.macros = macros; // Attach parsed macros
      });

      // --- Pass 2: Consolidated Analysis (based on promptOrder) ---
      const allVarNames = new Set();
      const definitions = {}; // { varName: [{ promptId, enabled }, ...] }
      const references = {}; // { varName: [{ promptId, enabled }, ...] }

      // --- Pass 3: Simulation and Aggregation ---
      const newSnapshots = {};
      const newTimelines = {}; // varName -> ordered events (F4)
      let currentVarState = {};

      // Build the full execution flow for value lookups first
      /** @type {MacroData[]} */
      const executionFlowMacros = this.promptOrder.flatMap(
        (promptId) => this.prompts[promptId]?.macros || [],
      );

      // Numeric add when both sides parse as numbers, else string concatenation
      // (mirrors SillyTavern's addvar behaviour).
      const addValues = (prev, delta) => {
        const a = parseFloat(prev);
        const b = parseFloat(delta);
        if (!Number.isNaN(a) && !Number.isNaN(b)) return String(a + b);
        return `${prev ?? ''}${delta ?? ''}`;
      };
      const stepValue = (prev, step) => String((parseFloat(prev) || 0) + step);
      const subValues = (prev, delta) => String((parseFloat(prev) || 0) - (parseFloat(delta) || 0));

      executionFlowMacros.forEach((macro) => {
        const ownerPrompt = this.prompts[macro.id.split('-').slice(0, -1).join('-')];
        const ownerEnabled = ownerPrompt?.enabled !== false;

        // Variables read inside conditionals / nested macros (e.g. {{if .flag}})
        // count as references so they are not flagged unresolved.
        if (macro.refs && macro.refs.length && ownerPrompt) {
          macro.refs.forEach((refName) => {
            allVarNames.add(refName);
            if (!references[refName]) references[refName] = [];
            references[refName].push({ promptId: ownerPrompt.id, enabled: ownerEnabled });
          });
        }

        // Only variable macros (get/set/add/inc/dec/has/delete) participate below.
        if (!macro.varName || !macro.kind) return;

        allVarNames.add(macro.varName);
        const prompt = ownerPrompt;
        const enabled = prompt.enabled !== false;
        const refInfo = { promptId: prompt.id, enabled };

        // set/add/inc/dec define (assign); get/add/inc/dec reference (read).
        const writes = macro.kind === 'set' || macro.kind === 'mutate';
        const reads = macro.kind === 'get' || macro.kind === 'mutate';
        if (writes) {
          if (!definitions[macro.varName]) definitions[macro.varName] = [];
          definitions[macro.varName].push(refInfo);
        }
        if (reads) {
          if (!references[macro.varName]) references[macro.varName] = [];
          references[macro.varName].push(refInfo);
        }

        // Simulation: only enabled prompts mutate the simulated state.
        if (macro.kind === 'get') {
          // hasvar/hasglobalvar report existence rather than the stored value.
          newSnapshots[macro.id] =
            macro.op === 'has'
              ? String(currentVarState[macro.varName] !== undefined)
              : currentVarState[macro.varName];
        } else if (enabled) {
          const prev = currentVarState[macro.varName];
          switch (macro.op) {
            case 'set':
              currentVarState[macro.varName] = macro.value;
              break;
            case 'delete':
              delete currentVarState[macro.varName];
              break;
            case 'add':
              currentVarState[macro.varName] = addValues(prev, macro.value);
              break;
            case 'sub':
              currentVarState[macro.varName] = subValues(prev, macro.value);
              break;
            case 'inc':
              currentVarState[macro.varName] = stepValue(prev, 1);
              break;
            case 'dec':
              currentVarState[macro.varName] = stepValue(prev, -1);
              break;
            case 'setIfNull':
              if (prev === undefined) currentVarState[macro.varName] = macro.value;
              break;
            case 'setIfFalsy':
              if (!prev) currentVarState[macro.varName] = macro.value;
              break;
          }
          if (macro.kind === 'mutate') newSnapshots[macro.id] = currentVarState[macro.varName];
        } else if (macro.kind === 'mutate') {
          // A disabled mutate still reports the value it would have read.
          newSnapshots[macro.id] = currentVarState[macro.varName];
        }

        // Timeline event (F4): one entry per def/ref in execution order.
        // valueAfter = the simulated state after this event (for pure reads,
        // the value that was read). Disabled prompts don't mutate the state —
        // their events are recorded so the UI can show them as "skipped".
        if (!newTimelines[macro.varName]) newTimelines[macro.varName] = [];
        newTimelines[macro.varName].push({
          macroId: macro.id,
          promptId: prompt.id,
          promptName: prompt.name || prompt.id,
          op: macro.op,
          kind: macro.kind,
          scope: macro.scope,
          enabled,
          valueAfter:
            macro.kind === 'get' ? newSnapshots[macro.id] : currentVarState[macro.varName],
        });
      });

      const newVariables = {};
      const newUnresolved = new Set();
      allVarNames.forEach((varName) => {
        const defs = definitions[varName] || [];
        const refs = references[varName] || [];
        const uniqueDefs = Array.from(new Map(defs.map((item) => [item.promptId, item])).values());
        const uniqueRefs = Array.from(new Map(refs.map((item) => [item.promptId, item])).values());

        newVariables[varName] = {
          definedIn: uniqueDefs,
          referencedIn: uniqueRefs,
        };

        if (uniqueDefs.length === 0 && uniqueRefs.length > 0) {
          newUnresolved.add(varName);
        }
      });

      this.variables = newVariables;
      this.unresolvedVariables = Array.from(newUnresolved).map((varName) => ({ varName }));
      this.macroStateSnapshots = newSnapshots;
      this.variableTimelines = newTimelines;
      // End values after the full pass (F4). Deleted variables report undefined.
      const newEndValues = {};
      allVarNames.forEach((varName) => {
        newEndValues[varName] = currentVarState[varName];
      });
      this.variableEndValues = newEndValues;

      console.log('[analyzeAllMacros] Analysis complete.');
      console.log('[analyzeAllMacros] Variables:', this.variables);
    },

    findPromptIdByMacroId(macroId) {
      if (!macroId) return null;
      // Macro ID format is `${prompt.id}-${match.index}`
      const parts = macroId.split('-');
      // What if promptId itself contains a hyphen? Rejoin all but the last part.
      if (parts.length > 1) {
        return parts.slice(0, -1).join('-');
      }
      return null;
    },
    analyzeAllMacrosDebounced: debouncedAction(function () {
      this.analyzeAllMacros();
    }, 300),

    // --- Autosave (F1): the active area is always a view onto one library entry ---

    /**
     * Write the active editing area into its library entry. No-op in the VS
     * Code extension (the open file is mirrored to disk instead, and is not a
     * library entry) and when nothing actually changed (so loads/reloads don't
     * bump updatedAt). Adopts the active area into a new entry when it isn't
     * linked to one yet (fresh example, factory reset, legacy state).
     */
    _touchActivePreset() {
      if (isVsCodeHost()) return;
      if (!this.currentPresetId || !this.savedPresets[this.currentPresetId]) {
        this._adoptActivePreset();
        return;
      }
      const entry = this.savedPresets[this.currentPresetId];
      const next = activeAreaData(this);
      if (JSON.stringify(entry.data) === JSON.stringify(next)) return;
      entry.data = next;
      entry.updatedAt = new Date().toISOString();
    },
    /** Debounced autosave — call after every active-area mutation. */
    touchActivePresetDebounced: debouncedAction(function () {
      this._touchActivePreset();
    }, 1000),

    /** Link the active area to a (new) library entry so autosave has a home. */
    _adoptActivePreset() {
      if (isVsCodeHost()) return;
      // Nothing loaded yet (fresh app before the example arrives) — don't
      // create an empty library entry.
      if (!this.rawJson && Object.keys(this.prompts || {}).length === 0) return;
      const baseName = this.originalFilename
        ? this.originalFilename.replace(/\.[^/.]+$/, '')
        : this.t('presetManager.defaultName');
      const name = this._dedupedPresetName(baseName);
      const id = window.crypto.randomUUID();
      const now = new Date().toISOString();
      this.savedPresets[id] = {
        name,
        data: activeAreaData(this),
        createdAt: now,
        updatedAt: now,
      };
      this.currentPresetId = id;
    },

    /** Find a saved preset by exact name. @returns {string|null} its id */
    _findPresetIdByName(name) {
      for (const [id, preset] of Object.entries(this.savedPresets || {})) {
        if (preset?.name === name) return id;
      }
      return null;
    },
    /** Return baseName, or "baseName (2)" / "(3)" … if the name is taken. */
    _dedupedPresetName(baseName) {
      return this._findPresetIdByName(baseName)
        ? this._uniquePresetName(baseName, (n) => this._findPresetIdByName(n))
        : baseName;
    },

    // --- Actions that trigger re-analysis ---
    updatePromptOrder(newOrder) {
      this.promptOrder = newOrder.map((p) => p.id);
      this.analyzeAllMacros();
      this.touchActivePresetDebounced();
    },
    movePromptTop(promptId) {
      const index = this.promptOrder.indexOf(promptId);
      if (index > 0) {
        this.promptOrder.splice(index, 1);
        this.promptOrder.unshift(promptId);
        this.analyzeAllMacros();
        this.touchActivePresetDebounced();
      }
    },
    movePromptBottom(promptId) {
      const index = this.promptOrder.indexOf(promptId);
      if (index > -1 && index < this.promptOrder.length - 1) {
        this.promptOrder.splice(index, 1);
        this.promptOrder.push(promptId);
        this.analyzeAllMacros();
        this.touchActivePresetDebounced();
      }
    },
    movePromptAfter(draggedPromptId, targetPromptId) {
      const draggedIndex = this.promptOrder.indexOf(draggedPromptId);
      const targetIndex = this.promptOrder.indexOf(targetPromptId);

      if (draggedIndex === -1 || targetIndex === -1) {
        console.warn('[movePromptAfter] Invalid prompt IDs:', { draggedPromptId, targetPromptId });
        return;
      }

      // If the dragged item is before the target, adjust insert index
      const insertIndex = draggedIndex < targetIndex ? targetIndex : targetIndex + 1;

      // Remove dragged item
      this.promptOrder.splice(draggedIndex, 1);

      // Insert at target position
      this.promptOrder.splice(insertIndex, 0, draggedPromptId);

      this.analyzeAllMacros();
      this.touchActivePresetDebounced();
    },
    insertPromptAfter(draggedPromptId, targetPromptId) {
      // Validate existence
      const draggedExists = Boolean(this.prompts[draggedPromptId]);
      const targetExists = Boolean(this.prompts[targetPromptId]);
      if (!draggedExists || !targetExists) {
        console.warn('[insertPromptAfter] Invalid prompt IDs:', {
          draggedPromptId,
          targetPromptId,
        });
        return;
      }

      // If dragged item already in order, use move logic
      const draggedIndex = this.promptOrder.indexOf(draggedPromptId);
      const targetIndex = this.promptOrder.indexOf(targetPromptId);

      if (draggedIndex !== -1 && targetIndex !== -1) {
        this.movePromptAfter(draggedPromptId, targetPromptId);
        return;
      }

      // Only insert if target is present in order
      if (targetIndex === -1) {
        console.warn('[insertPromptAfter] Target not in order, append to end as fallback');
        this.promptOrder.push(draggedPromptId);
        this.analyzeAllMacros();
        this.touchActivePresetDebounced();
        return;
      }

      const insertIndex = targetIndex + 1;
      this.promptOrder.splice(insertIndex, 0, draggedPromptId);
      this.analyzeAllMacros();
      this.touchActivePresetDebounced();
    },
    duplicatePrompt(promptId) {
      const originalPrompt = this.prompts[promptId];
      if (!originalPrompt) return;

      const newId = window.crypto.randomUUID();
      const newPrompt = {
        ...originalPrompt,
        id: newId,
        identifier: newId,
        name: `${originalPrompt.name} (${this.t('promptCard.copied')})`,
        system_prompt: false, // Duplicated prompts are not system prompts
        marker: false, // Duplicated prompts are not markers
      };

      this.prompts[newId] = newPrompt;

      const originalIndex = this.promptOrder.indexOf(promptId);
      if (originalIndex > -1) {
        this.promptOrder.splice(originalIndex + 1, 0, newId);
      } else {
        this.promptOrder.push(newId);
      }

      this.analyzeAllMacros();
      this.touchActivePresetDebounced();
      this.selectPrompt(newId);
      this.navigateToPrompt(newId);
    },
    hidePrompt(promptId) {
      this.promptOrder = this.promptOrder.filter((id) => id !== promptId);
      this.analyzeAllMacros();
      this.touchActivePresetDebounced();
    },
    removePrompt(promptId) {
      delete this.prompts[promptId];
      this.hidePrompt(promptId); // This will trigger analysis
      // Cleanup collapse state for removed prompt
      this.cleanupPromptCollapseState(promptId);
    },
    togglePromptEnabled(promptId) {
      const prompt = this.prompts[promptId];
      if (prompt) {
        prompt.enabled = !(prompt.enabled !== false);
        this.analyzeAllMacros();
        this.touchActivePresetDebounced();
      }
    },
    updatePromptDetail({ promptId, field, value }) {
      const prompt = this.prompts[promptId];
      if (prompt && typeof field === 'string') {
        prompt[field] = value;
        if (field === 'content') {
          this.analyzeAllMacrosDebounced();
        }
        this.touchActivePresetDebounced();
      }
    },
    renameVariable({ oldName, newName }) {
      const trimmedNewName = newName.trim();
      if (
        !trimmedNewName ||
        trimmedNewName.includes(' ') ||
        (this.variables[trimmedNewName] && trimmedNewName !== oldName)
      ) {
        this.showToast(this.t('variableManager.invalidVariableName'), 'error');
        return false;
      }

      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\\]]/g, '\\$&');
      const oldNameEscaped = escapeRegExp(oldName);
      // Match any variable macro (get/set/add/inc/dec, local or global) whose
      // first argument is the old name; replace just the name, keep the rest.
      const varMacroNames = VAR_MACRO_NAMES.join('|');
      const renameRegex = new RegExp(
        `({{\\s*(?:${varMacroNames})\\s*::\\s*)${oldNameEscaped}(\\s*(?:::|}}))`,
        'g',
      );
      // Macros 2.0 shorthand: {{.name}} / {{$name = …}} / {{.name++}} etc.
      const shorthandRegex = new RegExp(
        `({{\\s*[.$]\\s*)${oldNameEscaped}(?=\\s*(?:\\?\\?=|\\|\\|=|\\+=|-=|\\+\\+|--|==|!=|>=|<=|=|>|<|}}))`,
        'g',
      );
      // References inside control-macro bodies (`{{if .flag}}`, `{{if $x > 3}}`,
      // `{{if getvar::flag}}`): the two regexes above anchor on `{{`, so they
      // cannot reach a name that appears after the `if` keyword. These are only
      // rewritten inside tokens classified as control, never in plain text.
      const controlShorthandRegex = new RegExp(`([.$]\\s*)${oldNameEscaped}(?![\\w-])`, 'g');
      const controlClassicRegex = new RegExp(
        `((?:${varMacroNames})\\s*::\\s*)${oldNameEscaped}(?![\\w-])`,
        'gi',
      );
      const renameInControlMacros = (content) => {
        const tokens = tokenizeMacros(content);
        let result = content;
        for (let k = tokens.length - 1; k >= 0; k -= 1) {
          const token = tokens[k];
          if (classifyMacro(token.inner).op !== 'control') continue;
          const rewritten = token.full
            .replace(controlShorthandRegex, `$1${trimmedNewName}`)
            .replace(controlClassicRegex, `$1${trimmedNewName}`);
          if (rewritten !== token.full) {
            result = result.slice(0, token.start) + rewritten + result.slice(token.end);
          }
        }
        return result;
      };

      for (const promptId in this.prompts) {
        const prompt = this.prompts[promptId];
        if (prompt.content) {
          prompt.content = renameInControlMacros(
            prompt.content
              .replace(renameRegex, `$1${trimmedNewName}$2`)
              .replace(shorthandRegex, `$1${trimmedNewName}`),
          );
        }
      }

      this.analyzeAllMacros();
      this.touchActivePresetDebounced();
      if (this.selectedMacro && this.selectedMacro.variableName === oldName) {
        this.selectMacro(trimmedNewName);
      }
      return true;
    },

    // --- Custom autocomplete dictionary (additive; persisted + synced) ---

    /**
     * Add a custom `{{name}}` macro to the autocomplete catalog.
     * @param {{ name: string, hint?: string }} entry
     * @returns {boolean} whether it was added
     */
    addCustomMacro({ name, hint = '' }) {
      const trimmed = (name || '').trim();
      if (!trimmed) return false;
      if (this.customMacros.some((m) => m.name === trimmed)) {
        this.showToast(this.t('settings.autocomplete.duplicateMacro'), 'error');
        return false;
      }
      this.customMacros.push({ name: trimmed, hint: (hint || '').trim() });
      return true;
    },
    removeCustomMacro(name) {
      this.customMacros = this.customMacros.filter((m) => m.name !== name);
    },

    /**
     * Add a wrapping/paired notation (e.g. `<!-- … -->`).
     * @param {{ label?: string, open: string, close?: string, hint?: string }} entry
     * @returns {boolean} whether it was added
     */
    addCustomWrap({ label = '', open, close = '', hint = '' }) {
      const o = open || '';
      if (!o.trim() && !label.trim()) return false;
      this.customWraps.push({
        label: (label || '').trim() || o.trim(),
        open: o,
        close: close || '',
        hint: (hint || '').trim(),
      });
      return true;
    },
    removeCustomWrap(index) {
      if (index >= 0 && index < this.customWraps.length) {
        this.customWraps.splice(index, 1);
      }
    },

    /** Restore the seed wrapping pairs and clear custom macros. */
    resetCustomDictionary() {
      this.customMacros = [];
      this.customWraps = defaultCustomWraps();
    },

    createNewPrompt() {
      const newId = window.crypto.randomUUID();
      const newPrompt = {
        id: newId,
        identifier: newId,
        name: this.t('promptCard.newUntitledPrompt'),
        content: `{{// ${this.t('promptCard.newPromptContent')}}}`,
        enabled: true, // Start enabled to be part of analysis
        role: 'system',
        system_prompt: false,
        marker: false,
      };
      this.prompts[newId] = newPrompt;

      const selectedIndex = this.promptOrder.indexOf(this.selectedPromptId);
      if (selectedIndex !== -1) {
        this.promptOrder.splice(selectedIndex + 1, 0, newId);
      } else {
        this.promptOrder.unshift(newId);
      }

      this.analyzeAllMacros();
      this.touchActivePresetDebounced();
      this.selectPrompt(newId);
      this.navigateToPrompt(newId);
    },
    deleteSelectedPrompts() {
      if (this.selectedLibraryPrompts.length === 0) return;
      // System prompts are never deletable — mirror the editor batch-delete guard.
      const deletable = this.selectedLibraryPrompts.filter(
        (promptId) => this.prompts[promptId] && !this.prompts[promptId].system_prompt,
      );
      if (deletable.length === 0) {
        this.showToast(this.t('editor.noDeletablePrompts'), 'error');
        return;
      }
      const skipped = this.selectedLibraryPrompts.length - deletable.length;
      this.requestConfirm({
        message: this.t('delete.confirm', { count: deletable.length }),
        confirmLabel: this.t('common.delete'),
        danger: true,
        onConfirm: () => this._performDeleteSelectedPrompts(deletable, skipped),
      });
    },
    _performDeleteSelectedPrompts(deletable, skipped = 0) {
      deletable.forEach((promptId) => {
        delete this.prompts[promptId];
        this.promptOrder = this.promptOrder.filter((id) => id !== promptId);
        this.cleanupPromptCollapseState(promptId);
      });
      this.selectedLibraryPrompts = [];
      this.isMultiSelectActive = false;
      if (skipped > 0) {
        this.showToast(this.t('delete.systemSkipped', { count: skipped }), 'info');
      }
      this.analyzeAllMacros();
      this.touchActivePresetDebounced();
    },
    addPromptToOrder(promptId) {
      if (!this.promptOrder.includes(promptId)) {
        const selectedIndex = this.promptOrder.indexOf(this.selectedPromptId);
        if (selectedIndex !== -1) {
          this.promptOrder.splice(selectedIndex + 1, 0, promptId);
        } else {
          this.promptOrder.unshift(promptId);
        }
        this.analyzeAllMacros();
        this.touchActivePresetDebounced();
        this.navigateToPrompt(promptId);
      }
    },

    // --- UI and Selection Actions (no re-analysis needed) ---
    selectPrompt(promptId) {
      this.selectedPromptId = promptId;
      this.selectedMacro = null;
      this.activeRightSidebarTab = 'details';
      if (this.isMobile) {
        this.toggleRightSidebar(true);
      }
    },
    /**
     * Select a variable (highlights every occurrence in the editor).
     * With `keepTab: true` the right sidebar stays where it is — used by the
     * Variables panel rows (F4b), which highlight without switching away.
     */
    selectMacro(variableName, { keepTab = false } = {}) {
      if (variableName) {
        this.selectedMacro = { variableName };
        this.selectedPromptId = null;
        if (!keepTab) {
          this.activeRightSidebarTab = 'details';
          if (this.isMobile) {
            this.toggleRightSidebar(true);
          }
        }
      }
    },
    toggleMultiSelect() {
      this.isMultiSelectActive = !this.isMultiSelectActive;
      this.selectedLibraryPrompts = [];
    },
    toggleLibrarySelection(promptId) {
      const index = this.selectedLibraryPrompts.indexOf(promptId);
      if (index > -1) {
        this.selectedLibraryPrompts.splice(index, 1);
      } else {
        this.selectedLibraryPrompts.push(promptId);
      }
    },

    // Editor multi-selection methods
    toggleEditorMultiSelect() {
      this.isEditorMultiSelectActive = !this.isEditorMultiSelectActive;
      // Leaving selection mode clears any pending selection so the editor
      // returns to a clean, distraction-free canvas.
      if (!this.isEditorMultiSelectActive) {
        this.selectedEditorPrompts = [];
      }
    },
    toggleEditorSelection(promptId) {
      const index = this.selectedEditorPrompts.indexOf(promptId);
      if (index > -1) {
        this.selectedEditorPrompts.splice(index, 1);
      } else {
        this.selectedEditorPrompts.push(promptId);
      }
    },
    batchMoveSelectedToTop() {
      if (this.selectedEditorPrompts.length === 0) return;

      const selectedIds = [...this.selectedEditorPrompts];
      const remainingIds = this.promptOrder.filter(
        (id) => !this.selectedEditorPrompts.includes(id),
      );

      // Move selected prompts to the top
      this.promptOrder = [...selectedIds, ...remainingIds];
      this.analyzeAllMacros();
      this.touchActivePresetDebounced();
    },
    batchMoveSelectedToBottom() {
      if (this.selectedEditorPrompts.length === 0) return;

      const selectedIds = [...this.selectedEditorPrompts];
      const remainingIds = this.promptOrder.filter(
        (id) => !this.selectedEditorPrompts.includes(id),
      );

      // Move selected prompts to the bottom
      this.promptOrder = [...remainingIds, ...selectedIds];
      this.analyzeAllMacros();
      this.touchActivePresetDebounced();
    },
    batchDeleteSelected() {
      if (this.selectedEditorPrompts.length === 0) return;

      // Filter out system prompts that cannot be deleted
      const deletablePrompts = Array.from(this.selectedEditorPrompts).filter((promptId) => {
        const prompt = this.prompts[promptId];
        return prompt && !prompt.system_prompt;
      });

      if (deletablePrompts.length === 0) {
        this.showToast(this.t('editor.noDeletablePrompts'), 'error');
        return;
      }

      this.requestConfirm({
        message: this.t('editor.batchDeleteConfirm', { count: deletablePrompts.length }),
        confirmLabel: this.t('common.delete'),
        danger: true,
        onConfirm: () => this._performBatchDelete(deletablePrompts),
      });
    },
    _performBatchDelete(deletablePrompts) {
      // Delete only deletable prompts
      deletablePrompts.forEach((promptId) => {
        delete this.prompts[promptId];
        this.cleanupPromptCollapseState(promptId);
      });

      // Remove from prompt order
      this.promptOrder = this.promptOrder.filter((id) => !deletablePrompts.includes(id));

      // Clear selection but keep multi-select active
      this.selectedEditorPrompts = [];

      this.analyzeAllMacros();
      this.touchActivePresetDebounced();
    },
    // Editor selection helpers
    selectAllEditorPrompts() {
      // System prompts have disabled checkboxes; don't sneak them into the count.
      this.selectedEditorPrompts = this.promptOrder.filter(
        (id) => !this.prompts[id]?.system_prompt,
      );
    },
    deselectAllEditorPrompts() {
      this.selectedEditorPrompts = [];
    },
    setLibrarySearch(term) {
      this.librarySearchTerm = term;
      this.selectedLibraryPrompts = [];
    },
    setEditorSearch(term) {
      if (term === this.editorSearchTerm) return; // keep find-next position on no-op
      this.editorSearchTerm = term;
      this.editorSearchActiveIndex = -1;
      this.searchVisitPromptId = null;
    },
    /**
     * Find-next navigation (F6b): advance the active hit by `step` (±1),
     * temporarily expand its prompt (via searchVisitPromptId — presentational
     * only, collapse states are untouched) and scroll to it.
     */
    editorSearchNext(step = 1) {
      const hits = this.editorSearchMatches;
      if (!hits.length) return;
      const len = hits.length;
      if (this.editorSearchActiveIndex === -1) {
        this.editorSearchActiveIndex = step > 0 ? 0 : len - 1;
      } else {
        this.editorSearchActiveIndex = (this.editorSearchActiveIndex + step + len) % len;
      }
      const promptId = hits[this.editorSearchActiveIndex];
      this.searchVisitPromptId = promptId;
      this.navigateToPrompt(promptId);
    },
    editorSearchPrev() {
      this.editorSearchNext(-1);
    },

    // Global search palette (F6c) --------------------------------------------
    openGlobalSearch() {
      this.isGlobalSearchOpen = true;
    },
    closeGlobalSearch() {
      this.isGlobalSearchOpen = false;
    },
    /**
     * Substring search across the active preset and every saved preset
     * (names + prompt names + contents). Returns display-ready groups; does
     * not touch state. In VS Code host mode only the open file is searched —
     * the library is not loadable in place there (it would overwrite the open
     * file on disk).
     * @returns {Array<{presetId: string|null, presetName: string, isActive: boolean,
     *   nameMatch: boolean, hits: Array<{promptId: string, promptName: string,
     *   snippet: {before: string, match: string, after: string}}>}>}
     */
    searchAllPresets(term) {
      const q = String(term || '')
        .trim()
        .toLowerCase();
      if (!q) return [];
      const MAX_HITS_PER_PRESET = 20;

      const makeSnippet = (text, matchIndex) => {
        const start = Math.max(0, matchIndex - 32);
        const end = Math.min(text.length, matchIndex + q.length + 48);
        return {
          before: (start > 0 ? '…' : '') + text.slice(start, matchIndex),
          match: text.slice(matchIndex, matchIndex + q.length),
          after: text.slice(matchIndex + q.length, end) + (end < text.length ? '…' : ''),
        };
      };

      const collectHits = (prompts, order) => {
        const seen = new Set();
        const ids = [...(order || []), ...Object.keys(prompts || {})].filter((id) => {
          if (seen.has(id) || !prompts[id]) return false;
          seen.add(id);
          return true;
        });
        const hits = [];
        for (const id of ids) {
          if (hits.length >= MAX_HITS_PER_PRESET) break;
          const p = prompts[id];
          const name = p.name || '';
          const content = p.content || '';
          const nameIdx = name.toLowerCase().indexOf(q);
          const contentIdx = content.toLowerCase().indexOf(q);
          if (nameIdx === -1 && contentIdx === -1) continue;
          hits.push({
            promptId: id,
            promptName: name,
            snippet:
              contentIdx !== -1 ? makeSnippet(content, contentIdx) : makeSnippet(name, nameIdx),
          });
        }
        return hits;
      };

      const groups = [];
      const activeName =
        this.currentPresetName || this.originalFilename || this.t('globalSearch.activePreset');
      const activeHits = collectHits(this.prompts, this.promptOrder);
      const activeNameMatch = (activeName || '').toLowerCase().includes(q);
      if (activeHits.length || activeNameMatch) {
        groups.push({
          presetId: this.currentPresetId,
          presetName: activeName,
          isActive: true,
          nameMatch: activeNameMatch,
          hits: activeHits,
        });
      }
      if (!isVsCodeHost()) {
        for (const [id, entry] of Object.entries(this.savedPresets || {})) {
          if (id === this.currentPresetId) continue; // mirrored by the active area
          const data = entry?.data || {};
          const hits = collectHits(data.prompts || {}, data.promptOrder || []);
          const nameMatch = (entry?.name || '').toLowerCase().includes(q);
          if (hits.length || nameMatch) {
            groups.push({
              presetId: id,
              presetName: entry.name,
              isActive: false,
              nameMatch,
              hits,
            });
          }
        }
      }
      return groups;
    },
    /**
     * Open a global-search result: load the preset if it isn't the active one
     * (safe — autosave means there is nothing to lose), then jump to the
     * prompt once the editor has re-rendered.
     */
    openGlobalSearchResult(presetId, promptId) {
      this.isGlobalSearchOpen = false;
      if (presetId && presetId !== this.currentPresetId) {
        if (isVsCodeHost() || !this.savedPresets[presetId]) return;
        this.loadPreset(presetId);
      }
      if (!promptId || !this.prompts[promptId]) return;
      this.selectPrompt(promptId);
      setTimeout(() => this.navigateToPrompt(promptId), 150); // after re-render
    },
    navigateToPrompt(promptId) {
      // First, ensure the prompt is in the editor order
      if (!this.isPromptInOrder(promptId)) {
        console.log('[navigateToPrompt] Prompt not in editor, adding it first:', promptId);
        this.addPromptToOrder(promptId);
      }

      // Then set the scroll request
      this.scrollToPromptId = promptId;
    },
    clearScrollToRequest() {
      this.scrollToPromptId = null;
    },
    navigateLibraryToPrompt(promptId) {
      // Trigger left library scroll request
      this.scrollToLibraryPromptId = promptId;
    },
    clearLibraryScrollToRequest() {
      this.scrollToLibraryPromptId = null;
    },
    setActiveRightSidebarTab(tabName) {
      this.activeRightSidebarTab = tabName;
    },
    toggleMacroDisplayMode() {
      this.macroDisplayMode = this.macroDisplayMode === 'raw' ? 'preview' : 'raw';
    },

    // Mobile Sidebar Toggles
    toggleLeftSidebar(isOpen) {
      this.isLeftSidebarOpen = typeof isOpen === 'boolean' ? isOpen : !this.isLeftSidebarOpen;
    },
    toggleRightSidebar(isOpen) {
      this.isRightSidebarOpen = typeof isOpen === 'boolean' ? isOpen : !this.isRightSidebarOpen;
    },

    // Desktop 3-pane layout (F7) -------------------------------------------
    setPaneSizes(sizes) {
      if (!Array.isArray(sizes) || sizes.length !== 3) return;
      const nums = sizes.map(Number);
      if (nums.some((n) => !Number.isFinite(n))) return;
      this.paneSizes = nums;
    },
    /** Expand the right pane to 60% (left collapses); toggling back restores
     *  the previous drag-set sizes. */
    toggleRightPaneMaximize() {
      if (this.isRightPaneMaximized) {
        this.isRightPaneMaximized = false;
        this.paneSizes = this._paneSizesBackup || [20, 50, 30];
        this._paneSizesBackup = null;
      } else {
        this._paneSizesBackup = [...this.paneSizes];
        this.isRightPaneMaximized = true;
        this.paneSizes = [5, 35, 60];
      }
    },

    // Modal toggles
    openImportModal() {
      this.isImportModalOpen = true;
    },
    closeImportModal() {
      this.isImportModalOpen = false;
    },
    openExportModal() {
      this.isExportModalOpen = true;
    },
    closeExportModal() {
      this.isExportModalOpen = false;
    },
    openSettingsModal() {
      this.isSettingsModalOpen = true;
    },
    closeSettingsModal() {
      this.isSettingsModalOpen = false;
    },

    // Batch replace modal toggles
    openBatchReplaceModal() {
      this.isBatchReplaceModalOpen = true;
    },
    closeBatchReplaceModal() {
      this.isBatchReplaceModalOpen = false;
    },

    // Distraction-free focus editor (a large, content-only writing surface)
    openFocusEditor(promptId) {
      if (!this.prompts[promptId]) return;
      this.focusEditorPromptId = promptId;
      this.selectPrompt(promptId);
    },
    closeFocusEditor() {
      this.focusEditorPromptId = null;
    },

    // In-app confirmation dialog (replaces native window.confirm) ----------
    requestConfirm({
      title,
      message,
      confirmLabel,
      cancelLabel,
      danger = false,
      showSkip = false,
      skipLabel = '',
      onConfirm = null,
      onCancel = null,
      onDismiss = null,
    }) {
      this.confirmState = {
        open: true,
        title: title || this.t('common.confirmTitle'),
        message: message || '',
        confirmLabel: confirmLabel || this.t('common.confirm'),
        cancelLabel: cancelLabel || this.t('common.cancel'),
        danger,
        showSkip,
        skipLabel,
        skipChecked: false,
      };
      confirmCallback = typeof onConfirm === 'function' ? onConfirm : null;
      confirmCancelCallback = typeof onCancel === 'function' ? onCancel : null;
      confirmDismissCallback = typeof onDismiss === 'function' ? onDismiss : null;
    },
    setConfirmSkip(value) {
      this.confirmState.skipChecked = !!value;
    },
    cancelConfirm() {
      const cb = confirmCancelCallback;
      this.confirmState.open = false;
      confirmCallback = null;
      confirmCancelCallback = null;
      confirmDismissCallback = null;
      if (cb) cb();
    },
    /** Esc/backdrop close. Distinct from the explicit cancel button when the
     *  caller provided onDismiss (e.g. the sync-conflict dialog, where cancel
     *  adopts the cloud copy but a dismissal must not discard anything). */
    dismissConfirm() {
      if (!confirmDismissCallback) {
        this.cancelConfirm();
        return;
      }
      const cb = confirmDismissCallback;
      this.confirmState.open = false;
      confirmCallback = null;
      confirmCancelCallback = null;
      confirmDismissCallback = null;
      cb();
    },
    resolveConfirm() {
      const cb = confirmCallback;
      const skip = this.confirmState.skipChecked;
      this.confirmState.open = false;
      confirmCallback = null;
      confirmCancelCallback = null;
      confirmDismissCallback = null;
      if (cb) cb({ skip });
    },

    // Transient toast notifications (replaces native alert) ----------------
    showToast(message, type = 'info', timeout = 3000) {
      const id = ++this._toastSeq;
      this.toasts.push({ id, message, type });
      if (timeout > 0) {
        setTimeout(() => this.dismissToast(id), timeout);
      }
      return id;
    },
    dismissToast(id) {
      this.toasts = this.toasts.filter((toast) => toast.id !== id);
    },

    // Responsive state management
    setIsMobile(isMobile) {
      this.isMobile = isMobile;
    },

    // Global collapse state management
    collapseAllPrompts() {
      this.globalCollapseState = 'collapsed';
      // Clear per-prompt states so all follow the global state
      this.promptCollapseStates = {};
      this.touchActivePresetDebounced();
    },

    expandAllPrompts() {
      this.globalCollapseState = 'expanded';
      // Clear per-prompt states so all follow the global state
      this.promptCollapseStates = {};
      this.touchActivePresetDebounced();
    },

    setGlobalCollapseState(state) {
      this.globalCollapseState = state;
      // Clear per-prompt states when switching away from 'mixed'
      if (state !== 'mixed') {
        this.promptCollapseStates = {};
      }
    },

    // Individual prompt collapse state management
    togglePromptCollapse(promptId) {
      // If global state is not 'mixed', initialize mixed state first
      if (this.globalCollapseState !== 'mixed') {
        this.initializeMixedState();
      }
      // Ensure this prompt has an individual state
      this.ensurePromptCollapseState(promptId);
      // Toggle collapse state for the prompt
      this.promptCollapseStates[promptId] = !this.promptCollapseStates[promptId];
      this.touchActivePresetDebounced();
    },

    // Initialize 'mixed' state: seed per-prompt states from current global setting
    initializeMixedState() {
      const currentGlobalState = this.globalCollapseState;
      this.globalCollapseState = 'mixed';

      // Assign an individual collapse state to all prompts
      this.promptOrder.forEach((id) => {
        this.promptCollapseStates[id] = currentGlobalState === 'collapsed';
      });
    },

    // Ensure given prompt has an individual state; derive from global if missing
    ensurePromptCollapseState(promptId) {
      if (this.promptCollapseStates[promptId] === undefined) {
        // If global is 'mixed', default to expanded (false); otherwise mirror global
        this.promptCollapseStates[promptId] = this.globalCollapseState === 'collapsed';
      }
    },

    // Remove stale collapse state (when a prompt is deleted)
    cleanupPromptCollapseState(promptId) {
      if (this.promptCollapseStates[promptId] !== undefined) {
        delete this.promptCollapseStates[promptId];
      }
    },

    getPromptCollapseState(promptId) {
      // Search navigation temporarily expands the visited prompt (F6b) —
      // presentational only, the stored collapse state is untouched.
      if (this.searchVisitPromptId === promptId) {
        return false;
      }

      // If not 'mixed', return the global state directly
      if (this.globalCollapseState === 'collapsed') {
        return true;
      } else if (this.globalCollapseState === 'expanded') {
        return false;
      }

      // In 'mixed', ensure per-prompt state exists and return it
      this.ensurePromptCollapseState(promptId);
      return this.promptCollapseStates[promptId];
    },

    // Generate export filename
    generateExportFilename() {
      if (!this.originalFilename) {
        return 'preset.json';
      }

      // Strip original file extension
      const nameWithoutExt = this.originalFilename.replace(/\.json$/i, '');

      // Build date suffix (YYYYMMDD)
      const now = new Date();
      const dateStr =
        now.getFullYear().toString() +
        (now.getMonth() + 1).toString().padStart(2, '0') +
        now.getDate().toString().padStart(2, '0');

      return `${nameWithoutExt}-${dateStr}.json`;
    },

    // Language actions
    setLanguage(language) {
      if (['en', 'zh'].includes(language)) {
        this.currentLanguage = language;
      }
    },
    toggleLanguage() {
      this.currentLanguage = this.currentLanguage === 'en' ? 'zh' : 'en';
    },

    // Delete confirmation preferences
    setSkipDeleteConfirmation(skip) {
      this.skipDeleteConfirmation = skip;
    },

    // Theme (F8b) -----------------------------------------------------------
    setThemeMode(mode) {
      if (!['light', 'dark', 'system'].includes(mode)) return;
      this.themeMode = mode;
      this.applyTheme();
    },
    /**
     * Toggle the `.dark` root class from the current theme source. Web: the
     * light/dark/system setting (system = prefers-color-scheme). VS Code
     * webview: the setting is ignored — the editor's theme wins (VS Code
     * maintains a `vscode-dark`/`vscode-high-contrast` class on <body>).
     */
    applyTheme() {
      if (typeof document === 'undefined') return;
      let dark;
      if (isVsCodeHost()) {
        const cls = document.body?.classList;
        dark = Boolean(
          cls && (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')),
        );
        // 'vscode-high-contrast-light' also carries 'vscode-high-contrast' in
        // older hosts; prefer the explicit light marker when present.
        if (cls && cls.contains('vscode-high-contrast-light')) dark = false;
      } else if (this.themeMode === 'system') {
        dark = Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
      } else {
        dark = this.themeMode === 'dark';
      }
      document.documentElement.classList.toggle('dark', dark);
    },
    /** Attach the listeners that keep the theme live (call once at startup). */
    initTheme() {
      this.applyTheme();
      if (typeof window === 'undefined') return;
      if (isVsCodeHost()) {
        // React to VS Code theme switches by watching the body class VS Code
        // maintains — no bridge protocol needed.
        new MutationObserver(() => this.applyTheme()).observe(document.body, {
          attributes: true,
          attributeFilter: ['class', 'data-vscode-theme-kind'],
        });
      } else {
        window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => {
          if (this.themeMode === 'system') this.applyTheme();
        });
      }
    },

    // Preset management
    openPresetManager() {
      this.isPresetManagerOpen = true;
    },
    closePresetManager() {
      this.isPresetManagerOpen = false;
    },
    /**
     * Save imported JSON as a new preset without loading/overwriting current editor state
     * @param {string} jsonString - The imported preset JSON string
     * @param {string} filename - The original file name of the imported preset
     * @returns {string|null} The newly created preset ID, or null on failure
     */
    saveImportedJsonAsPreset(jsonString, filename = '') {
      try {
        const parsed = JSON.parse(jsonString);
        const promptsArray = Array.isArray(parsed.prompts) ? parsed.prompts : [];

        // Build prompts object
        const prompts = promptsArray.reduce((acc, prompt) => {
          const id = prompt.identifier || prompt.name;
          if (id) acc[id] = { ...prompt, id };
          return acc;
        }, {});

        // Build promptOrder array
        let promptOrder = [];
        if (Array.isArray(parsed.prompt_order)) {
          let characterOrder = parsed.prompt_order.find((item) => item.character_id === 100001);
          if (!characterOrder && parsed.prompt_order.length > 0) {
            characterOrder = parsed.prompt_order[0];
          }

          if (characterOrder && Array.isArray(characterOrder.order)) {
            promptOrder = characterOrder.order
              .map((item) => item.identifier)
              .filter((id) => id in prompts);
          }
        }

        // Compose preset payload (do not touch current editor state)
        const presetData = {
          rawJson: jsonString,
          originalFilename: filename || '',
          prompts,
          promptOrder,
          promptCollapseStates: {},
        };

        const presetId = window.crypto.randomUUID();
        const now = new Date().toISOString();

        // Derive preset name from filename, fallback to localized default
        const presetName = filename
          ? filename.replace(/\.[^/.]+$/, '')
          : this.t('presetManager.defaultName');

        this.savedPresets[presetId] = {
          name: presetName,
          data: presetData,
          createdAt: now,
          updatedAt: now,
        };

        return presetId;
      } catch (error) {
        console.error('[saveImportedJsonAsPreset] Failed to parse imported JSON:', error);
        return null;
      }
    },
    /**
     * Import preset with duplicate name checking and overwrite confirmation, then auto-save.
     * Does NOT load into current editor; only saves into savedPresets.
     * @param {string} jsonString
     * @param {string} filename
     * @returns {{ result: 'saved'|'overwritten'|'failed', name?: string }}
     */
    importPresetWithDuplicateCheck(jsonString, filename = '') {
      let parsed;
      try {
        parsed = JSON.parse(jsonString);
      } catch (e) {
        console.error('[importPresetWithDuplicateCheck] Invalid JSON:', e);
        return { result: 'failed' };
      }

      const promptsArray = Array.isArray(parsed.prompts) ? parsed.prompts : [];
      const prompts = promptsArray.reduce((acc, prompt) => {
        const id = prompt.identifier || prompt.name;
        if (id) acc[id] = { ...prompt, id };
        return acc;
      }, {});

      let promptOrder = [];
      if (Array.isArray(parsed.prompt_order)) {
        let characterOrder = parsed.prompt_order.find((item) => item.character_id === 100001);
        if (!characterOrder && parsed.prompt_order.length > 0) {
          characterOrder = parsed.prompt_order[0];
        }
        if (characterOrder && Array.isArray(characterOrder.order)) {
          promptOrder = characterOrder.order
            .map((item) => item.identifier)
            .filter((id) => id in prompts);
        }
      }

      const presetData = {
        rawJson: jsonString,
        originalFilename: filename || '',
        prompts,
        promptOrder,
        promptCollapseStates: {},
      };

      const baseName = filename
        ? filename.replace(/\.[^/.]+$/, '')
        : this.t('presetManager.defaultName');

      const findPresetIdByName = (name) => {
        const entries = Object.entries(this.savedPresets || {});
        for (const [id, preset] of entries) {
          if (preset?.name === name) return id;
        }
        return null;
      };

      const now = new Date().toISOString();
      const existingId = findPresetIdByName(baseName);

      if (existingId) {
        // Defer to the in-app confirm dialog; the result is reported via toast.
        this.requestConfirm({
          message: this.t('importModal.overwriteConfirm', { name: baseName }),
          onConfirm: () => {
            this.savedPresets[existingId].data = presetData;
            this.savedPresets[existingId].updatedAt = now;
            this.showToast(this.t('importModal.overwriteDone', { name: baseName }), 'success');
            this.closeImportModal();
          },
          onCancel: () => {
            // Cancelling overwrite keeps both copies under a unique name.
            const uniqueName = this._uniquePresetName(baseName, findPresetIdByName);
            this.savedPresets[window.crypto.randomUUID()] = {
              name: uniqueName,
              data: presetData,
              createdAt: now,
              updatedAt: now,
            };
            this.showToast(this.t('importModal.savedDone', { name: uniqueName }), 'success');
            this.closeImportModal();
          },
        });
        return { result: 'deferred' };
      }

      // No duplicate, save directly under baseName
      this.savedPresets[window.crypto.randomUUID()] = {
        name: baseName,
        data: presetData,
        createdAt: now,
        updatedAt: now,
      };
      return { result: 'saved', name: baseName };
    },
    // Generate a unique preset name like "Name (2)", "Name (3)"...
    _uniquePresetName(baseName, findPresetIdByName) {
      let index = 2;
      let uniqueName = `${baseName} (${index})`;
      while (findPresetIdByName(uniqueName)) {
        index += 1;
        uniqueName = `${baseName} (${index})`;
      }
      return uniqueName;
    },
    /**
     * Duplicate the active area into a NEW library entry and switch to it.
     * Routine saving is handled by autosave (_touchActivePreset) — this is the
     * deliberate "keep a separate copy" action.
     * @param {string|null} name - optional name; defaults to the current name deduped
     * @returns {string} the new preset id
     */
    saveActivePresetAsCopy(name = null) {
      // Flush pending edits into the current entry before branching off a copy.
      this._touchActivePreset();

      const baseName =
        (name || '').trim() ||
        (this.originalFilename
          ? this.originalFilename.replace(/\.[^/.]+$/, '')
          : this.currentPresetName || this.t('presetManager.defaultName'));
      const presetName = this._dedupedPresetName(baseName);

      const presetId = window.crypto.randomUUID();
      const now = new Date().toISOString();
      this.savedPresets[presetId] = {
        name: presetName,
        data: activeAreaData(this),
        createdAt: now,
        updatedAt: now,
      };
      this.currentPresetId = presetId;
      return presetId;
    },
    loadPreset(presetId) {
      const preset = this.savedPresets[presetId];
      if (!preset) {
        console.log('[loadPreset] Preset not found:', presetId);
        return false;
      }

      // Flush any pending autosave for the outgoing preset first — switching
      // must never lose the last second of edits.
      this._touchActivePreset();

      // Deep-clone so the active area never aliases the library entry (writes
      // back go through autosave explicitly).
      const data = toPlainClone(preset.data || {});
      this.rawJson = data.rawJson || '';
      this.originalFilename = data.originalFilename || '';
      this.prompts = data.prompts || {};
      this.promptOrder = data.promptOrder || [];
      // Note: data.macroDisplayMode from legacy entries is intentionally
      // ignored — display mode is a preference, not preset data.
      this.promptCollapseStates = data.promptCollapseStates || {};

      this.currentPresetId = presetId;
      this.analyzeAllMacros();
      return true;
    },

    // --- Snapshots (named per-preset versions, cap MAX_SNAPSHOTS_PER_PRESET) ---

    /**
     * Store a named snapshot of a preset's current data.
     * @param {string|null} presetId - defaults to the active preset
     * @param {string} name - label; defaults to a timestamped name
     * @returns {string|null} the snapshot id
     */
    createSnapshot(presetId = null, name = '') {
      let targetId = presetId;
      if (!targetId) {
        if (isVsCodeHost()) return null; // no active library preset in host mode
        this._touchActivePreset(); // flush + adopt so the snapshot is current
        targetId = this.currentPresetId;
      } else if (targetId === this.currentPresetId) {
        this._touchActivePreset();
      }
      const entry = this.savedPresets[targetId];
      if (!entry) return null;

      if (!Array.isArray(entry.snapshots)) entry.snapshots = [];
      const now = new Date();
      const label =
        (name || '').trim() ||
        this.t('presetManager.snapshots.defaultName', {
          time: now.toISOString().slice(0, 16).replace('T', ' '),
        });
      const snapshot = {
        id: window.crypto.randomUUID(),
        name: label,
        createdAt: now.toISOString(),
        // Snapshot the durable preset content only (no UI state).
        data: (({ rawJson, originalFilename, prompts, promptOrder }) => ({
          rawJson,
          originalFilename,
          prompts,
          promptOrder,
        }))(toPlainClone(entry.data || {})),
      };
      entry.snapshots.unshift(snapshot);
      if (entry.snapshots.length > MAX_SNAPSHOTS_PER_PRESET) {
        entry.snapshots.length = MAX_SNAPSHOTS_PER_PRESET;
        this.showToast(this.t('presetManager.snapshots.limitPruned'), 'info');
      }
      return snapshot.id;
    },
    /**
     * Roll a preset back to a snapshot. The pre-restore state is snapshotted
     * automatically first, so a restore is itself reversible.
     */
    restoreSnapshot(presetId, snapshotId) {
      const entry = this.savedPresets[presetId];
      const snapshot = entry?.snapshots?.find((s) => s.id === snapshotId);
      if (!entry || !snapshot) return false;

      this.createSnapshot(
        presetId,
        this.t('presetManager.snapshots.beforeRestore', { name: snapshot.name }),
      );

      entry.data = { ...toPlainClone(entry.data || {}), ...toPlainClone(snapshot.data) };
      entry.updatedAt = new Date().toISOString();

      if (presetId === this.currentPresetId) {
        const data = toPlainClone(entry.data);
        this.rawJson = data.rawJson || '';
        this.originalFilename = data.originalFilename || '';
        this.prompts = data.prompts || {};
        this.promptOrder = data.promptOrder || [];
        this.promptCollapseStates = data.promptCollapseStates || {};
        this.analyzeAllMacros();
      }
      return true;
    },
    renameSnapshot(presetId, snapshotId, name) {
      const snapshot = this.savedPresets[presetId]?.snapshots?.find((s) => s.id === snapshotId);
      const trimmed = (name || '').trim();
      if (!snapshot || !trimmed) return false;
      snapshot.name = trimmed;
      return true;
    },
    deleteSnapshot(presetId, snapshotId) {
      const entry = this.savedPresets[presetId];
      if (!entry?.snapshots) return false;
      const index = entry.snapshots.findIndex((s) => s.id === snapshotId);
      if (index === -1) return false;
      entry.snapshots.splice(index, 1);
      return true;
    },

    /**
     * Compose the exportable preset JSON for a saved library entry (used by
     * the Preset Manager's export and the VS Code "open as new file" flow).
     * @returns {string|null}
     */
    buildPresetJsonById(presetId) {
      const entry = this.savedPresets[presetId];
      if (!entry?.data) return null;
      return composePresetJson(entry.data);
    },
    updatePreset(presetId, name) {
      const preset = this.savedPresets[presetId];
      if (!preset) return false;

      preset.name = name.trim();
      preset.updatedAt = new Date().toISOString();
      return true;
    },
    deletePreset(presetId) {
      if (this.savedPresets[presetId]) {
        delete this.savedPresets[presetId];
        if (this.currentPresetId === presetId) {
          this.currentPresetId = null;
        }
        return true;
      }
      return false;
    },
    duplicatePreset(presetId, newName) {
      const preset = this.savedPresets[presetId];
      if (!preset) return false;

      const newPresetId = window.crypto.randomUUID();
      const now = new Date().toISOString();

      this.savedPresets[newPresetId] = {
        name: newName.trim(),
        data: JSON.parse(JSON.stringify(preset.data)), // Deep clone
        createdAt: now,
        updatedAt: now,
      };

      return newPresetId;
    },
    async saveFactorySettingsAsDefault() {
      console.log('[saveFactorySettingsAsDefault] Saving factory settings as default preset...');

      try {
        // Load factory settings data
        const factoryData = await import('../assets/example.json');

        const presetId = window.crypto.randomUUID();
        const now = new Date().toISOString();

        // Parse factory settings JSON
        const jsonString = JSON.stringify(factoryData.default || factoryData);
        const parsed = JSON.parse(jsonString);
        const promptsArray = Array.isArray(parsed.prompts) ? parsed.prompts : [];

        // Build prompts object
        const prompts = promptsArray.reduce((acc, prompt) => {
          const id = prompt.identifier || prompt.name;
          if (id) acc[id] = { ...prompt, id };
          return acc;
        }, {});

        // Build promptOrder array
        let promptOrder = [];
        if (Array.isArray(parsed.prompt_order)) {
          let characterOrder = parsed.prompt_order.find((item) => item.character_id === 100001);
          if (!characterOrder && parsed.prompt_order.length > 0) {
            characterOrder = parsed.prompt_order[0];
          }

          if (characterOrder && Array.isArray(characterOrder.order)) {
            promptOrder = characterOrder.order
              .map((item) => item.identifier)
              .filter((id) => id in prompts);
          }
        }

        // Compose default preset payload
        const presetData = {
          rawJson: jsonString,
          originalFilename: 'factory-default.json',
          prompts: prompts,
          promptOrder: promptOrder,
          promptCollapseStates: {},
        };

        // Save as default preset
        this.savedPresets[presetId] = {
          name: this.t('presetManager.factorySettings.factoryDefaultName'),
          data: presetData,
          createdAt: now,
          updatedAt: now,
        };

        this.defaultPresetId = presetId;
        console.log(
          '[saveFactorySettingsAsDefault] Factory settings saved as default preset. ID:',
          presetId,
        );
      } catch (error) {
        console.error('[saveFactorySettingsAsDefault] Failed to load factory settings:', error);
      }
    },
    loadDefaultPreset() {
      if (!this.defaultPresetId || !this.savedPresets[this.defaultPresetId]) {
        console.log('[loadDefaultPreset] No default preset found');
        return false;
      }

      console.log('[loadDefaultPreset] Loading default preset...');
      return this.loadPreset(this.defaultPresetId);
    },

    // Preset manager UI actions
    setPresetSearchTerm(term) {
      this.presetSearchTerm = term;
      this.selectedPresets.clear();
    },
    setPresetSortBy(sortBy) {
      this.presetSortBy = sortBy;
    },
    togglePresetMultiSelect() {
      this.presetMultiSelectActive = !this.presetMultiSelectActive;
      // Replace Set to ensure reactivity in UI templates
      this.selectedPresets = new Set();
    },
    togglePresetSelection(presetId) {
      // Work on a cloned Set to keep reactivity
      const next = new Set(this.selectedPresets);
      if (next.has(presetId)) {
        next.delete(presetId);
      } else {
        next.add(presetId);
      }
      this.selectedPresets = next;
    },
    selectAllPresets() {
      const next = new Set();
      this.savedPresetsList.forEach((preset) => {
        next.add(preset.id);
      });
      this.selectedPresets = next;
    },
    deselectAllPresets() {
      this.selectedPresets = new Set();
    },
    deleteSelectedPresets() {
      if (this.selectedPresets.size === 0) return;
      this.requestConfirm({
        message: this.t('presetManager.deleteSelectedConfirm', {
          count: this.selectedPresets.size,
        }),
        confirmLabel: this.t('common.delete'),
        danger: true,
        onConfirm: () => this._performDeleteSelectedPresets(),
      });
    },
    _performDeleteSelectedPresets() {
      this.selectedPresets.forEach((presetId) => {
        delete this.savedPresets[presetId];
        if (this.currentPresetId === presetId) {
          this.currentPresetId = null;
        }
        if (this.defaultPresetId === presetId) {
          this.defaultPresetId = null;
        }
      });
      this.selectedPresets = new Set();
      this.presetMultiSelectActive = false;
    },
    /**
     * Batch replace prompt titles and/or contents.
     * @param {Object} payload
     * @param {string} payload.find
     * @param {string} payload.replace
     * @param {{ title: boolean, content: boolean }} payload.targetFields
     * @param {'selected'|'all'} payload.scope
     * @param {boolean} payload.useRegex
     * @param {boolean} payload.caseSensitive
     * @param {boolean} payload.wholeWord
     * @returns {{ matches: number, prompts: number }} summary
     */
    batchReplaceText(payload) {
      const {
        find,
        replace,
        targetFields,
        scope,
        useRegex,
        caseSensitive,
        wholeWord,
        addPrefix,
        prefixText,
        addSuffix,
        suffixText,
        addSerial,
        serialPosition,
        serialStart,
        serialDigits,
      } = payload || {};

      const findText = typeof find === 'string' ? find : '';
      const replaceText = typeof replace === 'string' ? replace : '';
      const hasFind = Boolean(findText);
      const hasAdditions = Boolean(addPrefix) || Boolean(addSuffix) || Boolean(addSerial);
      if (!hasFind && !hasAdditions) {
        return { matches: 0, prompts: 0 };
      }

      // Build RegExp when needed
      let pattern = null;
      if (hasFind) {
        if (useRegex) {
          try {
            pattern = new RegExp(findText, `g${caseSensitive ? '' : 'i'}`);
          } catch {
            throw new Error('INVALID_REGEX');
          }
        } else {
          const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          let escaped = escapeRegExp(findText);
          if (wholeWord) {
            escaped = `\\b${escaped}\\b`;
          }
          pattern = new RegExp(escaped, `g${caseSensitive ? '' : 'i'}`);
        }
      }

      // Decide target prompts
      let targetIds = [];
      if (scope === 'selected') {
        if (this.selectedEditorPrompts.length === 0) {
          // When explicitly targeting selected but none selected, do nothing
          return { matches: 0, prompts: 0 };
        }
        targetIds = [...this.selectedEditorPrompts];
      } else {
        targetIds = [...this.promptOrder];
      }

      // Ensure stable ordering for serial numbers: follow editor order
      const orderedTargetIds = this.promptOrder.filter((id) => targetIds.includes(id));

      let totalChanges = 0;
      let contentChanged = false;
      /** @type {{ timestamp: string, changes: Array<{ promptId: string, before: { name: string|null, content: string|null }, after: { name: string|null, content: string|null } }> }} */
      const historyEntry = { timestamp: new Date().toISOString(), changes: [] };

      const replaceInText = (text) => {
        if (!hasFind || typeof text !== 'string' || text.length === 0) {
          return { newText: text, count: 0 };
        }
        let count = 0;
        const newText = text.replace(pattern, () => {
          count += 1;
          return replaceText;
        });
        return { newText, count };
      };

      const getSerialStringForIndex = (index) => {
        if (!addSerial) return '';
        const start = Number.isFinite(serialStart) ? Number(serialStart) : 1;
        const digits = Number.isFinite(serialDigits) && serialDigits > 0 ? Number(serialDigits) : 1;
        const value = start + index;
        return String(value).padStart(digits, '0');
      };

      orderedTargetIds.forEach((id, index) => {
        const prompt = this.prompts[id];
        if (!prompt) return;
        let changesForPrompt = 0;

        const originalName = prompt.name ?? '';
        const originalContent = prompt.content ?? '';

        const serialStr = getSerialStringForIndex(index);

        // Title
        if (targetFields?.title) {
          let text = originalName;
          // regex replacement
          const { newText: replacedText, count } = replaceInText(text);
          text = replacedText;
          if (count > 0) changesForPrompt += count;

          // additions
          if (hasAdditions) {
            let prefix = addPrefix ? String(prefixText || '') : '';
            let suffix = addSuffix ? String(suffixText || '') : '';
            if (addSerial) {
              if (serialPosition === 'before') {
                prefix = prefix + serialStr;
              } else {
                suffix = suffix + serialStr;
              }
            }
            text = `${prefix}${text}${suffix}`;
            changesForPrompt += 1; // count additions as one change for this field
          }

          if (text !== originalName) {
            prompt.name = text;
          }
          var finalNameForHistory = text;
        }

        // Content
        if (targetFields?.content && !prompt.marker) {
          let text = originalContent;
          // regex replacement
          const { newText: replacedText, count } = replaceInText(text);
          text = replacedText;
          if (count > 0) changesForPrompt += count;

          // additions
          if (hasAdditions) {
            let prefix = addPrefix ? String(prefixText || '') : '';
            let suffix = addSuffix ? String(suffixText || '') : '';
            if (addSerial) {
              if (serialPosition === 'before') {
                prefix = prefix + serialStr;
              } else {
                suffix = suffix + serialStr;
              }
            }
            text = `${prefix}${text}${suffix}`;
            changesForPrompt += 1; // count additions as one change for this field
          }

          if (text !== originalContent) {
            prompt.content = text;
            contentChanged = true;
          }
          var finalContentForHistory = text;
        }

        if (changesForPrompt > 0) {
          totalChanges += changesForPrompt;
          historyEntry.changes.push({
            promptId: id,
            before: { name: originalName, content: originalContent },
            after: {
              name: typeof finalNameForHistory !== 'undefined' ? finalNameForHistory : originalName,
              content:
                typeof finalContentForHistory !== 'undefined'
                  ? finalContentForHistory
                  : originalContent,
            },
          });
        }
      });

      if (contentChanged) {
        this.analyzeAllMacros();
      }

      if (historyEntry.changes.length > 0) {
        this.batchReplaceHistory.push(historyEntry);
        // Any new forward change invalidates redo stack
        this.batchReplaceRedoStack = [];
        this.touchActivePresetDebounced();
      }

      return { matches: totalChanges, prompts: historyEntry.changes.length };
    },
    /** Undo last batch replace/additions change */
    undoLastBatchChange() {
      if (!this.batchReplaceHistory || this.batchReplaceHistory.length === 0) {
        return { prompts: 0 };
      }
      const entry = this.batchReplaceHistory.pop();
      if (!entry || !Array.isArray(entry.changes) || entry.changes.length === 0) {
        return { prompts: 0 };
      }
      // Push to redo stack before applying revert
      this.batchReplaceRedoStack.push(entry);
      let contentChanged = false;
      entry.changes.forEach((change) => {
        const prompt = this.prompts[change.promptId];
        if (!prompt) return;
        if (typeof change.before.name === 'string' && prompt.name !== change.before.name) {
          prompt.name = change.before.name;
        }
        if (typeof change.before.content === 'string' && prompt.content !== change.before.content) {
          prompt.content = change.before.content;
          contentChanged = true;
        }
      });
      if (contentChanged) {
        this.analyzeAllMacros();
      }
      // promptsAffected counts fields; for user-facing, count distinct prompts
      this.touchActivePresetDebounced();
      const distinctPrompts = new Set(entry.changes.map((c) => c.promptId)).size;
      return { prompts: distinctPrompts };
    },
    /** Redo last undone batch change */
    redoLastBatchChange() {
      if (!this.batchReplaceRedoStack || this.batchReplaceRedoStack.length === 0) {
        return { prompts: 0 };
      }
      const entry = this.batchReplaceRedoStack.pop();
      if (!entry || !Array.isArray(entry.changes) || entry.changes.length === 0) {
        return { prompts: 0 };
      }
      let contentChanged = false;
      entry.changes.forEach((change) => {
        const prompt = this.prompts[change.promptId];
        if (!prompt) return;
        if (typeof change.after.name === 'string' && prompt.name !== change.after.name) {
          prompt.name = change.after.name;
        }
        if (typeof change.after.content === 'string' && prompt.content !== change.after.content) {
          prompt.content = change.after.content;
          contentChanged = true;
        }
      });
      if (contentChanged) {
        this.analyzeAllMacros();
      }
      // Push back to history as a new step (so we can undo the redo)
      this.batchReplaceHistory.push(entry);
      this.touchActivePresetDebounced();
      const distinctPrompts = new Set(entry.changes.map((c) => c.promptId)).size;
      return { prompts: distinctPrompts };
    },

    // --- Cloud sync helpers (used by stores/cloudSync.js) ---

    /**
     * Build a plain snapshot of just the given data paths for upload.
     * @param {string[]} [paths] - which state paths to include (default: full sync set)
     * @returns {Object} snapshot keyed by the chosen paths
     */
    buildSyncSnapshot(paths = SYNC_DATA_PATHS) {
      const snapshot = {};
      paths.forEach((key) => {
        snapshot[key] = this[key];
      });
      return snapshot;
    },

    /**
     * Replace local data with a snapshot pulled from the cloud, then re-analyze.
     * @param {Object} data - snapshot previously produced by buildSyncSnapshot
     * @param {string[]} [paths] - which keys to adopt (default: full sync set)
     */
    applyCloudData(data, paths = SYNC_DATA_PATHS) {
      if (!data || typeof data !== 'object') return;
      paths.forEach((key) => {
        if (key in data) this[key] = data[key];
      });
      this.analyzeAllMacros();
      this.applyTheme(); // the snapshot may carry a different themeMode
    },
  },
  persist: {
    // Only persist the essential user data, not derived/UI states
    paths: [
      'rawJson',
      'originalFilename',
      'prompts',
      'promptOrder',
      'macroDisplayMode',
      'currentLanguage',
      'promptCollapseStates',
      'globalCollapseState',
      'skipDeleteConfirmation',
      'savedPresets',
      'currentPresetId',
      'defaultPresetId',
      'customMacros',
      'customWraps',
      'themeMode',
      // Device-specific layout — persisted but deliberately NOT in
      // SYNC_DATA_PATHS (pane sizes should not follow you across devices).
      'paneSizes',
    ],
    beforeRestore: () => {
      console.log('[Persistence] About to restore store from localStorage');
    },
    afterRestore: (ctx) => {
      const hasPersistedData = Boolean(ctx.store.rawJson);
      console.log(`[Persistence] Store restored. Has persisted data: ${hasPersistedData}`);
      if (hasPersistedData) {
        console.log(
          `[Persistence] Loaded ${Object.keys(ctx.store.prompts).length} prompts, ${ctx.store.promptOrder.length} in order`,
        );
        // Re-analyze macros after restore since derived states are not persisted
        console.log('[Persistence] Re-analyzing macros after restore...');
        ctx.store.analyzeAllMacros();
      }
    },
  },
});
