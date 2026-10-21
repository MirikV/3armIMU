<template>
  <section class="section">
    <header class="section__head" @click="open = !open">
      <span class="section__chev">{{ open ? '▾' : '▸' }}</span>
      <span class="section__title">{{ title }}</span>
      <span class="section__note mono">{{ note }}</span>
    </header>
    <div v-show="open" class="section__body">
      <slot />
    </div>
  </section>
</template>

<script>
export default {
  name: 'UiSection',
  props: {
    title: { type: String, required: true },
    note: { type: String, default: '' },
    initiallyOpen: { type: Boolean, default: true },
  },
  data() {
    return { open: this.initiallyOpen };
  },
};
</script>

<style scoped>
.section {
  border-bottom: 1px solid var(--line);
}

.section__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 12px;
  cursor: pointer;
  user-select: none;
  background: var(--panel);
}

.section__head:hover {
  background: var(--panel-2);
}

.section__chev {
  color: var(--muted);
  width: 10px;
}

.section__title {
  font-weight: 600;
  letter-spacing: 0.2px;
}

.section__note {
  margin-left: auto;
  color: var(--muted);
  font-size: 11px;
}

.section__body {
  padding: 4px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
