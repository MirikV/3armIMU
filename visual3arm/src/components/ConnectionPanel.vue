<template>
  <ui-section title="Источник данных" :note="telemetry.connection.state">
    <ui-row label="Источник" hint="Симулятор нужен, чтобы проверять сцену без часов">
      <select v-model="settings.source">
        <option value="mqtt">MQTT (часы)</option>
        <option value="mock">Симулятор</option>
        <option value="replay">Запись (файл)</option>
      </select>
    </ui-row>

    <template v-if="settings.source === 'mqtt'">
      <ui-row label="URL брокера" hint="Из браузера только WebSocket: ws:// или wss://">
        <input v-model.trim="settings.url" placeholder="ws://192.168.1.10:9001" />
      </ui-row>
      <ui-row label="Топик">
        <input v-model.trim="settings.topic" placeholder="robot/watch/rotation" />
      </ui-row>
      <ui-row label="Логин">
        <input v-model.trim="settings.username" autocomplete="off" />
      </ui-row>
      <ui-row label="Пароль">
        <input v-model="settings.password" type="password" autocomplete="off" />
      </ui-row>
      <ui-row label="QoS">
        <select v-model.number="settings.qos">
          <option :value="0">0</option>
          <option :value="1">1</option>
          <option :value="2">2</option>
        </select>
      </ui-row>
    </template>

    <!-- Разбор пакета одинаков для живого потока и для записи: запись хранит сырой
         текст, поэтому те же формат, путь и единицы углов нужны и ей. -->
    <template v-if="settings.source !== 'mock'">
      <ui-row label="Формат" hint="auto разбирает и JSON, и CSV">
        <select v-model="settings.format">
          <option value="auto">авто</option>
          <option value="json">JSON</option>
          <option value="csv">числа через запятую</option>
        </select>
      </ui-row>
      <ui-row label="Путь в JSON" hint="Например data.sensor — если кватернион лежит глубоко">
        <input v-model.trim="settings.path" placeholder="(пусто = искать самому)" />
      </ui-row>
      <ui-row label="Единицы углов" :hint="angleUnitHint">
        <select v-model="settings.angleUnit" @change="actions.saveSettings()">
          <option value="auto">авто</option>
          <option value="deg">градусы</option>
          <option value="rad">радианы</option>
        </select>
      </ui-row>
    </template>

    <template v-if="settings.source === 'replay'">
      <ui-row label="Файл записи" hint="NDJSON, записанный кнопкой ниже">
        <input type="file" accept=".ndjson,.jsonl,.txt,application/json" @change="onReplayFile" />
      </ui-row>
      <div v-if="telemetry.replay.packets" class="hint mono">
        {{ telemetry.replay.name }}: {{ telemetry.replay.packets }} пакетов,
        {{ telemetry.replay.seconds }} с
        <span v-if="telemetry.replay.skipped">, битых строк: {{ telemetry.replay.skipped }}</span>
      </div>
      <ui-row label="Скорость" hint="Применяется на лету, позиция не сбрасывается">
        <input
          type="range"
          min="0.1"
          max="4"
          step="0.1"
          v-model.number="settings.replay.speed"
          @input="actions.applyReplaySpeed(false)"
          @change="actions.applyReplaySpeed()"
        />
        <span class="val mono">×{{ Number(settings.replay.speed).toFixed(1) }}</span>
      </ui-row>
      <ui-row label="Зациклить">
        <input
          type="checkbox"
          v-model="settings.replay.loop"
          @change="actions.applyReplayLoop()"
        />
      </ui-row>
      <ui-row label="Позиция" hint="Перемотка — скачок состояния, пропущенные пакеты не досылаются">
        <input
          type="range"
          min="0"
          :max="telemetry.replay.seconds || 0"
          step="0.05"
          :value="seekValue"
          :disabled="!telemetry.replay.packets"
          @input="onSeekInput"
          @change="onSeekCommit"
        />
        <span class="val mono">
          {{ seekValue.toFixed(1) }} / {{ telemetry.replay.seconds }} с
        </span>
      </ui-row>
      <div class="buttons">
        <button :disabled="!telemetry.replay.playing" @click="actions.toggleReplayPause()">
          {{ telemetry.replay.paused ? 'Продолжить' : 'Пауза' }}
        </button>
        <button :disabled="!telemetry.replay.packets" @click="actions.restartReplay()">
          С начала
        </button>
      </div>
    </template>

    <ui-row label="Автоподключение">
      <input type="checkbox" v-model="settings.autoConnect" @change="actions.saveSettings()" />
    </ui-row>

    <div class="buttons">
      <button class="primary" @click="actions.connect()">Подключить</button>
      <button @click="actions.disconnect()">Отключить</button>
    </div>

    <div class="subtitle">Запись потока</div>
    <div class="hint">
      Пишутся сырые пакеты, как пришли. Файл потом открывается источником «Запись» —
      и кинематику можно крутить на реальном движении руки, без часов.
    </div>
    <div class="buttons">
      <button v-if="!telemetry.recording.active" @click="actions.startRecording()">
        Начать запись
      </button>
      <button v-else class="danger" @click="actions.stopRecording()">Остановить</button>
      <button :disabled="!telemetry.recording.packets" @click="downloadRecording">
        Скачать
      </button>
      <button :disabled="!telemetry.recording.packets" @click="actions.clearRecording()">
        Очистить
      </button>
    </div>
    <div v-if="telemetry.recording.packets" class="hint mono">
      записано: {{ telemetry.recording.packets }} пакетов, {{ telemetry.recording.seconds }} с
    </div>
    <div v-if="telemetry.recording.dropped" class="hint hint--warn">
      Достигнут потолок записи — дальнейшие пакеты не сохраняются.
    </div>

    <div v-if="telemetry.connection.detail" class="hint mono">{{ telemetry.connection.detail }}</div>
    <div v-if="telemetry.parseErrors" class="hint hint--warn mono">
      не разобрано пакетов: {{ telemetry.parseErrors }}
    </div>
    <ul v-if="telemetry.errors.length" class="errors mono">
      <li v-for="(e, i) in telemetry.errors" :key="i">{{ e }}</li>
    </ul>
  </ui-section>
</template>

<script>
import UiSection from './ui/Section.vue';
import UiRow from './ui/Row.vue';
import { settings, telemetry, actions } from '../store/index.js';
import { RECORDING_EXT } from '../core/mqtt/recording.js';

/** Имя файла записи: дата и время, чтобы записи не затирали друг друга в «Загрузках». */
function recordingFileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `visual3arm-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${RECORDING_EXT}`
  );
}

export default {
  name: 'ConnectionPanel',
  components: { UiSection, UiRow },
  data() {
    // seeking — позиция, которую сейчас тянет пользователь. Пока она не null, ползунок
    // показывает её, а не витрину: иначе обновление телеметрии раз в 80 мс перебивало
    // бы захваченную мышью ручку, и та дёргалась бы под пальцем.
    return { settings, telemetry, actions, seeking: null };
  },
  computed: {
    seekValue() {
      return this.seeking === null ? this.telemetry.replay.position : this.seeking;
    },
    /**
     * «Авто» не может отличить градусы от радиан, когда часы стоят почти в нуле,
     * поэтому показываем, что распознали на самом деле — иначе перепутанные единицы
     * выглядят просто как «руку колбасит».
     */
    angleUnitHint() {
      const base = 'Для пакетов azimuth/pitch/roll; кватернионов не касается';
      if (this.settings.angleUnit !== 'auto') return base;
      if (!this.telemetry.angleUnit) return `${base}. Пока углов не приходило`;
      return `${base}. Сейчас распознано: ${this.telemetry.angleUnit === 'deg' ? 'градусы' : 'радианы'}`;
    },
  },
  methods: {
    /**
     * Сохранение файла. Blob, а не data:-ссылка: минутная запись — это мегабайты, и
     * в data:URL она упирается в ограничение длины адреса у части браузеров.
     */
    downloadRecording() {
      const blob = new Blob([actions.recordingText()], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = recordingFileName();
      a.click();
      // Отзываем не сразу: клик по ссылке только НАЧИНАЕТ скачивание.
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },

    onSeekInput(event) {
      this.seeking = Number(event.target.value);
      actions.seekReplay(this.seeking);
    },

    onSeekCommit(event) {
      actions.seekReplay(Number(event.target.value));
      this.seeking = null;
    },

    async onReplayFile(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        actions.loadReplay(file.name, await file.text());
      } catch (err) {
        actions.pushError(`Не прочитался файл записи: ${err.message}`);
      }
    },
  },
};
</script>

<style scoped>
.buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.subtitle {
  color: var(--muted);
  font-size: 11px;
  margin-top: 4px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.val {
  min-width: 62px;
  text-align: right;
  color: var(--muted);
}

.hint {
  color: var(--muted);
  font-size: 11px;
  word-break: break-all;
}

.hint--warn {
  color: var(--warn);
}

.errors {
  margin: 0;
  padding-left: 16px;
  color: var(--err);
  font-size: 11px;
}
</style>
