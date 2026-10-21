/**
 * Привязка шарниров к узлам GLB.
 *
 * Babylon в node не поднимается, поэтому проверяемая часть вынесена в чистый модуль
 * scene/glbBinding.js, а «узел» здесь — простой объект с именем и поворотом. Тест
 * фиксирует ровно те три вещи, которые в этом месте ломаются молча: поиск узла,
 * сохранение позы из файла и порядок умножения кватернионов.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bindJointNodes, jointNodeQuat, restQuatOf } from '../src/scene/glbBinding.js';
import { quat, fromAxisAngle, rotateVector, angleBetween, toRad } from '../src/core/math/quat.js';
import { quatFromEulerYXZ } from '../src/core/math/euler.js';
import { DEFAULT_JOINTS, RobotModel } from '../src/core/robot/RobotModel.js';

const AX_X = { x: 1, y: 0, z: 0 };
const AX_Y = { x: 0, y: 1, z: 0 };
const AX_Z = { x: 0, y: 0, z: 1 };

function nodesFor(joints, extra = {}) {
  return joints.map((j) => ({ name: j.nodeName, rotationQuaternion: quat(), ...extra }));
}

test('GLB: узлы находятся и по name, и по id, а ненайденные попадают в missing', () => {
  const joints = [
    { name: 'base', nodeName: 'joint_base' },
    { name: 'lift', nodeName: 'joint_lift' },
    { name: 'wristRoll', nodeName: 'joint_wrist_roll' },
  ];
  const nodes = [
    { name: 'joint_base', rotationQuaternion: quat() },
    // Загрузчик переименовал узел при конфликте имён, исходное осталось в id.
    { name: 'joint_lift.001', id: 'joint_lift', rotationQuaternion: quat() },
    { name: 'что-то постороннее' },
  ];
  const { bound, missing } = bindJointNodes(joints, nodes);
  assert.deepEqual(
    bound.map((b) => b.name),
    ['base', 'lift'],
  );
  assert.deepEqual(missing, ['joint_wrist_roll']);
});

test('GLB: имена узлов из RobotModel находятся в модели с такими же именами', () => {
  const model = new RobotModel();
  const { bound, missing } = bindJointNodes(model.joints, nodesFor(DEFAULT_JOINTS));
  assert.equal(missing.length, 0);
  assert.equal(bound.length, model.joints.length);
});

test('GLB: поза узла из файла не теряется, даже если она задана углами Эйлера', () => {
  const euler = { x: toRad(12), y: toRad(-40), z: toRad(5) };
  const rest = restQuatOf({ name: 'joint_lift', rotation: euler });
  const expected = quatFromEulerYXZ({ pitch: euler.x, yaw: euler.y, roll: euler.z });
  assert.ok(angleBetween(rest, expected) < 1e-7);

  // Кватернион, если он есть, главнее: два источника поворота на узле противоречивы.
  const both = restQuatOf({ rotationQuaternion: fromAxisAngle(AX_Z, toRad(90)), rotation: euler });
  assert.ok(angleBetween(both, fromAxisAngle(AX_Z, toRad(90))) < 1e-7);

  // Узел без поворота вообще — честная единица, а не NaN.
  assert.ok(angleBetween(restQuatOf({}), quat()) < 1e-7);
});

test('GLB: нулевой угол сустава оставляет узел ровно в позе файла', () => {
  const rest = quatFromEulerYXZ({ yaw: toRad(33), pitch: toRad(-14), roll: toRad(7) });
  const q = jointNodeQuat(rest, fromAxisAngle(AX_Y, 0));
  // Допуск не 1e-12: acos у единичного скалярного произведения сам по себе теряет
  // половину значащих цифр, и 1e-7 радиана — это уже предел метода, а не расхождение.
  assert.ok(angleBetween(q, rest) < 1e-7, 'поза детали в сборке не должна сбиваться');
});

test('GLB: угол сустава крутит узел вокруг ЛОКАЛЬНОЙ оси, а не мировой', () => {
  // Деталь в файле положена набок: её локальный +Y смотрит по мировому +Z.
  const rest = fromAxisAngle(AX_X, toRad(90));
  const jointQ = fromAxisAngle(AX_Y, toRad(90)); // ось шарнира — локальный +Y
  const q = jointNodeQuat(rest, jointQ);

  // Поворот вокруг оси самой детали не должен уводить саму ось: локальный +Y как
  // смотрел по мировому +Z, так и смотрит.
  const axisWorld = rotateVector(q, AX_Y);
  const restAxisWorld = rotateVector(rest, AX_Y);
  assert.ok(
    Math.hypot(
      axisWorld.x - restAxisWorld.x,
      axisWorld.y - restAxisWorld.y,
      axisWorld.z - restAxisWorld.z,
    ) < 1e-9,
    'ось шарнира обязана остаться на месте',
  );

  // Негативный контроль: перепутанный порядок (joint ⊗ rest) крутит вокруг МИРОВОЙ
  // оси и ось детали уводит — ровно та ошибка, ради которой тест и написан.
  const wrong = jointNodeQuat(jointQ, rest);
  const wrongAxis = rotateVector(wrong, AX_Y);
  assert.ok(
    Math.hypot(
      wrongAxis.x - restAxisWorld.x,
      wrongAxis.y - restAxisWorld.y,
      wrongAxis.z - restAxisWorld.z,
    ) > 0.5,
    'обратный порядок обязан давать другой результат, иначе тест бессодержателен',
  );
});

test('GLB: шарнир без nodeName считается ненайденным, а не падает', () => {
  const { bound, missing } = bindJointNodes([{ name: 'base' }], [{ name: 'joint_base' }]);
  assert.equal(bound.length, 0);
  assert.deepEqual(missing, ['base']);
});
