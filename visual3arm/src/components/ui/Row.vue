<template>
  <label class="row">
    <span class="row__label" :title="hint">{{ label }}</span>
    <span class="row__control"><slot /></span>
  </label>
</template>

<script>
export default {
  name: 'UiRow',
  props: {
    label: { type: String, required: true },
    hint: { type: String, default: '' },
  },
};
</script>

<style scoped>
.row {
  display: grid;
  grid-template-columns: 116px 1fr;
  align-items: center;
  gap: 8px;
}

.row__label {
  color: var(--muted);
  font-size: 12px;
}

.row__control {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
</style>
