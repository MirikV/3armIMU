/**
 * Углы Эйлера в соглашении Babylon (порядок YXZ: рыскание вокруг Y,
 * тангаж вокруг X, крен вокруг Z). Повторяет Quaternion.toEulerAngles(),
 * чтобы цифры на панели совпадали с тем, что показывает инспектор Babylon.
 */

import { normalize, multiply, fromAxisAngle } from './quat.js';

const AX_X = { x: 1, y: 0, z: 0 };
const AX_Y = { x: 0, y: 1, z: 0 };
const AX_Z = { x: 0, y: 0, z: 1 };

/** @returns {{yaw:number, pitch:number, roll:number}} радианы */
export function eulerYXZ(q) {
  const { x: qx, y: qy, z: qz, w: qw } = normalize(q);
  const zAxisY = qy * qz - qx * qw;
  const limit = 0.4999999;
  if (zAxisY < -limit) {
    return { yaw: 2 * Math.atan2(qy, qw), pitch: Math.PI / 2, roll: 0 };
  }
  if (zAxisY > limit) {
    return { yaw: 2 * Math.atan2(qy, qw), pitch: -Math.PI / 2, roll: 0 };
  }
  const sqx = qx * qx;
  const sqy = qy * qy;
  const sqz = qz * qz;
  const sqw = qw * qw;
  return {
    roll: Math.atan2(2 * (qx * qy + qz * qw), -sqz - sqx + sqy + sqw),
    pitch: Math.asin(-2 * zAxisY),
    yaw: Math.atan2(2 * (qz * qx + qy * qw), sqz - sqx - sqy + sqw),
  };
}

/** Обратное преобразование: YXZ → кватернион. */
export function quatFromEulerYXZ({ yaw = 0, pitch = 0, roll = 0 }) {
  return normalize(
    multiply(
      multiply(fromAxisAngle(AX_Y, yaw), fromAxisAngle(AX_X, pitch)),
      fromAxisAngle(AX_Z, roll),
    ),
  );
}
