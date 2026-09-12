import test from 'node:test';
import assert from 'node:assert/strict';
import { latLonToCartesian, cartesianToLatLon, cameraBasis, project, intersectSphere, surfaceAt, distanceToZoom, zoomToDistance, wrapLongitude, HOME, MIN_DISTANCE, MAX_DISTANCE } from '../../earthxt/geometry.js';
import { LEVELS, selectLOD } from '../../earthxt/lod.js';
const close = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≈ ${b}`);

test('known geographic axes and spherical coordinate round trips', () => {
  assert.deepEqual(latLonToCartesian(0, 0), [0, 0, 1]);
  close(latLonToCartesian(90, 0)[1], 1);
  close(latLonToCartesian(0, 90)[0], 1);
  for (const lat of [-89, -60, 0, 45, 89]) for (const lon of [-179.9, -90, 0, 90, 179.9]) {
    const point = latLonToCartesian(lat, lon);
    close(Math.hypot(...point), 1);
    const back = cartesianToLatLon(point);
    close(back.latitude, lat); close(back.longitude, lon);
  }
});
test('perspective projection and near-surface occlusion across all camera distances', () => {
  const viewport = { width: 1000, height: 800, focal: 900 };
  for (const distance of [MIN_DISTANCE, 1.4, 2.05, HOME.distance, MAX_DISTANCE]) {
    const camera = { latitude: 0, longitude: 0, distance };
    const front = project([0, 0, 1], camera, viewport);
    assert.equal(front.visible, true); close(front.x, 500); close(front.y, 400); close(front.distance, distance - 1);
    assert.equal(project([0, 0, -1], camera, viewport).visible, false);
    // Facing the camera axis is insufficient: points beyond the perspective
    // horizon must also be culled even on the nominal front hemisphere.
    assert.equal(project(latLonToCartesian(0, Math.acos(1 / distance) * 180 / Math.PI + 0.1), camera, viewport).visible, false);
    assert.equal(intersectSphere(100, 100, distance), null);
    close(intersectSphere(0, 0, distance)[2], 1);
  }
});
test('projection and inverse ray sampling agree after rotation, zoom, and resize', () => {
  for (const latitude of [-70, 0, 65]) for (const longitude of [-179, -45, 110]) for (const distance of [1.16, 2, 4.6]) {
    const camera = { latitude, longitude, distance, basis: cameraBasis(latitude, longitude) };
    const viewport = { width: 390, height: 440, focal: 450 };
    for (const [x, y] of [[195, 220], [185, 205], [230, 240]]) {
      const hit = surfaceAt(x, y, camera, viewport);
      assert.ok(hit);
      const back = project(latLonToCartesian(hit.latitude, hit.longitude), camera, viewport);
      assert.ok(back.visible); close(back.x, x); close(back.y, y);
    }
  }
});
test('continuous logarithmic zoom has finite, bounded endpoints and round trips', () => {
  close(zoomToDistance(0), MAX_DISTANCE); close(zoomToDistance(1), MIN_DISTANCE);
  assert.equal(zoomToDistance(-10), MAX_DISTANCE); close(zoomToDistance(10), MIN_DISTANCE);
  for (let i = 0; i <= 100; i++) close(distanceToZoom(zoomToDistance(i / 100)), i / 100);
  close(wrapLongitude(181), -179); close(wrapLongitude(-541), 179);
});
test('three LODs are reachable in both directions and have threshold hysteresis', () => {
  for (const level of LEVELS) assert.equal(selectLOD(distanceToZoom(level.targetDistance)).id, level.id);
  assert.equal(selectLOD(0.26).index, 1);
  assert.equal(selectLOD(0.25, LEVELS[1]).index, 1);
  assert.equal(selectLOD(0.23, LEVELS[1]).index, 0);
  assert.equal(selectLOD(0.53, LEVELS[2]).index, 2);
  assert.equal(selectLOD(0.5, LEVELS[2]).index, 1);
  assert.equal(selectLOD(0, LEVELS[2]).index, 0);
});
