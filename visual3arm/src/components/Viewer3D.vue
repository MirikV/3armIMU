<template>
  <div class="viewer">
    <canvas ref="canvas" class="viewer__canvas" touch-action="none"></canvas>
    <div class="viewer__hud mono">
      <span :class="['dot', stateClass]"></span>
      {{ telemetry.connection.state }}
      <span class="sep">|</span> {{ telemetry.hz }} Гц
      <span class="sep">|</span> пакетов: {{ telemetry.messages }}
      <span v-if="telemetry.ageMs !== null" class="sep">|</span>
      <span v-if="telemetry.ageMs !== null">лаг {{ telemetry.ageMs }} мс</span>
    </div>
    <div class="viewer__legend mono">
      <span style="color: #ff4d4d">X</span> восток ·
      <span style="color: #4dff88">Y</span> вверх ·
      <span style="color: #4d8cff">Z</span> север
    </div>
  </div>
</template>

<script>
import { SceneManager } from '../scene/SceneManager.js';
import { RobotRig } from '../scene/RobotRig.js';
import { settings, telemetry, live, actions, robotModel } from '../store/index.js';

export default {
  name: 'Viewer3D',
  data() {
    return { settings, telemetry };
  },
  computed: {
    stateClass() {
      const s = this.telemetry.connection.state;
      if (s === 'connected') return 'dot--ok';
      if (s === 'error') return 'dot--err';
      if (s === 'connecting' || s === 'reconnecting') return 'dot--warn';
      return 'dot--idle';
    },
  },
  mounted() {
    this.sm = new SceneManager(this.$refs.canvas);
    this.robotRig = new RobotRig(this.sm, robotModel, { position: { x: 0.85, y: -0.9, z: 0 } });
    this.applyView();

    // dt приходит из движка — это реальное время кадра. Приводы робота интегрируются
    // именно здесь, а не на приёме пакета: физика мотора не обязана зависеть от того,
    // как часто часы шлют данные. Модель компонент не трогает, всё через actions.
    this.stopRender = this.sm.onRender((dt) => {
      actions.stepRobot(dt);
      this.robotRig.apply();
    });
    this.sm.start();

    if (this.settings.robot.glbUrl) this.loadGlb(this.settings.robot.glbUrl);
  },
  beforeDestroy() {
    this.stopRender?.();
    this.sm?.dispose();
  },
  watch: {
    'settings.view': {
      deep: true,
      handler() {
        this.applyView();
      },
    },
    'settings.robot.glbUrl'(url) {
      if (url) {
        this.loadGlb(url);
        return;
      }
      // Пустой путь — не «выключено», а штатный режим примитивов: робот на сцене
      // остаётся, поэтому и статус загрузки надо убрать, а не оставлять висеть.
      this.robotRig?.unloadGlb();
      telemetry.glbStatus = '';
      telemetry.robotMissingNodes = [];
    },
  },
  methods: {
    applyView() {
      const v = this.settings.view;
      this.robotRig?.setVisible(v.showRobot && this.settings.robot.enabled);
      this.sm.setWorldAxesVisible(v.showWorldAxes);
      this.sm.setGroundVisible(v.showGround);
    },
    async loadGlb(url) {
      try {
        telemetry.glbStatus = 'загрузка…';
        const res = await this.robotRig.loadGlb(url);
        telemetry.robotMissingNodes = res.missing;
        telemetry.glbStatus = res.missing.length
          ? `загружено, но не найдены узлы: ${res.missing.join(', ')}`
          : `загружено, привязано шарниров: ${res.bound.length}`;
      } catch (err) {
        // Файла нет или он битый — это не повод оставлять пустую сцену: риг уже
        // вернулся к примитивам внутри loadGlb(), пользователю остаётся текст ошибки.
        telemetry.robotMissingNodes = [];
        telemetry.glbStatus = `не загрузилось (${err.message}) — показаны примитивы`;
      }
    },
  },
};
</script>

<style scoped>
.viewer {
  position: relative;
  height: 100%;
  min-width: 0;
}

.viewer__canvas {
  width: 100%;
  height: 100%;
  display: block;
  outline: none;
}

.viewer__hud,
.viewer__legend {
  position: absolute;
  left: 12px;
  padding: 5px 9px;
  border-radius: 7px;
  background: rgba(12, 14, 20, 0.72);
  border: 1px solid var(--line);
  color: var(--muted);
  pointer-events: none;
}

.viewer__hud {
  top: 12px;
}

.viewer__legend {
  bottom: 12px;
}

.sep {
  opacity: 0.4;
  margin: 0 2px;
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
  background: var(--muted);
}

.dot--ok {
  background: var(--ok);
}
.dot--warn {
  background: var(--warn);
}
.dot--err {
  background: var(--err);
}
.dot--idle {
  background: #555c6e;
}
</style>
