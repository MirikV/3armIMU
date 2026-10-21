import { Color3, StandardMaterial } from '@babylonjs/core';

/** Кэш материалов: одна сцена — один материал на цвет. */
export function makeMaterialFactory(scene) {
  const cache = new Map();
  return function material(name, hex, options = {}) {
    const key = `${name}:${hex}:${JSON.stringify(options)}`;
    if (cache.has(key)) return cache.get(key);
    const m = new StandardMaterial(key, scene);
    const c = Color3.FromHexString(hex);
    m.diffuseColor = c;
    m.specularColor = new Color3(0.12, 0.12, 0.14);
    m.emissiveColor = c.scale(options.emissive ?? 0.18);
    if (options.alpha !== undefined) m.alpha = options.alpha;
    if (options.wireframe) m.wireframe = true;
    if (options.unlit) m.disableLighting = true;
    cache.set(key, m);
    return m;
  };
}

export const PALETTE = {
  upperArm: '#4f7cff',
  forearm: '#3fb6d8',
  hand: '#7fd0a8',
  watch: '#f2b134',
  watchScreen: '#20242e',
  joint: '#e8eaf0',
  robotBase: '#8a8f9c',
  robotLink: '#c96a5a',
  robotJoint: '#f0f2f6',
  ghost: '#5a6272',
  axisX: '#ff4d4d',
  axisY: '#4dff88',
  axisZ: '#4d8cff',
};
