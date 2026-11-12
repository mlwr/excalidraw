/**
 * Intranet fork: bounds for elements that come from outside the editor
 * (API imports, libraries) and for what the server draws. Drawing cost
 * grows with an element's size (hachure lines, ellipse steps), so absurd
 * sizes would stall whoever draws them: browsers and the server alike.
 *
 * The editor itself never comes near these: at its smallest zoom (10 %), an
 * element of 100 000 pixels is already ten screens wide.
 */

export interface GeometryLimits {
  /** |x| and |y| */
  coordinate: number;
  /** |width|, |height|, a point's offsets, fontSize */
  size: number;
  /** points of a line, arrow or freehand stroke */
  points: number;
}

/** whole scenes (imports, the server's renderer) */
export const SCENE_LIMITS: GeometryLimits = {
  coordinate: 1e8,
  size: 1e6,
  points: 100_000,
};

/** library items: shapes to reuse, small by nature */
export const LIBRARY_LIMITS: GeometryLimits = {
  coordinate: 1e7,
  size: 1e5,
  points: 100_000,
};

const within = (value: unknown, max: number) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= max;

/** what is wrong with an element's geometry (German), or null */
export const geometryProblem = (
  element: Record<string, unknown>,
  limits: GeometryLimits,
): string | null => {
  for (const key of ["x", "y"]) {
    if (
      element[key] !== undefined &&
      !within(element[key], limits.coordinate)
    ) {
      return `${key} liegt außerhalb`;
    }
  }
  for (const key of ["width", "height", "fontSize"]) {
    if (element[key] !== undefined && !within(element[key], limits.size)) {
      return `${key} ist zu groß`;
    }
  }
  const points = element.points;
  if (points !== undefined) {
    if (!Array.isArray(points)) {
      return "points ist keine Liste";
    }
    if (points.length > limits.points) {
      return `höchstens ${limits.points} Punkte`;
    }
    for (const point of points) {
      if (
        !Array.isArray(point) ||
        !within(point[0], limits.size) ||
        !within(point[1], limits.size)
      ) {
        return "ein Punkt liegt außerhalb";
      }
    }
  }
  return null;
};
