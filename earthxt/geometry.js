/** Unit-sphere geometry. No rendering, DOM, or geographic-data dependencies. */
export const RAD = Math.PI / 180;
export const EARTH_RADIUS_KM = 6371;
export const MIN_DISTANCE = 1.16;
export const MAX_DISTANCE = 4.6;
export const HOME = Object.freeze({ latitude: 18, longitude: -24, distance: 3.2 });
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const wrapLongitude = longitude => ((longitude + 180) % 360 + 360) % 360 - 180;

export function latLonToCartesian(latitude, longitude, radius = 1) {
  const lat = latitude * RAD, lon = longitude * RAD;
  return [radius * Math.cos(lat) * Math.sin(lon), radius * Math.sin(lat), radius * Math.cos(lat) * Math.cos(lon)];
}

export function cartesianToLatLon([x, y, z]) {
  const radius = Math.hypot(x, y, z);
  return { latitude: Math.asin(clamp(y / radius, -1, 1)) / RAD, longitude: Math.atan2(x, z) / RAD };
}

export function cameraBasis(latitude, longitude) {
  const lat = latitude * RAD, lon = longitude * RAD;
  return {
    east: [Math.cos(lon), 0, -Math.sin(lon)],
    north: [-Math.sin(lat) * Math.sin(lon), Math.cos(lat), -Math.sin(lat) * Math.cos(lon)],
    front: latLonToCartesian(latitude, longitude),
  };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function project(point, camera, viewport, out = {}) {
  const basis = camera.basis ?? cameraBasis(camera.latitude, camera.longitude);
  const x = dot(point, basis.east), y = dot(point, basis.north), z = dot(point, basis.front);
  const depth = camera.distance - z;
  out.x = viewport.width / 2 + viewport.focal * x / depth;
  out.y = viewport.height / 2 - viewport.focal * y / depth;
  out.visible = camera.distance * z > 1;
  out.distance = Math.hypot(x, y, depth);
  return out;
}

/** Near ray/sphere intersection in camera space; the far side is never sampled. */
export function intersectSphere(rayX, rayY, distance) {
  const a = rayX * rayX + rayY * rayY + 1;
  const discriminant = distance * distance - a * (distance * distance - 1);
  if (discriminant < 0) return null;
  const t = (distance - Math.sqrt(discriminant)) / a;
  return [t * rayX, t * rayY, distance - t];
}

export function surfaceAt(screenX, screenY, camera, viewport) {
  const hit = intersectSphere((screenX - viewport.width / 2) / viewport.focal,
    (viewport.height / 2 - screenY) / viewport.focal, camera.distance);
  if (!hit) return null;
  const basis = camera.basis ?? cameraBasis(camera.latitude, camera.longitude);
  return cartesianToLatLon([0, 1, 2].map(i => basis.east[i] * hit[0] + basis.north[i] * hit[1] + basis.front[i] * hit[2]));
}

export function distanceToZoom(distance) {
  return Math.log((MAX_DISTANCE - 1) / (distance - 1)) / Math.log((MAX_DISTANCE - 1) / (MIN_DISTANCE - 1));
}
export function zoomToDistance(zoom) {
  return 1 + (MAX_DISTANCE - 1) * Math.pow((MIN_DISTANCE - 1) / (MAX_DISTANCE - 1), clamp(zoom, 0, 1));
}
