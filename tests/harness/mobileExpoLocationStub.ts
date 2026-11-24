/**
 * `expo-location` for the mobile render check: the permission is granted and the
 * phone reports the branch's own coordinates, which is what the seeded geofence
 * covers. A punch is not issued in the check — the screens only need the module
 * to load without a native host.
 */
export const Accuracy = { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 };

export async function requestForegroundPermissionsAsync() {
  return { status: 'granted', granted: true };
}

export async function getCurrentPositionAsync() {
  return {
    coords: { latitude: 27.717245, longitude: 85.323959, accuracy: 8.5, altitude: null, heading: null, speed: null },
    timestamp: Date.parse('2026-11-24T08:00:00Z'),
  };
}
