/**
 * Запись сырых пакетов и её воспроизведение — диагностический инструмент.
 *
 * Зачем: синтетика из MockSource показывает, что конвейер работает, но не показывает,
 * что делает РУКА конкретного человека. Дрожание, паузы, паразитный увод оси при
 * скрутке кисти, реальная частота пакетов — всё это видно только на записи с часов.
 *
 * ── Формат: построчный JSON (NDJSON) ──
 *   {"t":0.000,"topic":"robot/watch/rotation","payload":"{\"q\":[0.1,0,0,0.99]}"}
 *   {"t":0.021,"topic":"robot/watch/rotation","payload":"..."}
 *
 * Одна строка — один пакет, ровно в том виде, в каком он пришёл с брокера (payload
 * хранится СТРОКОЙ, не разобранным объектом: запись должна пережить любые будущие
 * правки парсера и оставаться воспроизводимой). `t` — секунды от начала записи.
 *
 * Построчность выбрана намеренно: такой файл читается обычным node-скриптом в три
 * строки (`readFileSync().split('\n').map(JSON.parse)`), его можно резать `head`,
 * и он не ломается целиком от одной битой строки — в отличие от одного большого JSON.
 */

/** Расширение файла записи. */
export const RECORDING_EXT = '.ndjson';

/**
 * Сериализовать записи в текст NDJSON.
 * @param {Array<{t:number, topic:string, payload:string}>} entries
 */
export function serializeRecording(entries) {
  return entries
    .map((e) =>
      JSON.stringify({
        t: +Number(e.t || 0).toFixed(4),
        topic: e.topic || '',
        payload: typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload),
      }),
    )
    .join('\n');
}

/**
 * Разобрать текст NDJSON обратно в записи.
 *
 * Терпимость намеренная, как и у parsers.js: запись могли обрезать на середине строки,
 * склеить из двух кусков или отредактировать руками. Битые строки пропускаем и честно
 * считаем, а не роняем весь файл.
 *
 * Отсутствующий `t` — не ошибка: строку кладём сразу за предыдущей с шагом 20 мс
 * (50 Гц, типичная частота часов), иначе весь хвост записи схлопнулся бы в нулевое время.
 *
 * @param {string} text
 * @returns {{entries: Array<{t:number, topic:string, payload:string}>, skipped: number}}
 */
export function parseRecording(text) {
  const entries = [];
  let skipped = 0;
  let t = 0;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const payload =
      typeof obj?.payload === 'string'
        ? obj.payload
        : obj?.payload !== undefined
          ? JSON.stringify(obj.payload)
          : null;
    if (payload === null) {
      skipped += 1;
      continue;
    }
    t = Number.isFinite(Number(obj.t)) ? Number(obj.t) : t + 0.02;
    entries.push({ t, topic: String(obj.topic ?? ''), payload });
  }

  // Время обязано идти вперёд: иначе воспроизведение встанет или выстрелит очередью.
  entries.sort((a, b) => a.t - b.t);
  return { entries, skipped };
}

/** Длительность записи в секундах (0 для пустой). */
export function recordingDuration(entries) {
  if (!entries || entries.length < 2) return 0;
  return entries[entries.length - 1].t - entries[0].t;
}
