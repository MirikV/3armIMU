/**
 * Примитивы сцены. Всё звенья строятся по одному правилу:
 * узел-пивот в начале звена, геометрия вытянута вдоль локального +Y.
 */

import {
  CreateBox,
  CreateCylinder,
  CreateLines,
  CreateSphere,
  Color3,
  Quaternion,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { PALETTE } from './materials.js';

/**
 * Звено: пивот в начале, «мясо» от 0 до length по +Y.
 * @returns {{pivot: TransformNode, mesh: import('@babylonjs/core').Mesh}}
 */
export function createLink(scene, name, { length, radius = 0.035, color, material, shape = 'capsule' }) {
  const pivot = new TransformNode(`${name}_pivot`, scene);
  pivot.rotationQuaternion = Quaternion.Identity();

  const mesh =
    shape === 'box'
      ? CreateBox(`${name}_mesh`, { width: radius * 2, height: length, depth: radius * 2 }, scene)
      : CreateCylinder(
          `${name}_mesh`,
          { height: length, diameterTop: radius * 1.6, diameterBottom: radius * 2, tessellation: 20 },
          scene,
        );
  mesh.parent = pivot;
  mesh.position.y = length / 2;
  mesh.material = material(name, color);
  return { pivot, mesh };
}

/** Шарик-сустав в точке пивота. */
export function createJoint(scene, name, { radius = 0.045, color = PALETTE.joint, material }) {
  const mesh = CreateSphere(`${name}_joint`, { diameter: radius * 2, segments: 16 }, scene);
  mesh.material = material(`${name}_joint`, color);
  return mesh;
}

/**
 * Тройка осей: X — красная, Y — зелёная, Z — синяя.
 * Нужна постоянно: без неё непонятно, куда «смотрит» устройство.
 */
export function createAxisGizmo(scene, name, size = 0.2, material) {
  const root = new TransformNode(`${name}_axes`, scene);
  root.rotationQuaternion = Quaternion.Identity();

  const axes = [
    { dir: new Vector3(size, 0, 0), color: Color3.FromHexString(PALETTE.axisX) },
    { dir: new Vector3(0, size, 0), color: Color3.FromHexString(PALETTE.axisY) },
    { dir: new Vector3(0, 0, size), color: Color3.FromHexString(PALETTE.axisZ) },
  ];
  for (const [i, a] of axes.entries()) {
    const line = CreateLines(`${name}_axis_${i}`, { points: [Vector3.Zero(), a.dir] }, scene);
    line.color = a.color;
    line.parent = root;
    line.isPickable = false;
    const tip = CreateSphere(`${name}_tip_${i}`, { diameter: size * 0.12 }, scene);
    tip.position = a.dir;
    tip.parent = root;
    tip.isPickable = false;
    if (material) tip.material = material(`${name}_tip_${i}`, a.color.toHexString(), { unlit: true });
  }
  return root;
}

/** Модель часов: корпус + «экран» + ремешок. Локальные оси — как у устройства Android. */
export function createWatch(scene, name, material) {
  const root = new TransformNode(`${name}_watch`, scene);
  root.rotationQuaternion = Quaternion.Identity();

  const body = CreateBox(`${name}_body`, { width: 0.044, height: 0.048, depth: 0.013 }, scene);
  body.material = material(`${name}_body`, PALETTE.watch);
  body.parent = root;

  // Экран смотрит «из устройства», в левой тройке Babylon это -Z.
  const screen = CreateBox(`${name}_screen`, { width: 0.034, height: 0.038, depth: 0.002 }, scene);
  screen.position.z = -0.0075;
  screen.material = material(`${name}_screen`, PALETTE.watchScreen, { emissive: 0.5 });
  screen.parent = root;

  // Метка «12 часов» — чтобы видеть, где верх циферблата (локальный +Y).
  const noon = CreateBox(`${name}_noon`, { width: 0.008, height: 0.006, depth: 0.001 }, scene);
  noon.position.set(0, 0.014, -0.009);
  noon.material = material(`${name}_noon`, PALETTE.axisY, { emissive: 0.8 });
  noon.parent = root;

  const strap = CreateCylinder(
    `${name}_strap`,
    { height: 0.02, diameter: 0.058, tessellation: 24 },
    scene,
  );
  strap.rotation.x = Math.PI / 2;
  strap.material = material(`${name}_strap`, '#2a2f3a');
  strap.parent = root;

  return root;
}
