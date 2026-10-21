/**
 * Чистая математика кватернионов и матриц 3x3.
 *
 * Соглашения (важно, дальше везде одинаково):
 *  - кватернион: обычный объект { x, y, z, w }, w — скалярная часть;
 *  - кватернион задаёт поворот вектор-столбца: v' = q * v * q̄ (правая тройка);
 *  - матрица 3x3: Float64Array/массив из 9 чисел, row-major, m[r*3 + c],
 *    действует на вектор-столбец: v'_r = Σ_c m[r*3+c] * v_c.
 *
 * Модуль намеренно не зависит от Babylon — его можно гонять в node-тестах.
 */

export const EPS = 1e-9;

export function quat(x = 0, y = 0, z = 0, w = 1) {
  return { x, y, z, w };
}

export const QUAT_IDENTITY = Object.freeze(quat(0, 0, 0, 1));

export function isQuat(q) {
  return (
    !!q &&
    Number.isFinite(q.x) &&
    Number.isFinite(q.y) &&
    Number.isFinite(q.z) &&
    Number.isFinite(q.w)
  );
}

export function length(q) {
  return Math.hypot(q.x, q.y, q.z, q.w);
}

export function normalize(q) {
  const n = length(q);
  if (n < EPS) return quat();
  return quat(q.x / n, q.y / n, q.z / n, q.w / n);
}

export function conjugate(q) {
  return quat(-q.x, -q.y, -q.z, q.w);
}

/** Обратный кватернион (для единичного совпадает с сопряжённым). */
export function invert(q) {
  return conjugate(normalize(q));
}

/** Композиция: результат = сначала b, потом a (как перемножение матриц A*B). */
export function multiply(a, b) {
  return quat(
    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  );
}

export function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

/**
 * Сферическая интерполяция. Используется для сглаживания потока с часов:
 * slerp(prev, next, alpha) на каждом кадре — простой фильтр первого порядка.
 */
export function slerp(a, b, t) {
  let cos = dot(a, b);
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  // Кватернионы q и -q — один и тот же поворот; берём ближнюю полусферу.
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 1 - 1e-6) {
    // Почти сонаправлены — линейная интерполяция без потери точности.
    return normalize(
      quat(
        a.x + (bx - a.x) * t,
        a.y + (by - a.y) * t,
        a.z + (bz - a.z) * t,
        a.w + (bw - a.w) * t,
      ),
    );
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const ka = Math.sin((1 - t) * theta) / sin;
  const kb = Math.sin(t * theta) / sin;
  return quat(a.x * ka + bx * kb, a.y * ka + by * kb, a.z * ka + bz * kb, a.w * ka + bw * kb);
}

/** Угол между двумя поворотами, радианы [0, π]. */
export function angleBetween(a, b) {
  const c = Math.min(1, Math.abs(dot(normalize(a), normalize(b))));
  return 2 * Math.acos(c);
}

export function fromAxisAngle(axis, angle) {
  const n = Math.hypot(axis.x, axis.y, axis.z);
  if (n < EPS) return quat();
  const h = angle / 2;
  const s = Math.sin(h) / n;
  return quat(axis.x * s, axis.y * s, axis.z * s, Math.cos(h));
}

export function rotateVector(q, v) {
  // v' = v + 2w(u×v) + 2u×(u×v), u — векторная часть.
  const { x, y, z, w } = q;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
}

/** Матрица 3x3 (row-major) поворота, задаваемого кватернионом. */
export function toMatrix3(q) {
  const { x, y, z, w } = normalize(q);
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    1 - (yy + zz), xy - wz, xz + wy,
    xy + wz, 1 - (xx + zz), yz - wx,
    xz - wy, yz + wx, 1 - (xx + yy),
  ];
}

/** Кватернион из матрицы поворота 3x3 (метод Шеппарда — численно устойчив). */
export function fromMatrix3(m) {
  const m00 = m[0];
  const m01 = m[1];
  const m02 = m[2];
  const m10 = m[3];
  const m11 = m[4];
  const m12 = m[5];
  const m20 = m[6];
  const m21 = m[7];
  const m22 = m[8];
  const trace = m00 + m11 + m22;
  let x;
  let y;
  let z;
  let w;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return normalize(quat(x, y, z, w));
}

/** Произведение матриц 3x3 (row-major). */
export function matMul(a, b) {
  const out = new Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

export function matTranspose(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;

export function toDeg(r) {
  return r * DEG;
}

export function toRad(d) {
  return d * RAD;
}
