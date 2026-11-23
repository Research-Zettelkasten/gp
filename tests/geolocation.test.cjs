const test = require('node:test');
const assert = require('node:assert/strict');
require('../gp-geolocation.js');

function gps(updates) {
  const cleared = [];
  const geolocation = {
    watchPosition(success, failure, options) {
      assert.equal(options.maximumAge, 0);
      assert.equal(options.enableHighAccuracy, true);
      queueMicrotask(() => {
        for (const update of updates) {
          if (cleared.length) break;
          if (typeof update === 'number') success({timestamp:Date.now(),
            coords:{latitude:30.83, longitude:-83.28, accuracy:update}});
          else if (update.error) failure({code:update.error});
          else success(update);
        }
      });
      return 8;
    },
    clearWatch(id) { cleared.push(id); }
  };
  return {geolocation, cleared};
}

test('waits for a fresh accurate reading and stops when it reaches 50 feet', async () => {
  const {geolocation, cleared} = gps([
    {timestamp:Date.now()-20000, coords:{latitude:30,longitude:-83,accuracy:2}},
    100, 25, 14, 5
  ]);
  const result = await GP_GEO.capture({geolocation, waitMs:25});
  assert.equal(result.accuracy, 14);
  assert.equal(GP_GEO.coordinates(result), '30.830000,-83.280000');
  assert.equal(GP_GEO.accuracyLabel(result.accuracy), 'Good (±46 ft)');
  assert.deepEqual(cleared, [8]);
});

test('a weak signal keeps the best reading at the deadline', async () => {
  const {geolocation, cleared} = gps([110, 35, 55]);
  const result = await GP_GEO.capture({geolocation, waitMs:15});
  assert.equal(result.accuracy, 35);
  assert.match(GP_GEO.accuracyLabel(result.accuracy), /^Approximate/);
  assert.match(GP_GEO.accuracyLabel(55), /^Needs review/);
  assert.deepEqual(cleared, [8]);
});

test('denial, timeout and unavailable position remain distinct', async () => {
  for (const [updates, status] of [[[ {error:1} ], 'denied'], [[ {error:2} ], 'unavailable'], [[], 'timeout']]) {
    const fixture = gps(updates);
    assert.equal((await GP_GEO.capture({...fixture, waitMs:10})).status, status);
    assert.deepEqual(fixture.cleared, [8]);
  }
});
