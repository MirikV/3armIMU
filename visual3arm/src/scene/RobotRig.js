/**
 * Риг робота.
 *
 * Два режима, переключаются на лету:
 *  1) 'primitives' — цепь рисуется из цилиндров по описанию RobotModel.
 *     Работает сразу, без файлов модели.
 *  2) 'glb' — грузится GLB/GLTF, а углы применяются к узлам с именами
 *     joint.nodeName из RobotModel. Имена в модели проверяются при загрузке,
 *     ненайденные попадают в this.missingNodes — их видно в UI.
 *
 * Правило для 3D-модели: каждый шарнир — отдельный TransformNode/кость, ось
 * вращения совпадает с joint.axis в ЛОКАЛЬНЫХ осях этого узла, а поза модели
 * в файле считается нулевой (её поворот запоминается как rest и домножается).
 */

import { ImportMeshAsync, Quaternion, TransformNode, Vector3 } from '@babylonjs/core';
import '@babylonjs/loaders/glTF';
import { createAxisGizmo, createJoint, createLink } from './primitives.js';
import { PALETTE } from './materials.js';
import { bindJointNodes, jointNodeQuat } from './glbBinding.js';

export class RobotRig {
  /**
   * @param {import('./SceneManager.js').SceneManager} sm
   * @param {import('../core/robot/RobotModel.js').RobotModel} model
   */
  constructor(sm, model, options = {}) {
    this.sm = sm;
    this.model = model;
    this.mode = 'primitives';
    this.missingNodes = [];
    this.glbRoot = null;
    this.boundNodes = new Map(); // name -> { node, rest }

    this.root = new TransformNode('robotRoot', sm.scene);
    this.root.rotationQuaternion = Quaternion.Identity();
    this.root.position = new Vector3(
      options.position?.x ?? 0.9,
      options.position?.y ?? -0.9,
      options.position?.z ?? 0,
    );

    this._buildPrimitives();
    this.toolAxes = createAxisGizmo(sm.scene, 'tcp', 0.1, sm.material);
    this.toolAxes.parent = this.pivots[this.pivots.length - 1]?.node ?? this.root;
    this.toolAxes.position.y = this.model.joints[this.model.joints.length - 1].length;
  }

  _buildPrimitives() {
    const scene = this.sm.scene;
    const material = this.sm.material;
    this.primitiveRoot = new TransformNode('robotPrimitives', scene);
    this.primitiveRoot.parent = this.root;

    this.pivots = [];
    let parent = this.primitiveRoot;
    let offsetY = 0;
    for (const [i, j] of this.model.joints.entries()) {
      const link = createLink(scene, `robot_${j.name}`, {
        length: j.length,
        radius: i === 0 ? 0.06 : 0.04,
        color: i === 0 ? PALETTE.robotBase : PALETTE.robotLink,
        material,
      });
      link.pivot.parent = parent;
      link.pivot.position = new Vector3(j.offset.x, j.offset.y + offsetY, j.offset.z);
      const joint = createJoint(scene, `robot_${j.name}`, {
        radius: 0.035,
        color: PALETTE.robotJoint,
        material,
      });
      joint.parent = link.pivot;

      this.pivots.push({ name: j.name, node: link.pivot });
      parent = link.pivot;
      offsetY = j.length;
    }

    for (const mesh of this.primitiveRoot.getChildMeshes()) this.sm.shadows.addShadowCaster(mesh);
  }

  /**
   * Подгрузить GLB и привязать шарниры к его узлам.
   * @param {string} url путь к файлу (например '/models/robot.glb')
   */
  async loadGlb(url) {
    this.unloadGlb();
    const result = await ImportMeshAsync(url, this.sm.scene);
    this.glbRoot = new TransformNode('robotGlbRoot', this.sm.scene);
    this.glbRoot.parent = this.root;
    for (const mesh of result.meshes) {
      if (!mesh.parent) mesh.parent = this.glbRoot;
      this.sm.shadows.addShadowCaster(mesh);
    }

    const all = [
      ...(result.transformNodes ?? []),
      ...(result.meshes ?? []),
      ...(result.skeletons?.[0]?.bones ?? []),
    ];
    // Разбор имён и поз — в glbBinding.js, он покрыт тестами (Babylon в них не поднять).
    const { bound, missing } = bindJointNodes(this.model.joints, all);
    this.boundNodes.clear();
    this.missingNodes = missing;
    for (const b of bound) {
      // Поворот узла дальше задаём только кватернионом: углы Эйлера из файла уже
      // сняты в rest, а два источника поворота на одном узле противоречили бы друг другу.
      if (!b.node.rotationQuaternion) b.node.rotationQuaternion = Quaternion.Identity();
      this.boundNodes.set(b.name, { node: b.node, rest: b.rest });
    }

    this.setMode('glb');
    return { bound: bound.map((b) => b.name), missing };
  }

  unloadGlb() {
    if (this.glbRoot) {
      this.glbRoot.dispose(false, true);
      this.glbRoot = null;
    }
    this.boundNodes.clear();
    this.missingNodes = [];
    this.setMode('primitives');
  }

  setMode(mode) {
    this.mode = mode;
    this.primitiveRoot.setEnabled(mode === 'primitives');
    this.glbRoot?.setEnabled(mode === 'glb');
  }

  /** Применить текущие углы модели к сцене. */
  apply() {
    const rotations = this.model.localRotations();
    for (const r of rotations) {
      if (this.mode === 'glb' && this.boundNodes.has(r.name)) {
        const { node, rest } = this.boundNodes.get(r.name);
        const q = jointNodeQuat(rest, r.quat);
        node.rotationQuaternion.set(q.x, q.y, q.z, q.w);
      } else {
        const pivot = this.pivots.find((p) => p.name === r.name);
        pivot?.node.rotationQuaternion.set(r.quat.x, r.quat.y, r.quat.z, r.quat.w);
      }
    }
  }

  setVisible(visible) {
    this.root.setEnabled(visible);
  }

  dispose() {
    this.root.dispose(false, true);
  }
}
