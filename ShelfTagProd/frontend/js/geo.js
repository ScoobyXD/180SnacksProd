/**
 * ShelfTag — Geolocation Module
 * ==========================
 * Uses the browser Geolocation API to get the user's GPS coordinates.
 * 
 * Primary purpose: Detect if the user is outside the US so we can
 * auto-populate the "Notes" column with currency information.
 * 
 * How it works:
 * - On app open: request geolocation permission and get initial position
 * - On each photo capture: attach current lat/lon to the photo metadata
 * - The backend checks if coordinates are inside the US bounding box
 * - If outside US: auto-populates Notes with currency info
 * 
 * Note: GPS can be flaky indoors (retail stores), so this is best-effort.
 * The app works perfectly fine without geolocation — it just won't auto-detect
 * international currency in that case.
 */

let currentPosition = null;

/**
 * Initialize geolocation — request permission and get initial position.
 * This is called once on app startup.
 * 
 * We use watchPosition instead of getCurrentPosition so the coordinates
 * stay updated as the user moves between stores.
 * 
 * @returns {object|null} { latitude, longitude } or null if unavailable
 */
export async function initGeolocation() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) {
            console.warn('[Geo] Geolocation not supported by this browser');
            resolve(null);
            return;
        }

        // Watch for position changes (updates as user moves)
        navigator.geolocation.watchPosition(
            (position) => {
                currentPosition = {
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude,
                };
                console.log(`[Geo] Position updated: ${currentPosition.latitude.toFixed(4)}, ${currentPosition.longitude.toFixed(4)}`);
            },
            (error) => {
                // Geolocation errors are non-fatal — app works without it
                console.warn(`[Geo] Error: ${error.message}`);
                currentPosition = null;
            },
            {
                enableHighAccuracy: false,  // Don't need pinpoint accuracy for country detection
                timeout: 10000,             // 10 second timeout
                maximumAge: 300000,         // Accept cached position up to 5 minutes old
            }
        );

        // Also do a one-time request for the initial position
        navigator.geolocation.getCurrentPosition(
            (position) => {
                currentPosition = {
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude,
                };
                console.log(`[Geo] Initial position: ${currentPosition.latitude.toFixed(4)}, ${currentPosition.longitude.toFixed(4)}`);
                resolve(currentPosition);
            },
            (error) => {
                console.warn(`[Geo] Initial position failed: ${error.message}`);
                resolve(null);
            },
            {
                enableHighAccuracy: false,
                timeout: 5000,
                maximumAge: 300000,
            }
        );
    });
}


/**
 * Get the current geolocation coordinates.
 * Returns the most recent known position, or null if unavailable.
 * 
 * @returns {object|null} { latitude, longitude } or null
 */
export function getCurrentPosition() {
    return currentPosition;
}
