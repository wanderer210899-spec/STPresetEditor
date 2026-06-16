<template>
  <div class="relative">
    <textarea
      :id="id"
      ref="ta"
      :value="modelValue"
      :rows="rows"
      :placeholder="placeholder"
      :readonly="readonly"
      :class="textareaClass"
      @input="onInput"
      @keydown="onKeydown"
      @keyup="onKeyup"
      @click="computeContext"
      @blur="onBlur"
    />

    <ul
      v-if="open && suggestions.length"
      class="absolute z-50 max-h-56 w-72 max-w-[90%] overflow-auto rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg"
      :style="{ top: menuTop + 'px', left: menuLeft + 'px' }"
    >
      <li
        v-for="(s, i) in suggestions"
        :key="s.value + '-' + i"
        class="flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5"
        :class="i === activeIndex ? 'bg-blue-600 text-white' : 'text-gray-800 hover:bg-gray-100'"
        @mousedown.prevent="accept(i)"
        @mouseenter="activeIndex = i"
      >
        <span class="font-mono">{{ s.label }}</span>
        <span
          class="truncate text-xs"
          :class="i === activeIndex ? 'text-blue-100' : 'text-gray-400'"
        >
          {{ s.hint }}
        </span>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { nextTick, onMounted, ref, watch } from 'vue';
import { usePresetStore } from '../stores/presetStore';
import { getCaretCoordinates } from '../utils/caret';
import { MACRO_CATALOG, VAR_MACRO_META } from '../utils/macros';

const props = defineProps({
  modelValue: { type: String, default: '' },
  rows: { type: [Number, String], default: 6 },
  placeholder: { type: String, default: '' },
  readonly: { type: Boolean, default: false },
  autoGrow: { type: Boolean, default: false },
  textareaClass: { type: String, default: 'input font-mono' },
  id: { type: String, default: undefined },
});

const emit = defineEmits(['update:modelValue']);

const store = usePresetStore();

const ta = ref(null);
const open = ref(false);
const suggestions = ref([]);
const activeIndex = ref(0);
const menuTop = ref(0);
const menuLeft = ref(0);
// Active completion context: { mode: 'macro'|'var', start, end, meta? }
let context = null;

const MAX_SUGGESTIONS = 8;

function emitValue(value) {
  emit('update:modelValue', value);
}

function adjustHeight() {
  if (!props.autoGrow || !ta.value) return;
  ta.value.style.height = 'auto';
  ta.value.style.height = `${ta.value.scrollHeight}px`;
}

function closeMenu() {
  open.value = false;
  suggestions.value = [];
  context = null;
}

function macroCatalog() {
  // Built-in catalog plus the user's custom {{name}} macros (additive).
  const custom = (store.customMacros || []).map((m) => ({
    name: m.name,
    hint: m.hint || 'custom macro',
    insert: 'plain',
  }));
  return [...MACRO_CATALOG, ...custom];
}

function macroSuggestions(query) {
  const q = query.toLowerCase();
  return macroCatalog()
    .filter((m) => m.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts;
    })
    .slice(0, MAX_SUGGESTIONS)
    .map((m) => ({ value: m.name, label: m.name, hint: m.hint, insert: m.insert }));
}

// Ctrl+Space snippet menu: custom wrapping pairs first, then macros — matched
// against the non-whitespace word before the caret.
function snippetSuggestions(query) {
  const q = query.toLowerCase();
  const wraps = (store.customWraps || []).map((w, idx) => ({
    value: w.label || w.open,
    label: w.label || w.open,
    hint: w.hint || 'wrap',
    wrap: w,
    _i: idx,
  }));
  const macros = macroCatalog().map((m) => ({
    value: m.name,
    label: m.name,
    hint: m.hint,
    insert: m.insert,
  }));
  const match = (s) =>
    !q || s.label.toLowerCase().includes(q) || (s.wrap && s.wrap.open.toLowerCase().includes(q));
  return [...wraps.filter(match), ...macros.filter(match)].slice(0, MAX_SUGGESTIONS);
}

function varSuggestions(query) {
  const q = query.trim().toLowerCase();
  const names = Object.keys(store.variables || {});
  return names
    .filter((name) => name.toLowerCase().includes(q))
    .sort()
    .slice(0, MAX_SUGGESTIONS)
    .map((name) => ({ value: name, label: name, hint: 'variable' }));
}

function positionMenu(caret) {
  const el = ta.value;
  if (!el) return;
  const coords = getCaretCoordinates(el, caret);
  menuTop.value = coords.top + coords.height - el.scrollTop;
  menuLeft.value = Math.max(0, Math.min(coords.left - el.scrollLeft, el.clientWidth - 40));
}

function computeContext() {
  const el = ta.value;
  if (!el || props.readonly) {
    closeMenu();
    return;
  }
  const value = el.value;
  const caret = el.selectionStart;
  const before = value.slice(0, caret);
  const openIdx = before.lastIndexOf('{{');
  if (openIdx === -1) {
    closeMenu();
    return;
  }
  const between = before.slice(openIdx + 2);
  // A `}}` between the braces and the caret means we are not inside a macro.
  if (between.includes('}}')) {
    closeMenu();
    return;
  }

  // Macros 2.0 shorthand: typing a variable name after `{{.` or `{{$`.
  const sh = between.match(/^([.$])([A-Za-z][\w-]*)?$/);
  if (sh) {
    const items = varSuggestions(sh[2] || '');
    if (!items.length) {
      closeMenu();
      return;
    }
    context = { mode: 'shorthand', start: openIdx + 3, end: caret };
    suggestions.value = items;
    activeIndex.value = 0;
    open.value = true;
    positionMenu(caret);
    return;
  }

  if (!between.includes('::')) {
    // Typing the macro name.
    const items = macroSuggestions(between.trim());
    if (!items.length) {
      closeMenu();
      return;
    }
    context = { mode: 'macro', start: openIdx, end: caret };
    suggestions.value = items;
    activeIndex.value = 0;
    open.value = true;
    positionMenu(caret);
    return;
  }

  // After `::` — offer variable names for the first arg of a variable macro.
  const segments = between.split('::');
  const head = segments[0].trim().toLowerCase();
  const meta = VAR_MACRO_META[head];
  if (meta && segments.length === 2) {
    const items = varSuggestions(segments[1]);
    if (!items.length) {
      closeMenu();
      return;
    }
    const varStart = openIdx + 2 + between.lastIndexOf('::') + 2;
    context = { mode: 'var', start: varStart, end: caret, meta };
    suggestions.value = items;
    activeIndex.value = 0;
    open.value = true;
    positionMenu(caret);
    return;
  }

  closeMenu();
}

// Ctrl+Space: open a snippet menu (custom wraps + macros) for the current word,
// preserving any active selection so a chosen wrap can surround it.
function openSnippetMenu() {
  const el = ta.value;
  if (!el || props.readonly) return;
  const selStart = el.selectionStart;
  const selEnd = el.selectionEnd;
  const hasSelection = selEnd > selStart;
  // With a selection, wrap exactly it and show all snippets. With just a caret,
  // replace the non-whitespace word being typed and filter the menu on it.
  const word = hasSelection ? '' : (el.value.slice(0, selStart).match(/(\S*)$/) || ['', ''])[1];
  const items = snippetSuggestions(word);
  if (!items.length) {
    closeMenu();
    return;
  }
  context = {
    mode: 'snippet',
    start: hasSelection ? selStart : selStart - word.length,
    end: selEnd,
    selection: hasSelection ? el.value.slice(selStart, selEnd) : '',
  };
  suggestions.value = items;
  activeIndex.value = 0;
  open.value = true;
  positionMenu(selEnd);
}

function accept(i) {
  const s = suggestions.value[i];
  const el = ta.value;
  if (!s || !el || !context) return;

  const value = el.value;
  const { start, end, mode } = context;
  let insertText = '';
  let caretOffset = 0;

  if (mode === 'snippet') {
    if (s.wrap) {
      // Wrap the current selection (if any) with open…close, else drop the
      // caret between them. Replaces the typed trigger word.
      const inner = context.selection || '';
      insertText = s.wrap.open + inner + s.wrap.close;
      caretOffset = s.wrap.open.length + inner.length;
    } else if (s.insert === 'args') {
      insertText = `{{${s.value}}}`;
      caretOffset = 2 + s.value.length;
    } else if (s.insert === 'var1' || s.insert === 'var2') {
      insertText = `{{${s.value}::`;
      caretOffset = insertText.length;
    } else {
      insertText = `{{${s.value}}}`;
      caretOffset = insertText.length;
    }
    const newValue = value.slice(0, start) + insertText + value.slice(end);
    const caretPos = start + caretOffset;
    emitValue(newValue);
    closeMenu();
    nextTick(() => {
      el.value = newValue;
      el.focus();
      el.setSelectionRange(caretPos, caretPos);
      if (props.autoGrow) adjustHeight();
    });
    return;
  }

  if (mode === 'macro') {
    const name = s.value;
    if (s.insert === 'var1' || s.insert === 'var2') {
      // Open the variable macro; the `::` then triggers variable suggestions.
      insertText = `{{${name}::`;
      caretOffset = insertText.length;
    } else if (s.insert === 'args') {
      // Leave the caret inside the braces for free-form arguments.
      insertText = `{{${name}}}`;
      caretOffset = 2 + name.length;
    } else {
      insertText = `{{${name}}}`;
      caretOffset = insertText.length;
    }
  } else if (mode === 'shorthand') {
    // Variable name chosen for the {{.name}} / {{$name}} shorthand.
    insertText = s.value;
    caretOffset = s.value.length;
  } else {
    // Variable name chosen — close (single-arg) or add `::` (two-arg) unless
    // the macro is already closed right after the caret.
    const name = s.value;
    const alreadyClosed = value.slice(end, end + 2) === '}}';
    if (context.meta.args === 2) {
      insertText = alreadyClosed ? name : `${name}::`;
    } else {
      insertText = alreadyClosed ? name : `${name}}}`;
    }
    // Both the trailing `::` and `}}` are 2 chars, so the caret lands after them.
    caretOffset = name.length + (alreadyClosed ? 0 : 2);
  }

  const newValue = value.slice(0, start) + insertText + value.slice(end);
  const caretPos = start + caretOffset;
  // Only a freshly-opened variable macro should chain into name suggestions.
  const chain = mode === 'macro' && (s.insert === 'var1' || s.insert === 'var2');
  emitValue(newValue);
  closeMenu();

  nextTick(() => {
    el.value = newValue;
    el.focus();
    el.setSelectionRange(caretPos, caretPos);
    if (props.autoGrow) adjustHeight();
    if (chain) computeContext();
  });
}

function onInput(event) {
  emitValue(event.target.value);
  if (props.autoGrow) adjustHeight();
  nextTick(computeContext);
}

function onKeydown(event) {
  // Ctrl+Space opens the snippet menu (doc-aligned) regardless of current state.
  if (event.ctrlKey && (event.code === 'Space' || event.key === ' ')) {
    event.preventDefault();
    openSnippetMenu();
    return;
  }
  if (!open.value || !suggestions.value.length) return;
  const len = suggestions.value.length;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    activeIndex.value = (activeIndex.value + 1) % len;
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    activeIndex.value = (activeIndex.value - 1 + len) % len;
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    accept(activeIndex.value);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu();
  }
}

function onKeyup(event) {
  // Caret-moving keys can change the macro context without an input event.
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    computeContext();
  }
}

function onBlur() {
  // Delay so a mousedown on a suggestion (which is prevented) can run first.
  window.setTimeout(closeMenu, 100);
}

watch(
  () => props.modelValue,
  () => {
    if (props.autoGrow) nextTick(adjustHeight);
  },
);

onMounted(() => {
  if (props.autoGrow) adjustHeight();
});

defineExpose({
  focus: () => ta.value?.focus(),
});
</script>
