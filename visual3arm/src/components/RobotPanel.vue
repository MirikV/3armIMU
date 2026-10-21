<template>
  <ui-section title="Робот" :note="settings.robot.enabled ? settings.robot.strategy : 'выключен'">
    <ui-row label="Показывать">
      <input type="checkbox" v-model="settings.robot.enabled" @change="actions.saveSettings()" />
    </ui-row>
    <ui-row label="Следовать за рукой" hint="Выключите, чтобы крутить моторы руками">
      <input type="checkbox" v-model="settings.robot.follow" @change="actions.saveSettings()" />
    </ui-row>
    <ui-row label="Стратегия" hint="Правило пересчёта прицела руки в углы моторов">
      <select v-model="settings.robot.strategy" @change="actions.saveSettings()">
        <option v-for="s in strategies" :key="s" :value="s">{{ strategyLabel(s) }}</option>
      </select>
    </ui-row>

    <div class="subtitle">Прицел предплечья</div>
    <div class="note">
      Три числа, которые вообще наблюдаются с одного датчика на запястье. Каждое идёт
      на свой мотор — оси развязаны по построению.
    </div>
    <div class="grid mono">
      <div><span class="k">азимут</span> {{ telemetry.aimDeg.azimuth }}° → основание</div>
      <div><span class="k">возвышение</span> {{ telemetry.aimDeg.elevation }}° → наклон</div>
      <div><span class="k">скрутка</span> {{ telemetry.aimDeg.twist }}° → голова</div>
    </div>
    <div v-if="telemetry.azimuthHeld" class="note note--warn">
      Предплечье почти вертикально: азимут вырожден и удерживается, основание за рукой
      сейчас не идёт. Это геометрия, а не сбой — опустите руку.
    </div>
    <div v-if="telemetry.aimDegenerate" class="note note--warn">
      Скрутка не определена: поворот на 180° поперёк оси предплечья.
    </div>

    <template v-if="settings.robot.strategy === 'direct'">
      <div class="subtitle">Рабочее окно стрелы</div>
      <div class="note">
        Стрела повторяет направление предплечья один в один: рука вперёд — стрела
        вперёд, рука вверх — стрела вверх, рука вниз — стрела вниз. Ползунки только
        подрезают края хода; внутри окна отображение от них не зависит.
        Возвышение считается от позы, на которой взят ноль, — берите его с рукой,
        вытянутой горизонтально вперёд.
      </div>
      <ui-row
        v-for="f in directFields"
        :key="f.key"
        :label="f.label"
        :hint="f.hint"
      >
        <input
          type="range"
          :min="f.min"
          :max="f.max"
          step="1"
          v-model.number="settings.robot.direct[f.key]"
          @change="actions.saveSettings()"
        />
        <span class="val mono">{{ settings.robot.direct[f.key] }}°</span>
      </ui-row>
    </template>

    <div class="subtitle">Углы моторов</div>
    <ui-row v-for="j in joints" :key="j.name" :label="j.label">
      <input
        type="range"
        :min="j.limits[0]"
        :max="j.limits[1]"
        step="0.5"
        :disabled="settings.robot.follow"
        :value="angleOf(j.name)"
        @input="onSlider(j.name, $event)"
      />
      <span class="val mono">{{ angleOf(j.name) }}°</span>
      <span v-if="settings.robot.follow" class="val mono dim">
        → {{ targetOf(j.name) }}°
      </span>
    </ui-row>

    <div class="buttons">
      <button @click="actions.robotHome()" :disabled="settings.robot.follow">В домашнюю позу</button>
    </div>

    <div class="subtitle">Реализм приводов</div>
    <ui-row label="Ограничивать" hint="Цель мгновенная, фактические углы догоняют — как у шаговиков">
      <input type="checkbox" v-model="settings.robot.limiter" @change="actions.applyRobot()" />
    </ui-row>
    <template v-if="settings.robot.limiter">
      <ui-row
        v-for="j in joints"
        :key="'lim' + j.name"
        :label="j.label"
        hint="Максимальные скорость (°/с) и ускорение (°/с²)"
      >
        <input
          class="num"
          type="number"
          min="1"
          max="2000"
          step="5"
          v-model.number="settings.robot.jointLimits[j.name].maxSpeedDeg"
          @change="actions.applyRobot()"
        />
        <input
          class="num"
          type="number"
          min="1"
          max="20000"
          step="10"
          v-model.number="settings.robot.jointLimits[j.name].maxAccelDeg"
          @change="actions.applyRobot()"
        />
        <span class="val mono dim">{{ speedOf(j.name) }}°/с</span>
      </ui-row>
    </template>

    <div class="subtitle">Коэффициенты передачи</div>
    <ui-row v-for="j in joints" :key="'g' + j.name" :label="j.label">
      <input
        type="range"
        min="-2"
        max="2"
        step="0.05"
        v-model.number="settings.robot.gain[j.name]"
        @change="actions.saveSettings()"
      />
      <span class="val mono">{{ Number(settings.robot.gain[j.name]).toFixed(2) }}</span>
    </ui-row>
    <div class="note">
      Отрицательный коэффициент переворачивает ось: полезно, если мотор в железе
      крутится в другую сторону. У наклона коэффициент умножает отклонение от
      горизонта, поэтому поза «рука вперёд — стрела вперёд» сохраняется при любом его
      значении.
    </div>

    <div class="subtitle">3D-модель</div>
    <ui-row label="GLB/GLTF" hint="Положите файл в public/models и укажите путь">
      <input v-model.trim="glbUrl" placeholder="/models/robot.glb" @change="applyGlb" />
    </ui-row>
    <div class="buttons">
      <button @click="applyGlb">Загрузить</button>
      <button class="danger" @click="clearGlb">Убрать</button>
    </div>
    <div v-if="telemetry.glbStatus" class="note mono">{{ telemetry.glbStatus }}</div>
    <div class="note">
      Ожидаемые имена узлов в модели:
      <code>{{ joints.map((j) => j.nodeName).join(', ') }}</code>.
      Ось вращения каждого шарнира задаётся в <code>RobotModel.js</code>, поза узла из
      файла считается нулевой и домножается на угол сустава.
      Поле пустое — робот рисуется примитивами; это штатный режим, а не ошибка.
    </div>

    <div class="grid mono">
      <div><span class="k">TCP</span> {{ fmtV(telemetry.robotTcp) }}</div>
      <div v-for="j in joints" :key="'u' + j.name">
        <span class="k">{{ j.label }}</span> использовано хода: {{ usageOf(j.name) }}%
      </div>
    </div>
    <div class="buttons">
      <button @click="actions.resetTravel()">Сбросить счётчик хода</button>
    </div>
  </ui-section>
</template>

<script>
import UiSection from './ui/Section.vue';
import UiRow from './ui/Row.vue';
import { settings, telemetry, actions, robotModel } from '../store/index.js';
import { ROBOT_STRATEGIES } from '../core/robot/armToRobot.js';

/** Человеческие названия стратегий. Список берём из реестра, а не дублируем руками. */
const STRATEGY_LABELS = {
  direct: 'прямое (азимут / возвышение / скрутка)',
};

/** Ползунки стратегии 'direct'. Всё в градусах — это граница UI. */
const DIRECT_FIELDS = [
  { key: 'liftTopDeg', label: 'Стрела: верхний упор', min: 0, max: 90, hint: 'Наклон от вертикали: 0° — стрела строго вверх (рука поднята)' },
  { key: 'liftBottomDeg', label: 'Стрела: нижний упор', min: 90, max: 180, hint: '90° — горизонтально вперёд, 180° — строго вниз (рука опущена)' },
  {
    key: 'azimuthHoldDeg',
    label: 'Порог удержания',
    min: 40,
    max: 89,
    hint: 'Выше этого возвышения азимут вырожден и основание придерживается',
  },
];

export default {
  name: 'RobotPanel',
  components: { UiSection, UiRow },
  data() {
    return {
      settings,
      telemetry,
      actions,
      joints: robotModel.joints,
      strategies: ROBOT_STRATEGIES,
      directFields: DIRECT_FIELDS,
      glbUrl: settings.robot.glbUrl,
      manual: robotModel.getAnglesDeg(),
    };
  },
  methods: {
    strategyLabel(name) {
      return STRATEGY_LABELS[name] || name;
    },
    usageOf(name) {
      const v = this.telemetry.robotUsage[name];
      return Number.isFinite(v) ? v : 0;
    },
    angleOf(name) {
      const deg = this.settings.robot.follow
        ? this.telemetry.robotAnglesDeg[name]
        : this.manual[name];
      return Number.isFinite(deg) ? +Number(deg).toFixed(1) : 0;
    },
    /** Куда мотор ЦЕЛИТСЯ. Отличие от фактического угла — и есть отставание привода. */
    targetOf(name) {
      const deg = this.telemetry.robotTargetDeg[name];
      return Number.isFinite(deg) ? +Number(deg).toFixed(1) : 0;
    },
    speedOf(name) {
      const v = this.telemetry.robotSpeedsDeg[name];
      return Number.isFinite(v) ? +Number(v).toFixed(0) : 0;
    },
    onSlider(name, event) {
      const deg = Number(event.target.value);
      this.$set(this.manual, name, deg);
      actions.setRobotAngleDeg(name, deg);
    },
    applyGlb() {
      this.settings.robot.glbUrl = this.glbUrl;
      actions.saveSettings();
    },
    clearGlb() {
      this.glbUrl = '';
      this.settings.robot.glbUrl = '';
      actions.saveSettings();
    },
    fmtV(v) {
      return `${v.x} ${v.y} ${v.z}`;
    },
  },
};
</script>

<style scoped>
.subtitle {
  color: var(--muted);
  font-size: 11px;
  margin-top: 4px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.buttons {
  display: flex;
  gap: 8px;
}

.val {
  min-width: 52px;
  text-align: right;
  color: var(--muted);
}

.note {
  color: var(--muted);
  font-size: 11px;
  word-break: break-word;
}

.note--warn {
  color: var(--warn);
}

.dim {
  opacity: 0.55;
}

.num {
  width: 58px;
}

.grid {
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 8px;
  font-size: 11.5px;
}

.k {
  color: var(--muted);
  display: inline-block;
  min-width: 60px;
}
</style>
