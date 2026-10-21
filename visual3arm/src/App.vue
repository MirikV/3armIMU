<template>
  <div class="app">
    <viewer3-d class="app__viewer" />
    <aside class="app__side">
      <header class="app__head">
        <div>
          <div class="app__title">visual3arm</div>
          <div class="app__sub">рука по rotation vector с Galaxy Watch 6</div>
        </div>
        <button class="app__reset" title="Сбросить настройки" @click="actions.resetSettings()">⟲</button>
      </header>
      <connection-panel />
      <orientation-panel />
      <robot-panel />
      <log-panel />
    </aside>
  </div>
</template>

<script>
import Viewer3D from './components/Viewer3D.vue';
import ConnectionPanel from './components/ConnectionPanel.vue';
import OrientationPanel from './components/OrientationPanel.vue';
import RobotPanel from './components/RobotPanel.vue';
import LogPanel from './components/LogPanel.vue';
import { actions } from './store/index.js';

export default {
  name: 'App',
  components: { Viewer3D, ConnectionPanel, OrientationPanel, RobotPanel, LogPanel },
  data() {
    return { actions };
  },
  created() {
    actions.init();
  },
  beforeDestroy() {
    actions.dispose();
  },
};
</script>

<style scoped>
.app {
  display: grid;
  grid-template-columns: 1fr 340px;
  height: 100%;
}

.app__viewer {
  min-width: 0;
}

.app__side {
  border-left: 1px solid var(--line);
  background: var(--panel);
  overflow-y: auto;
}

.app__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  background: var(--panel);
  z-index: 2;
}

.app__title {
  font-weight: 700;
  letter-spacing: 0.3px;
}

.app__sub {
  color: var(--muted);
  font-size: 11px;
}

.app__reset {
  margin-left: auto;
  padding: 2px 8px;
}

@media (max-width: 900px) {
  .app {
    grid-template-columns: 1fr;
    grid-template-rows: 55vh 1fr;
  }

  .app__side {
    border-left: none;
    border-top: 1px solid var(--line);
  }
}
</style>
