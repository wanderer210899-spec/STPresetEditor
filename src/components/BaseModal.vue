<template>
  <TransitionRoot appear :show="show" as="template">
    <Dialog as="div" class="relative z-50" @close="$emit('close')">
      <TransitionChild
        as="template"
        enter="duration-300 ease-out"
        enter-from="opacity-0"
        enter-to="opacity-100"
        leave="duration-200 ease-in"
        leave-from="opacity-100"
        leave-to="opacity-0"
      >
        <div class="fixed inset-0 bg-black/30" />
      </TransitionChild>

      <div class="fixed inset-0 overflow-y-auto">
        <div class="flex min-h-full items-center justify-center p-4 text-center">
          <TransitionChild
            as="template"
            enter="duration-300 ease-out"
            enter-from="opacity-0 scale-95"
            enter-to="opacity-100 scale-100"
            leave="duration-200 ease-in"
            leave-from="opacity-100 scale-100"
            leave-to="opacity-0 scale-95"
          >
            <DialogPanel
              :class="[
                'w-full transform overflow-hidden rounded-2xl bg-white text-left align-middle shadow-xl transition-all',
                sizeClass,
              ]"
            >
              <!-- Header -->
              <div
                v-if="title || $slots['header-actions']"
                class="flex items-center justify-between gap-3 border-b border-gray-200 px-6 py-4"
              >
                <DialogTitle as="h3" class="section-title">{{ title }}</DialogTitle>
                <div class="flex items-center gap-2">
                  <slot name="header-actions" />
                  <button
                    class="btn-icon"
                    :aria-label="store.t('common.close')"
                    @click="$emit('close')"
                  >
                    <XMarkIcon class="h-6 w-6" />
                  </button>
                </div>
              </div>

              <!-- Body -->
              <div class="max-h-[70vh] overflow-y-auto px-6 py-6">
                <slot />
              </div>

              <!-- Footer -->
              <div
                v-if="!hideFooter"
                class="flex items-center gap-3 border-t border-gray-200 px-6 py-4"
              >
                <slot name="footer-start" />
                <div class="ml-auto flex items-center gap-3">
                  <slot name="footer">
                    <button class="btn btn-secondary" @click="$emit('close')">
                      {{ store.t('common.close') }}
                    </button>
                  </slot>
                </div>
              </div>
            </DialogPanel>
          </TransitionChild>
        </div>
      </div>
    </Dialog>
  </TransitionRoot>
</template>

<script setup>
import { Dialog, DialogPanel, DialogTitle, TransitionChild, TransitionRoot } from '@headlessui/vue';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import { computed } from 'vue';
import { usePresetStore } from '../stores/presetStore';

const props = defineProps({
  show: { type: Boolean, default: false },
  title: { type: String, default: '' },
  // Literal class strings so Tailwind can detect them at build time.
  size: { type: String, default: 'md' }, // sm | md | lg | xl | 2xl
  hideFooter: { type: Boolean, default: false },
});

defineEmits(['close']);

const store = usePresetStore();

const sizeClass = computed(
  () =>
    ({
      sm: 'max-w-md',
      md: 'max-w-lg',
      lg: 'max-w-2xl',
      xl: 'max-w-3xl',
      '2xl': 'max-w-4xl',
    })[props.size] || 'max-w-lg',
);
</script>
