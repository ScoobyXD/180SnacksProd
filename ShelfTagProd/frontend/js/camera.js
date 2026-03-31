/**
 * ShelfTag — Camera Module
 * ====================
 * Handles the smartphone camera:
 * - Requesting camera permission via getUserMedia API
 * - Displaying the live viewfinder
 * - Capturing photos at full resolution (no compression)
 * - Pinch-to-zoom with hardware zoom control
 * - Tap-to-focus with visual feedback + hardware focus (where supported)
 * 
 * Uses rear-facing camera (facingMode: "environment") for product photography.
 */

// ============================================================================
// ZOOM STATE
// ============================================================================

let zoomCapabilities = null;  // { min, max, step } or null if unsupported
let currentZoom = 1;
let activeTrack = null;       // Reference to the active video track
let imageCapture = null;      // Optional ImageCapture API handle (not supported on many iOS builds)


// ============================================================================
// CAMERA INITIALIZATION
// ============================================================================

/**
 * Initialize the camera and start the live viewfinder.
 * Also detects zoom/focus capabilities for the active camera.
 */
export async function initCamera(videoElement) {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 4096 },
                height: { ideal: 2160 },
            },
            audio: false
        });

        videoElement.srcObject = stream;
        await videoElement.play();

        activeTrack = stream.getVideoTracks()[0];
        const settings = activeTrack.getSettings();
        console.log(`[Camera] Initialized: ${settings.width}x${settings.height}`);

        // Best-effort: ImageCapture can provide stronger focus controls on supporting browsers.
        if ('ImageCapture' in window) {
            try {
                imageCapture = new ImageCapture(activeTrack);
            } catch {
                imageCapture = null;
            }
        }

        detectZoomCapabilities();

        return stream;

    } catch (error) {
        if (error.name === 'NotAllowedError') {
            throw new Error('Camera permission denied. Please allow camera access and try again.');
        } else if (error.name === 'NotFoundError') {
            throw new Error('No camera found on this device.');
        } else {
            throw new Error(`Camera error: ${error.message}`);
        }
    }
}


// ============================================================================
// ZOOM
// ============================================================================

function detectZoomCapabilities() {
    if (!activeTrack) return;

    try {
        const capabilities = activeTrack.getCapabilities?.();
        if (capabilities?.zoom) {
            zoomCapabilities = {
                min: capabilities.zoom.min,
                max: capabilities.zoom.max,
                step: capabilities.zoom.step || 0.1,
            };
            currentZoom = activeTrack.getSettings?.()?.zoom || 1;
            console.log(`[Camera] Zoom range: ${zoomCapabilities.min} – ${zoomCapabilities.max} (current: ${currentZoom})`);
        } else {
            console.log('[Camera] Zoom not supported on this device/browser');
        }
    } catch (e) {
        console.warn('[Camera] Could not detect zoom capabilities:', e.message);
    }
}

export function getZoomCapabilities() {
    return zoomCapabilities;
}

export function getCurrentZoom() {
    return currentZoom;
}

/**
 * Set the camera zoom to a specific level (clamped to hardware range).
 */
export async function setZoom(level) {
    if (!zoomCapabilities || !activeTrack) return currentZoom;

    const clamped = Math.min(Math.max(level, zoomCapabilities.min), zoomCapabilities.max);

    try {
        await activeTrack.applyConstraints({ advanced: [{ zoom: clamped }] });
        currentZoom = clamped;
    } catch (e) {
        console.warn('[Camera] Failed to set zoom:', e.message);
    }

    return currentZoom;
}

/**
 * Reset zoom to 1.0×.
 */
export async function resetZoom() {
    if (!zoomCapabilities) return currentZoom;
    return setZoom(1.0);
}


// ============================================================================
// FOCUS
// ============================================================================

/**
 * Attempt to trigger a hardware refocus at the tapped location.
 *
 * Strategy order:
 * 1) ImageCapture.setOptions(pointsOfInterest + single-shot focus) when available
 * 2) MediaTrack constraints with pointsOfInterest / single-shot focus
 * 3) Fallback: focusMode toggle to force a generic refocus cycle
 */
export async function tapToFocus(x, y) {
    if (!activeTrack) return false;

    try {
        const capabilities = activeTrack.getCapabilities?.() || {};

        // 1) Best-quality path: ImageCapture API with tap coordinates
        if (imageCapture?.setOptions) {
            try {
                await imageCapture.setOptions({
                    pointsOfInterest: [{ x, y }],
                    focusMode: 'single-shot',
                });
                console.log('[Camera] Focus via ImageCapture pointsOfInterest');
                return true;
            } catch {
                // Continue to next strategy
            }
        }

        // 2) Track constraints with explicit point-of-interest where supported
        const advanced = [];
        if (capabilities.pointsOfInterest) {
            advanced.push({ pointsOfInterest: [{ x, y }] });
        }

        if (capabilities.focusMode?.includes('single-shot')) {
            advanced.push({ focusMode: 'single-shot' });
        }

        if (advanced.length > 0) {
            await activeTrack.applyConstraints({ advanced });
            console.log('[Camera] Focus via MediaTrack constraints');
            return true;
        }

        // 3) Fallback behavior for Safari/iOS where point-of-interest focus is unavailable
        if (capabilities.focusMode) {
            const modes = capabilities.focusMode;
            if (modes.includes('manual') && modes.includes('continuous')) {
                await activeTrack.applyConstraints({ advanced: [{ focusMode: 'manual' }] });
                await new Promise(r => setTimeout(r, 100));
                await activeTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
                console.log('[Camera] Hardware refocus triggered');
                return true;
            }

            if (modes.includes('continuous')) {
                await activeTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
                console.log('[Camera] Continuous autofocus refresh triggered');
                return true;
            }
        }
    } catch (e) {
        console.log('[Camera] Hardware focus not available:', e.message);
    }

    return false;
}


// ============================================================================
// PHOTO CAPTURE
// ============================================================================

/**
 * Capture current frame at full resolution. No compression applied.
 * Returns base64 JPEG without the data URL prefix.
 */
export function capturePhoto(videoElement) {
    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/jpeg', 1.0);
    const base64Data = dataUrl.split(',')[1];

    console.log(`[Camera] Photo captured: ${canvas.width}x${canvas.height}, ${(base64Data.length * 0.75 / 1024).toFixed(0)} KB`);

    return base64Data;
}


// ============================================================================
// CLEANUP
// ============================================================================

export function stopCamera(stream) {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        activeTrack = null;
        imageCapture = null;
        zoomCapabilities = null;
        currentZoom = 1;
        console.log('[Camera] Stream stopped');
    }
}
