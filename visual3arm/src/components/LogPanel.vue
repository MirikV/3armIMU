<template>
  <ui-section title="Последние пакеты" :note="telemetry.messages + ' шт'" :initially-open="false">
    <div class="log mono">
      <div v-if="!lines.length" class="empty">пока пусто</div>
      <div v-for="(line, i) in lines" :key="i" class="log__line">{{ line }}</div>
    </div>
    <div class="note">
      Если пакет не разбирается — посмотрите сюда и подправьте «Формат» / «Путь в JSON».
      Поддерживаются <code>[x,y,z,w]</code>, <code>{{ '{x,y,z,w}' }}</code>,
      <code>{{ '{values:[...]}' }}</code> и числа через запятую.
    </div>
  </ui-section>
</template>

<script>
import UiSection from './ui/Section.vue';
import { telemetry, actions } from '../store/index.js';

export default {
  name: 'LogPanel',
  components: { UiSection },
  data() {
    return { telemetry, lines: [] };
  },
  mounted() {
    this.timer = setInterval(() => {
      this.lines = actions.rawLog().slice(0, 12);
    }, 300);
  },
  beforeDestroy() {
    clearInterval(this.timer);
  },
};
</script>

<style scoped>
.log {
  background: #0e1018;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 8px;
  max-height: 180px;
  overflow: auto;
  font-size: 11px;
}

.log__line {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--muted);
}

.empty {
  color: #4d5567;
}

.note {
  color: var(--muted);
  font-size: 11px;
}
</style>
