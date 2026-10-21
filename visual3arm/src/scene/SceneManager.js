/**
 * Обвязка Babylon: движок, сцена, камера, свет, пол, оси мира.
 * Ничего не знает ни про MQTT, ни про руку — только про рендер.
 */

import {
  ArcRotateCamera,
  Color3,
  Color4,
  CreateGround,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Scene,
  ShadowGenerator,
  Vector3,
} from '@babylonjs/core';
import { GridMaterial } from '@babylonjs/materials/grid';
import { makeMaterialFactory, PALETTE } from './materials.js';
import { createAxisGizmo } from './primitives.js';

export class SceneManager {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true }, true);
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.067, 0.075, 0.094, 1);
    this.material = makeMaterialFactory(this.scene);

    this.camera = new ArcRotateCamera(
      'camera',
      -Math.PI / 2 - 0.6,
      Math.PI / 2.6,
      2.2,
      new Vector3(0, -0.15, 0),
      this.scene,
    );
    this.camera.attachControl(canvas, true);
    this.camera.wheelDeltaPercentage = 0.02;
    this.camera.minZ = 0.01;
    this.camera.lowerRadiusLimit = 0.4;
    this.camera.upperRadiusLimit = 12;

    const hemi = new HemisphericLight('hemi', new Vector3(0.2, 1, 0.1), this.scene);
    hemi.intensity = 0.75;
    hemi.groundColor = new Color3(0.12, 0.13, 0.17);

    this.sun = new DirectionalLight('sun', new Vector3(-0.6, -1, 0.4), this.scene);
    this.sun.position = new Vector3(2, 4, -2);
    this.sun.intensity = 1.1;
    this.shadows = new ShadowGenerator(1024, this.sun);
    this.shadows.useBlurExponentialShadowMap = true;
    this.shadows.blurScale = 2;

    this._buildGround();
    this.worldAxes = createAxisGizmo(this.scene, 'world', 0.35, this.material);
    this.worldAxes.position.y = -0.9;

    this._renderCallbacks = new Set();
    this._resize = () => this.engine.resize();
    window.addEventListener('resize', this._resize);
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.engine.resize());
      this._ro.observe(canvas);
    }
  }

  _buildGround() {
    const ground = CreateGround('ground', { width: 8, height: 8, subdivisions: 1 }, this.scene);
    ground.position.y = -0.9;
    ground.receiveShadows = true;
    const grid = new GridMaterial('gridMat', this.scene);
    grid.majorUnitFrequency = 5;
    grid.minorUnitVisibility = 0.35;
    grid.gridRatio = 0.1;
    grid.mainColor = new Color3(0.067, 0.075, 0.094);
    grid.lineColor = new Color3(0.25, 0.3, 0.38);
    grid.opacity = 0.96;
    ground.material = grid;
    this.ground = ground;
  }

  setWorldAxesVisible(visible) {
    this.worldAxes.setEnabled(visible);
  }

  setGroundVisible(visible) {
    this.ground.setEnabled(visible);
  }

  /** Подписка на кадр рендера. Возвращает функцию отписки. */
  onRender(fn) {
    this._renderCallbacks.add(fn);
    return () => this._renderCallbacks.delete(fn);
  }

  start() {
    this.engine.runRenderLoop(() => {
      const dt = this.engine.getDeltaTime() / 1000;
      for (const fn of this._renderCallbacks) fn(dt);
      this.scene.render();
    });
  }

  focusOn(target, radius) {
    this.camera.setTarget(target instanceof Vector3 ? target : new Vector3(target.x, target.y, target.z));
    if (radius) this.camera.radius = radius;
  }

  dispose() {
    window.removeEventListener('resize', this._resize);
    this._ro?.disconnect();
    this._renderCallbacks.clear();
    this.scene.dispose();
    this.engine.dispose();
  }
}

export { PALETTE };
