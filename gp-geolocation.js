((root) => {
  'use strict';
  const feetPerMeter = 3.28084;
  const targetFeet = 50;
  const messages = {
    denied: 'Location permission denied',
    unavailable: 'Location unavailable',
    timeout: 'Location timed out',
    unsupported: 'Location is unavailable in this browser'
  };

  function accuracyLabel(meters) {
    const feet = Math.max(1, Math.round(meters * feetPerMeter));
    const quality = meters * feetPerMeter <= targetFeet ? 'Good' : meters * feetPerMeter <= 150 ? 'Approximate' : 'Needs review';
    return `${quality} (±${feet} ft)`;
  }

  function capture({ geolocation = root.navigator?.geolocation, waitMs = 6000 } = {}) {
    if (!geolocation?.watchPosition) return Promise.resolve({status:'unsupported'});
    return new Promise(resolve => {
      let best, watch, stopped = false, lastError = 'timeout';
      const started = Date.now();
      const timer = setTimeout(() => finish(lastError), waitMs);
      function finish(status) {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        if (watch != null) geolocation.clearWatch(watch);
        resolve(best || {status});
      }
      try {
        watch = geolocation.watchPosition(position => {
          const {latitude, longitude, accuracy} = position.coords;
          if (position.timestamp < started - 1000 || position.timestamp > Date.now() + 1000 ||
              !Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) ||
              Math.abs(longitude) > 180 || !Number.isFinite(accuracy) || accuracy <= 0) return;
          if (!best || accuracy <= best.accuracy) best = {status:'available', latitude, longitude, accuracy};
          if (accuracy * feetPerMeter <= targetFeet) finish('available');
        }, error => {
          if (error.code === 1) finish('denied');
          else lastError = error.code === 3 ? 'timeout' : 'unavailable';
        }, {enableHighAccuracy:true, maximumAge:0, timeout:waitMs});
        if (stopped) geolocation.clearWatch(watch);
      } catch { finish('unavailable'); }
    });
  }

  function coordinates(position) {
    return `${position.latitude.toFixed(6)},${position.longitude.toFixed(6)}`;
  }

  async function geotag({addressLookup = false} = {}) {
    const position = await capture();
    if (position.status !== 'available') return {address: messages[position.status], coords:''};
    const coords = coordinates(position);
    const label = accuracyLabel(position.accuracy);
    if (addressLookup && position.accuracy * feetPerMeter <= targetFeet) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      try {
        const [lat, lon] = coords.split(',');
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&addressdetails=1`,
          {signal:controller.signal});
        if (res.ok) {
          const {address} = await res.json();
          const road = address?.road || address?.pedestrian;
          const city = address?.city || address?.town || address?.village;
          if (road && city) {
            const number = address.house_number ? `${address.house_number} ` : '';
            return {address:`Near ${number}${road}, ${city} · ${label}`, coords};
          }
        }
      } catch { /* Keep the pin if the address service is unavailable. */ }
      finally { clearTimeout(timer); }
    }
    return {address:`Location · ${label}`, coords};
  }

  root.GP_GEO = Object.freeze({capture, coordinates, geotag, accuracyLabel, messages:Object.freeze(messages)});
})(globalThis);
