const DEFAULT_COORDINATES = {
  latitude: 21.3250054,
  longitude: 71.0246248,
  radiusMeters: 200,
};

const EARTH_RADIUS_METERS = 6371000;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Computes great-circle distance in meters between two WGS84 coordinates.
 */
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(EARTH_RADIUS_METERS * c);
}

function isWithinGeofence(distanceMeters, radiusMeters = DEFAULT_COORDINATES.radiusMeters) {
  return distanceMeters <= radiusMeters;
}

module.exports = {
  DEFAULT_COORDINATES,
  calculateDistanceMeters,
  isWithinGeofence,
};

