<template>
  <BaseModal :show="isOpen" :title="title" size="2xl" @close="store.closeDetailsModal()">
    <slot />
  </BaseModal>
</template>

<script setup>
import { usePresetStore } from '../stores/presetStore';
import BaseModal from './BaseModal.vue';

defineProps({
  isOpen: {
    type: Boolean,
    default: false,
  },
  title: {
    type: String,
    default: '',
  },
});

const store = usePresetStore();
</script>
