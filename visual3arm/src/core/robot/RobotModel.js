/**
 * Описание робота как последовательной цепи шарниров + прямая кинематика.
 *
 * Это ЗАДЕЛ под реальную модель: геометрия задаётся данными, а не кодом, поэтому
 * под свой манипулятор достаточно поменять массив joints (или подсунуть свой через
 * конструктор) и — если есть GLB — прописать nodeName для привязки к узлам модели.
 *
 * Соглашения те же, что у руки: длинная ось звена — локальный +Y, метры, радианы
 * внутри / градусы в UI.
 */

import { quat, multiply, normalize, fromAxisAngle, rotateVector, toRad, toDeg } from '../math/quat.js';

const AXES = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
};

/**
 * Дефолтный ТРЁХОСЕВОЙ манипулятор.
 * offset — сдвиг начала звена относительно конца предыдущего, метры.
 * limits — [min, max] в градусах.
 * nodeName — имя узла/кости в GLB, если модель загружена (иначе рисуются примитивы).
 *
 * ── Почему ровно три оси ──
 * Не «столько поместилось», а столько, сколько ЕСТЬ на входе. С часов приходит одна
 * ориентация, то есть ровно три наблюдаемые величины: азимут оси предплечья,
 * возвышение оси предплечья и скрутка кисти вокруг неё (core/math/aim.js). Три оси
 * робота принимают их один в один, без остатка:
 *   base      ← азимут      (поворот основания, ось Y)
 *   lift      ← возвышение  (наклон вверх-вниз сразу над основанием, ось X)
 *   wristRoll ← скрутка     (поворот головы, ось Y)
 * Четвёртая ось (был отдельный локоть) задавала бы вылет, а вылет с одного IMU не
 * наблюдается в принципе — перенос руки вперёд без смены ориентации даёт побитно тот
 * же пакет. Раньше её приходилось кормить настройкой-ползунком; теперь оси нет, и
 * управление стало честным: сколько наблюдаем, столько и двигаем.
 *
 * Важное следствие: ось wristRoll — это +Y, то есть ось самого звена. Поворот вокруг
 * неё звено не изгибает и на положение TCP не влияет вообще.
 *
 * ── Почему мачта длиннее стрелы и почему наклон ходит от 0° до 180° ──
 * Стрела должна повторять направление предплечья на ВСЁМ его диапазоне, включая
 * опущенную вдоль тела руку. Наклон отсчитывается от вертикали (0° — стрела вверх),
 * значит «стрела вниз» — это 180°, и лимит ±100° такую позу просто не пускал: рука
 * уходила вниз, а стрела застревала у горизонта. Отсюда диапазон [0, 180] — ровно
 * образ возвышения предплечья [+90°, −90°], ни градусом больше.
 *
 * Но угол без места в пространстве не поможет: стрела длиной 0.45 + голова 0.12 = 0.57
 * в позе «вниз» уходит на 0.57 м ниже своего шарнира, а шарнир сидит на вершине мачты.
 * При прежней мачте 0.10 м стрела вниз оказывалась в полуметре под полом — потому
 * прежний лимит 100° и ставился (при нём кончик стрелы ровно касался пола: 0.10 + 0.57
 * · cos 100° ≈ 0). Мачта 0.60 > 0.57 снимает ограничение честно: в самой нижней позе
 * кончик стоит на 0.60 − 0.57 = 0.03 м над полом, и ни одна достижимая поза сквозь пол
 * не проходит. Робот стоит на полу сцены (y = −0.9), см. RobotRig.
 */
export const DEFAULT_JOINTS = [
  { name: 'base',      label: 'Мачта (поворот)',      axis: 'y', length: 0.60, limits: [-180, 180], home: 0,  nodeName: 'joint_base' },
  { name: 'lift',      label: 'Наклон (вверх/вниз)',  axis: 'x', length: 0.45, limits: [0, 180],    home: 90, nodeName: 'joint_lift' },
  { name: 'wristRoll', label: 'Голова (вращение)',    axis: 'y', length: 0.12, limits: [-180, 180], home: 0,  nodeName: 'joint_wrist_roll' },
];

export class RobotModel {
  constructor(joints = DEFAULT_JOINTS) {
    this.joints = joints.map((j) => ({ offset: { x: 0, y: 0, z: 0 }, ...j }));
    this.angles = {};
    this.goHome();
  }

  goHome() {
    for (const j of this.joints) this.angles[j.name] = toRad(j.home ?? 0);
  }

  get names() {
    return this.joints.map((j) => j.name);
  }

  jointByName(name) {
    return this.joints.find((j) => j.name === name);
  }

  /** Длина звена по имени, метры. Нет такого шарнира — 0 (чтобы кинематика не падала). */
  linkLength(name) {
    return this.jointByName(name)?.length ?? 0;
  }

  /** Лимиты шарнира в радианах: [min, max]. */
  limitsRad(name) {
    const j = this.jointByName(name);
    return j ? [toRad(j.limits[0]), toRad(j.limits[1])] : [-Infinity, Infinity];
  }

  /** Угол в пределах лимитов, вход/выход — радианы. */
  clamp(name, angleRad) {
    const j = this.jointByName(name);
    if (!j) return angleRad;
    const [lo, hi] = j.limits;
    return Math.min(toRad(hi), Math.max(toRad(lo), angleRad));
  }

  /** @param {Record<string, number>} anglesRad частичная карта углов, радианы */
  setAngles(anglesRad) {
    for (const [name, value] of Object.entries(anglesRad)) {
      if (!Number.isFinite(value)) continue;
      if (this.angles[name] === undefined) continue;
      this.angles[name] = this.clamp(name, value);
    }
    return this.angles;
  }

  setAngleDeg(name, deg) {
    return this.setAngles({ [name]: toRad(deg) });
  }

  getAnglesDeg() {
    const out = {};
    for (const [k, v] of Object.entries(this.angles)) out[k] = toDeg(v);
    return out;
  }

  /** Локальные повороты шарниров — то, что применяется к узлам сцены. */
  localRotations() {
    return this.joints.map((j) => ({
      name: j.name,
      quat: fromAxisAngle(AXES[j.axis], this.angles[j.name] || 0),
    }));
  }

  /**
   * Прямая кинематика: мировые позиции начала/конца каждого звена и TCP.
   * @returns {{links: Array<{name:string, start:{x,y,z}, end:{x,y,z}, world:{x,y,z,w}}>, tcp:{x,y,z}}}
   */
  forward() {
    let q = quat();
    let p = { x: 0, y: 0, z: 0 };
    const links = [];
    for (const j of this.joints) {
      q = normalize(multiply(q, fromAxisAngle(AXES[j.axis], this.angles[j.name] || 0)));
      const off = rotateVector(q, j.offset);
      const start = { x: p.x + off.x, y: p.y + off.y, z: p.z + off.z };
      const dir = rotateVector(q, AXES.y);
      const end = {
        x: start.x + dir.x * j.length,
        y: start.y + dir.y * j.length,
        z: start.z + dir.z * j.length,
      };
      links.push({ name: j.name, start, end, world: q });
      p = end;
    }
    return { links, tcp: p };
  }
}
