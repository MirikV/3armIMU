<template>
  <ui-section title="Ориентация и калибровка" :note="telemetry.hz + ' Гц'">
    <div class="grid mono">
      <div class="cell">
        <div class="cell__key">кватернион (сырой)</div>
        <div>{{ fmtQ(telemetry.quatRaw) }}</div>
      </div>
      <div class="cell">
        <div class="cell__key">кватернион (после калибровки)</div>
        <div>{{ fmtQ(telemetry.quatCal) }}</div>
      </div>
      <div class="cell">
        <div class="cell__key">Android: азимут / тангаж / крен</div>
        <div>
          {{ telemetry.anglesAndroidDeg.azimuth }}° /
          {{ telemetry.anglesAndroidDeg.pitch }}° /
          {{ telemetry.anglesAndroidDeg.roll }}°
        </div>
      </div>
      <div class="cell">
        <div class="cell__key">Babylon YXZ: yaw / pitch / roll</div>
        <div>
          {{ telemetry.anglesBabylonDeg.yaw }}° /
          {{ telemetry.anglesBabylonDeg.pitch }}° /
          {{ telemetry.anglesBabylonDeg.roll }}°
        </div>
      </div>
      <div class="cell">
        <div class="cell__key">точность курса</div>
        <div>{{ telemetry.accuracyDeg === null ? '—' : telemetry.accuracyDeg + '°' }}</div>
      </div>
      <div class="cell">
        <div class="cell__key">угловая скорость</div>
        <div>{{ telemetry.omegaDegPerSec }} °/с</div>
      </div>
    </div>

    <ui-row label="Сглаживание" hint="Постоянная времени фильтра, 0 — выключено">
      <input
        type="range"
        min="0"
        max="0.3"
        step="0.005"
        v-model.number="settings.smoothingTau"
        @change="actions.applySmoothing()"
      />
      <span class="val mono">{{ (settings.smoothingTau * 1000).toFixed(0) }} мс</span>
    </ui-row>

    <ui-row label="Режим нуля" hint="heading гасит только курс — полезно против ухода магнитометра">
      <select v-model="settings.zeroMode" @change="actions.applyZeroMode()">
        <option value="full">полный</option>
        <option value="heading">только курс</option>
      </select>
    </ui-row>

    <div class="hint">
      Курс у часов относительный (датчик намеренно без магнитометра), поэтому его начало
      произвольно. Вытяните руку вперёд и нажмите «Обнулить по текущей позе» — это
      направление станет нулевым азимутом робота. Ноль сохраняется и переживает
      перезагрузку; менять порядок с «Измерить скруткой» не нужно, он пересчитывается сам.
    </div>
    <div class="grid mono">
      <div class="cell">
        <div class="cell__key">ноль</div>
        <div :class="{ warn: !telemetry.zeroSet }">
          {{ telemetry.zeroSet ? 'взят' : 'не взят — азимут произвольный' }}
        </div>
      </div>
    </div>

    <div class="buttons">
      <button class="primary" @click="actions.captureZero()">Обнулить по текущей позе</button>
      <button @click="actions.clearZero()">Сбросить ноль</button>
    </div>

    <div class="subtitle">Ось предплечья</div>
    <div class="hint">
      Часы сидят на запястье как попало, а вся развязка осей держится на том, где у них
      «вдоль руки». Нажмите «Измерить» и 2–3 секунды покрутите кистью вокруг предплечья,
      больше ничем не двигая. Пока ось не измерена, скрутка кисти будет уводить основание.
    </div>
    <div class="grid mono">
      <div class="cell">
        <div class="cell__key">отклонение оси от «12 часов»</div>
        <div>{{ telemetry.forearmAxisDeg }}°</div>
      </div>
      <div class="cell" v-if="telemetry.forearmCal.active || telemetry.forearmCal.steps">
        <div class="cell__key">жест: размах / чистота</div>
        <div>
          {{ telemetry.forearmCal.sweepDeg }}° /
          {{ (telemetry.forearmCal.quality * 100).toFixed(0) }}%
        </div>
      </div>
      <div class="cell" v-if="axisResult">
        <div class="cell__key">результат</div>
        <div>{{ axisResult }}</div>
      </div>
    </div>
    <div class="buttons">
      <button
        :class="{ primary: !telemetry.forearmCal.active, danger: telemetry.forearmCal.active }"
        @click="toggleAxisCalibration()"
      >
        {{ telemetry.forearmCal.active ? 'Готово' : 'Измерить скруткой' }}
      </button>
      <button @click="flipAxis()">Развернуть ось</button>
      <button @click="resetAxis()">Сбросить</button>
    </div>

    <div class="subtitle">Установка часов на запястье (градусы)</div>
    <ui-row
      v-for="axis in ['x', 'y', 'z']"
      :key="axis"
      :label="mountLabels[axis]"
      hint="Поворот корпуса часов относительно предплечья"
    >
      <input
        type="range"
        min="-180"
        max="180"
        step="1"
        v-model.number="settings.mountEulerDeg[axis]"
        @change="actions.applyMount()"
      />
      <span class="val mono">{{ settings.mountEulerDeg[axis] }}°</span>
    </ui-row>
  </ui-section>
</template>

<script>
import UiSection from './ui/Section.vue';
import UiRow from './ui/Row.vue';
import { settings, telemetry, actions } from '../store/index.js';

export default {
  name: 'OrientationPanel',
  components: { UiSection, UiRow },
  data() {
    return {
      settings,
      telemetry,
      actions,
      mountLabels: { x: 'наклон (X)', y: 'вокруг руки (Y)', z: 'поворот (Z)' },
      /** Итог последнего измерения оси — строкой, чтобы человек видел, что вышло. */
      axisResult: '',
    };
  },
  methods: {
    fmtQ(q) {
      return `${q.x} ${q.y} ${q.z} ${q.w}`;
    },
    toggleAxisCalibration() {
      if (telemetry.forearmCal.active) {
        const r = actions.finishForearmCalibration();
        this.axisResult = r.ok
          ? `ось повёрнута на ${r.deviationDeg.toFixed(0)}° от «12 часов», ` +
            `скрутка ${r.sweepDeg.toFixed(0)}°, чистота ${(r.quality * 100).toFixed(0)}%`
          : `не принято: ${r.reason}`;
      } else {
        this.axisResult = '';
        actions.startForearmCalibration();
      }
    },
    flipAxis() {
      actions.flipForearmAxis();
      this.axisResult = 'ось развёрнута на 180°';
    },
    resetAxis() {
      actions.resetForearmAxis();
      this.axisResult = 'ось вернулась к «12 часов к кисти»';
    },
  },
};
</script>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 4px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 8px;
  font-size: 11.5px;
}

.cell__key {
  color: var(--muted);
  font-size: 10.5px;
}

.warn {
  color: var(--warn);
}

.buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.hint {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.35;
}

.subtitle {
  color: var(--muted);
  font-size: 11px;
  margin-top: 4px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.val {
  min-width: 52px;
  text-align: right;
  color: var(--muted);
}
</style>
