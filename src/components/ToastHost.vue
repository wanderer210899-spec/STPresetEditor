<template>
  <div
    class="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end sm:pr-6"
  >
    <transition-group name="toast">
      <div
        v-for="toast in store.toasts"
        :key="toast.id"
        class="pointer-events-auto flex max-w-sm items-center gap-3 rounded-lg px-4 py-3 text-sm shadow-lg ring-1"
        :class="toastClass(toast.type)"
      >
        <component :is="toastIcon(toast.type)" class="h-5 w-5 flex-shrink-0" />
        <span class="flex-1">{{ toast.message }}</span>
        <button class="btn-icon btn-icon-sm -mr-1" @click="store.dismissToast(toast.id)">
          <XMarkIcon class="h-4 w-4" />
        </button>
      </div>
    </transition-group>
  </div>
</template>

<script setup>
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  InformationCircleIcon,
  XMarkIcon,
} from '@heroicons/vue/24/outline';
import { usePresetStore } from '../stores/presetStore';

const store = usePresetStore();

const toastClass = (type) =>
  ({
    success: 'bg-green-50 text-green-800 ring-green-200',
    error: 'bg-red-50 text-red-800 ring-red-200',
    info: 'bg-white text-gray-800 ring-gray-200',
  })[type] || 'bg-white text-gray-800 ring-gray-200';

const toastIcon = (type) =>
  ({
    success: CheckCircleIcon,
    error: ExclamationCircleIcon,
    info: InformationCircleIcon,
  })[type] || InformationCircleIcon;
</script>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.25s ease,
    transform 0.25s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(0.5rem);
}
</style>
