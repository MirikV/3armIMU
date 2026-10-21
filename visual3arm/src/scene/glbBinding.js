/**
 * Привязка шарниров модели к узлам загруженного GLB — чистая часть, без Babylon.
 *
 * Вынесено отдельно ровно по одной причине: это единственное место рига, где есть
 * что перепутать (имя узла, поза из файла, порядок умножения кватернионов), и оно
 * обязано проверяться тестами. Babylon в тестах не поднимешь, поэтому функции ниже
 * работают с «узлом» как с утиным типом: достаточно полей name/id и поворота.
 *
 * ── Поза из файла — нулевая ──
 * Художник почти никогда не ставит шарнир в нулевой поворот: узел уже подкручен так,
 * как деталь стоит в собранном роботе. Если записать в узел чистый поворот сустава,
 * эта подкрутка потеряется и модель развалится. Поэтому поворот из файла запоминается
 * как rest и угол сустава ДОМНОЖАЕТСЯ справа: q = rest ⊗ joint. Справа, а не слева,
 * потому что ось вращения (joint.axis) задана в ЛОКАЛЬНЫХ осях узла — тех, которые
 * уже повёрнуты rest'ом.
 */

import { quat, multiply } from '../core/math/quat.js';
import { quatFromEulerYXZ } from '../core/math/euler.js';

/**
 * Поворот узла «как в файле».
 *
 * glTF-загрузчик Babylon обычно проставляет rotationQuaternion, но узел, собранный
 * руками или пришедший из другого формата, может хранить углы Эйлера в .rotation —
 * и тогда молчаливая подстановка единичного кватерниона потеряла бы позу детали.
 *
 * @param {{rotationQuaternion?: {x,y,z,w}, rotation?: {x,y,z}}} node
 * @returns {{x,y,z,w}}
 */
export function restQuatOf(node) {
  const q = node?.rotationQuaternion;
  if (q && Number.isFinite(q.w)) return { x: q.x, y: q.y, z: q.z, w: q.w };
  const e = node?.rotation;
  if (e && (e.x || e.y || e.z)) return quatFromEulerYXZ({ pitch: e.x, yaw: e.y, roll: e.z });
  return quat();
}

/** Итоговый поворот узла: поза из файла, домноженная на угол сустава. */
export function jointNodeQuat(rest, jointQuat) {
  return multiply(rest, jointQuat);
}

/**
 * Найти узлы под шарниры. Ищем и по name, и по id: в GLB имя может быть
 * неуникальным, и загрузчик тогда переименовывает узел, сохраняя исходное в id.
 *
 * Ненайденный узел — не ошибка загрузки: модель может описывать только часть осей,
 * остальные просто не поедут. Имена возвращаем в missing, чтобы показать в панели.
 *
 * @param {Array<{name:string, nodeName?:string}>} joints
 * @param {Array<{name?:string, id?:string}>} nodes
 * @returns {{bound: Array<{name:string, nodeName:string, node:Object, rest:{x,y,z,w}}>,
 *            missing: string[]}}
 */
export function bindJointNodes(joints, nodes) {
  const bound = [];
  const missing = [];
  for (const j of joints) {
    const nodeName = j.nodeName;
    const node = nodeName ? nodes.find((n) => n?.name === nodeName || n?.id === nodeName) : null;
    if (!node) {
      missing.push(nodeName || j.name);
      continue;
    }
    bound.push({ name: j.name, nodeName, node, rest: restQuatOf(node) });
  }
  return { bound, missing };
}
