/**
 * ShelfTag — Main Application
 * ========================
 * Entry point that ties together all modules:
 * - Camera (viewfinder + capture + zoom + focus)
 * - Storage (IndexedDB queue + localStorage preferences)
 * - Sync (parallel upload when online, aggressive flush on background)
 * - Geo (geolocation for currency detection)
 *
 * Gestures:
 * - Pinch on viewfinder → zoom in/out (hardware zoom)
 * - Single tap on viewfinder → focus (yellow ring + hardware refocus)
 * - Tap zoom button (bottom-left cluster) → reset to 1×
 */

import { initCamera, capturePhoto, stopCamera, setZoom, resetZoom, getCurrentZoom, getZoomCapabilities, tapToFocus } from './camera.js';
import { initDB, queuePhoto, saveUserName, getUserName, saveRetailer, getRetailer, getQueueStats, clearAllPhotos } from './storage.js';
import { initSync, processQueue, onSyncStatusChange } from './sync.js';
import { initGeolocation, getCurrentPosition } from './geo.js';

// ============================================================================
// APP VERSIONING (IMPORTANT FOR ALL FUTURE LLMs/ENGINEERS)
// ============================================================================
/**
 * Displayed in the top-left status UI as "v##.##".
 *
 * VERSION BUMP RULE:
 * - Bump this value on every deploy that changes frontend behavior.
 * - Keep the readable 2-digit major + 2-digit minor format (v01.00, v01.01, ...).
 * - Also bump CACHE_VERSION in /frontend/sw.js in the same deploy so clients refresh cache.
 * - These two version values do NOT need to share the same numeric format.
 */
const APP_VERSION = 'v01.10';

/**
 * iOS Safari / PWA memory guardrail:
 * process selected gallery images sequentially and cap selection size.
 */
const MAX_GALLERY_UPLOAD_COUNT = 30;

const RETAILER_SECTIONS = [
    {
        label: 'Costco (US)',
        options: [
            'Costco BA',
            'Costco LA',
            'Costco MW',
            'Costco NE',
            'Costco NW',
            'Costco SD',
            'Costco SE',
            'Costco TX',
        ],
    },
    {
        label: 'Costco (Outside US)',
        options: [
            'Costco Canada East',
            'Costco Canada West',
        ],
    },
    {
        label: 'Other Retailers',
        options: [
            'Aldi',
            'Burlington',
            'CVS',
            'Dollar General',
            'Dollar Tree',
            'Grocery Outlet',
            'HomeGoods',
            "Marshall's",
            'Ross',
            "Sam's Club",
            'Smart & Final',
            'TJ Maxx',
            "Trader Joe's",
            'Walmart',
            'Whole Foods',
        ],
    },
];

const RETAILER_OPTIONS = RETAILER_SECTIONS.flatMap((section) => section.options);

// ============================================================================
// APP STATE
// ============================================================================

let cameraStream = null;
let isCapturing = false;
let isGalleryQueueing = false;
let queueStatsInterval = null;
let captureMode = 'single'; // 'single' | 'multi'
let multiTrayImages = [];
let selectedMultiIndex = null;

// Gesture state
let pinchState = { active: false, initialDistance: 0, initialZoom: 1 };
let tapState = { startX: 0, startY: 0, startTime: 0, moved: false, fingers: 0 };


// ============================================================================
// INITIALIZATION
// ============================================================================

async function init() {
    console.log('[App] Initializing ShelfTag...');

    await registerServiceWorker();
    await initDB();
    initGeolocation();

    const videoEl = document.getElementById('viewfinder');
    try {
        cameraStream = await initCamera(videoEl);
    } catch (error) {
        showError(error.message);
        return;
    }

    initRetailerOptions();
    loadUserPreferences();

    initSync();
    onSyncStatusChange(updateSyncBadge);

    setupEventHandlers();
    setupCameraGestures();
    updateZoomIndicator();
    renderAppVersion();
    renderCaptureModeButton();
    renderMultiTray();

    processQueue();

    const stats = await getQueueStats();
    updateSyncBadge(stats);

    console.log('[App] ShelfTag initialized successfully');
}

async function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        try {
            const reg = await navigator.serviceWorker.register('/sw.js');
            console.log('[App] Service worker registered:', reg.scope);

            // If a worker is waiting, activate it now instead of waiting for multiple reopen cycles.
            if (reg.waiting) {
                reg.waiting.postMessage({ type: 'SKIP_WAITING' });
            }

            reg.addEventListener('updatefound', () => {
                const newWorker = reg.installing;
                if (!newWorker) return;

                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        console.log('[App] New SW installed, forcing immediate activation');
                        newWorker.postMessage({ type: 'SKIP_WAITING' });
                    }
                });
            });

            // After controller switches to new worker, reload once to guarantee latest code is active.
            let hasRefreshed = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (hasRefreshed) return;
                hasRefreshed = true;
                console.log('[App] SW controller changed — reloading to latest version');
                window.location.reload();
            });

            // Periodic SW update checks while app is open.
            setInterval(() => reg.update(), 30000);
        } catch (error) {
            console.warn('[App] Service worker registration failed:', error);
        }
    }
}


// ============================================================================
// USER PREFERENCES
// ============================================================================

function loadUserPreferences() {
    document.getElementById('user-name').value = getUserName();

    const retailerSelect = document.getElementById('retailer-name');
    const savedRetailer = getRetailer();
    if (savedRetailer && RETAILER_OPTIONS.includes(savedRetailer)) {
        retailerSelect.value = savedRetailer;
    } else {
        retailerSelect.value = '';
    }
}

function initRetailerOptions() {
    const retailerSelect = document.getElementById('retailer-name');
    if (!retailerSelect) return;

    RETAILER_SECTIONS.forEach((section) => {
        const optgroup = document.createElement('optgroup');
        optgroup.label = section.label;

        section.options.forEach((retailer) => {
            const option = document.createElement('option');
            option.value = retailer;
            option.textContent = retailer;
            optgroup.appendChild(option);
        });

        retailerSelect.appendChild(optgroup);
    });
}

function handleNameChange(event) {
    saveUserName(event.target.value.trim());
}

function handleRetailerChange(event) {
    saveRetailer(event.target.value);
}


// ============================================================================
// PHOTO CAPTURE
// ============================================================================

async function handleCapture() {
    if (isCapturing) return;

    const videoEl = document.getElementById('viewfinder');
    const userName = getUserName();
    const retailer = getRetailer();

    if (!userName || !retailer) {
        showToast('Please enter your name and retailer first');
        return;
    }

    if (captureMode === 'multi' && multiTrayImages.length >= 4) {
        showToast('Multi tray is full — upload to queue first');
        renderMultiTray();
        return;
    }

    isCapturing = true;

    try {
        triggerFlash();

        const imageBase64 = capturePhoto(videoEl);
        const now = new Date();
        const position = getCurrentPosition();

        const metadata = {
            user_name: userName,
            retailer: retailer,
            timestamp: formatTimestamp(now),
            latitude: position?.latitude || null,
            longitude: position?.longitude || null,
            source: 'camera',
        };

        if (captureMode === 'multi') {
            multiTrayImages.push(imageBase64);
            selectedMultiIndex = null;
            renderMultiTray();
        } else {
            await queuePhoto(imageBase64, metadata);
            const stats = await getQueueStats();
            updateSyncBadge(stats);
            processQueue();
        }

    } catch (error) {
        console.error('[App] Capture error:', error);
        showToast('Failed to capture photo');
    } finally {
        isCapturing = false;
    }
}

async function handleMultiTrayUpload() {
    if (multiTrayImages.length === 0) {
        showToast('Multi tray is empty');
        return;
    }

    const userName = getUserName();
    const retailer = getRetailer();

    if (!userName || !retailer) {
        showToast('Please enter your name and retailer first');
        return;
    }

    const position = getCurrentPosition();
    const metadata = {
        user_name: userName,
        retailer: retailer,
        timestamp: formatTimestamp(new Date()),
        latitude: position?.latitude || null,
        longitude: position?.longitude || null,
        source: 'camera_multi',
        image_count: multiTrayImages.length,
    };

    await queuePhoto([...multiTrayImages], metadata);
    multiTrayImages = [];
    selectedMultiIndex = null;
    renderMultiTray();
    showToast('Multi photos added to queue');

    const stats = await getQueueStats();
    updateSyncBadge(stats);
    processQueue();
}

/**
 * Handle gallery uploads (iOS + Android).
 *
 * Memory-safety design:
 * - Enforce a strict count cap.
 * - Read and queue files one by one, never in parallel.
 * - Keep full-quality source image (no compression) as requested.
 */
async function handleGallerySelection(event) {
    const fileInput = event.target;
    const files = Array.from(fileInput.files || []);

    if (files.length === 0) return;

    const userName = getUserName();
    const retailer = getRetailer();

    if (!userName || !retailer) {
        showToast('Please enter your name and retailer first');
        fileInput.value = '';
        return;
    }

    if (files.length > MAX_GALLERY_UPLOAD_COUNT) {
        showToast(`Please select ${MAX_GALLERY_UPLOAD_COUNT} photos or fewer`);
        fileInput.value = '';
        return;
    }

    const imageFiles = files.filter(file => file.type.startsWith('image/'));
    if (imageFiles.length !== files.length) {
        showToast('Only image files are supported');
        fileInput.value = '';
        return;
    }

    try {
        isGalleryQueueing = true;
        updateSyncBadge(await getQueueStats());

        for (let i = 0; i < imageFiles.length; i++) {
            const file = imageFiles[i];

            try {
                const imageBase64 = await readFileAsBase64(file);
                const position = getCurrentPosition();

                const metadata = {
                    user_name: userName,
                    retailer,
                    timestamp: formatTimestamp(new Date(file.lastModified || Date.now())),
                    latitude: position?.latitude || null,
                    longitude: position?.longitude || null,
                    source: 'gallery',
                    original_filename: file.name,
                };

                await queuePhoto(imageBase64, metadata);
                showToast(`Queued ${i + 1}/${imageFiles.length}`);
            } catch (error) {
                console.error('[App] Failed to queue gallery photo:', file.name, error);
                showToast(`Failed: ${file.name}`);
            }
        }
    } finally {
        isGalleryQueueing = false;
    }

    const stats = await getQueueStats();
    updateSyncBadge(stats);
    processQueue();

    fileInput.value = '';
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
            const dataUrl = String(reader.result || '');
            resolve(dataUrl.split(',')[1] || '');
        };

        reader.onerror = () => reject(reader.error || new Error('File read failed'));
        reader.readAsDataURL(file);
    });
}


// ============================================================================
// CAMERA GESTURES — Pinch-to-Zoom + Tap-to-Focus
// ============================================================================

function setupCameraGestures() {
    const viewfinder = document.getElementById('viewfinder');

    viewfinder.addEventListener('touchstart', handleTouchStart, { passive: false });
    viewfinder.addEventListener('touchmove', handleTouchMove, { passive: false });
    viewfinder.addEventListener('touchend', handleTouchEnd, { passive: false });
}

function handleTouchStart(e) {
    if (e.target.closest('#controls, #info-box, #sync-badge, #queue-modal, #zoom-btn, #gallery-btn, #capture-mode-btn, #multi-tray')) return;

    tapState.fingers = e.touches.length;
    tapState.moved = false;

    if (e.touches.length === 2) {
        e.preventDefault();
        pinchState.active = true;
        pinchState.initialDistance = getTouchDistance(e.touches);
        pinchState.initialZoom = getCurrentZoom();
    } else if (e.touches.length === 1) {
        tapState.startX = e.touches[0].clientX;
        tapState.startY = e.touches[0].clientY;
        tapState.startTime = Date.now();
    }
}

function handleTouchMove(e) {
    if (pinchState.active && e.touches.length === 2) {
        e.preventDefault();
        const currentDistance = getTouchDistance(e.touches);
        const scale = currentDistance / pinchState.initialDistance;
        const newZoom = pinchState.initialZoom * scale;
        setZoom(newZoom).then(updateZoomIndicator);
    } else if (e.touches.length === 1) {
        const dx = e.touches[0].clientX - tapState.startX;
        const dy = e.touches[0].clientY - tapState.startY;
        if (Math.sqrt(dx * dx + dy * dy) > 10) {
            tapState.moved = true;
        }
    }
}

function handleTouchEnd(e) {
    if (pinchState.active) {
        pinchState.active = false;
        return;
    }

    // Tap-to-focus: single finger, brief, no movement
    if (tapState.fingers === 1 && !tapState.moved && (Date.now() - tapState.startTime) < 300) {
        if (e.target.closest('#controls, #info-box, #sync-badge, #queue-modal, #zoom-btn, #gallery-btn, #capture-mode-btn, #multi-tray')) return;

        const viewfinder = document.getElementById('viewfinder');
        const rect = viewfinder.getBoundingClientRect();
        const screenX = tapState.startX;
        const screenY = tapState.startY;
        const normX = (screenX - rect.left) / rect.width;
        const normY = (screenY - rect.top) / rect.height;

        showFocusRing(screenX, screenY);
        tapToFocus(normX, normY);
    }
}

function getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Show iOS-style yellow focus ring at the tap point.
 */
function showFocusRing(x, y) {
    const ring = document.getElementById('focus-ring');
    if (!ring) return;

    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;

    ring.classList.remove('active');
    void ring.offsetWidth; // Force reflow to restart animation
    ring.classList.add('active');
}

/**
 * Update zoom button. Shows raw zoom level (1.0×, 2.0×, etc).
 * Turns yellow when zoomed past 1×. Tap resets to 1×.
 */
function updateZoomIndicator() {
    const indicator = document.getElementById('zoom-btn');
    if (!indicator) return;

    const capabilities = getZoomCapabilities();
    if (!capabilities) {
        indicator.classList.add('hidden');
        return;
    }

    const zoom = getCurrentZoom();

    indicator.classList.remove('hidden');
    indicator.textContent = `${zoom.toFixed(1)}×`;

    if (zoom > 1.05) {
        indicator.classList.add('zoomed');
    } else {
        indicator.classList.remove('zoomed');
    }
}

function renderCaptureModeButton() {
    const modeBtn = document.getElementById('capture-mode-btn');
    if (!modeBtn) return;

    const isMulti = captureMode === 'multi';
    modeBtn.innerHTML = isMulti
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.3" y="2.8" width="11.4" height="18.4" rx="3.3" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="8.5" y="5.8" width="7" height="2.9" rx="1" fill="currentColor"/><rect x="8.5" y="10.5" width="7" height="2.9" rx="1" fill="currentColor"/><rect x="8.5" y="15.2" width="7" height="2.9" rx="1" fill="currentColor"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3.5" width="16" height="17" rx="4.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M11.1 9.4h1.9v6.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.1 10.7l1.2-1.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    modeBtn.classList.toggle('multi', isMulti);
    modeBtn.setAttribute('aria-label', isMulti ? 'Switch to single mode' : 'Switch to multi mode');
}


function positionMultiTray() {
    const tray = document.getElementById('multi-tray');
    const modeBtn = document.getElementById('capture-mode-btn');
    if (!tray || !modeBtn) return;

    const modeRect = modeBtn.getBoundingClientRect();
    const trayWidth = tray.offsetWidth || 56;
    const left = modeRect.left + (modeRect.width / 2) - (trayWidth / 2);
    tray.style.left = `${Math.max(8, left)}px`;
}

function renderMultiTray() {
    const tray = document.getElementById('multi-tray');
    const uploadBtn = document.getElementById('multi-upload-btn');
    const deleteBtn = document.getElementById('multi-delete-btn');
    const shutterBtn = document.getElementById('shutter-btn');
    if (!tray || !uploadBtn || !deleteBtn || !shutterBtn) return;

    const isMulti = captureMode === 'multi';
    tray.classList.toggle('hidden', !isMulti);
    positionMultiTray();

    const isFull = multiTrayImages.length >= 4;
    shutterBtn.classList.toggle('disabled-multi', isMulti && isFull);
    uploadBtn.disabled = multiTrayImages.length === 0;
    deleteBtn.classList.toggle('hidden', selectedMultiIndex == null);

    const slots = Array.from(document.querySelectorAll('.multi-slot'));
    const startSlot = Math.max(0, slots.length - multiTrayImages.length);
    slots.forEach((slot, idx) => {
        const imageIndex = idx >= startSlot ? (idx - startSlot) : null;
        const image = imageIndex != null ? multiTrayImages[imageIndex] : null;
        if (image) {
            slot.classList.add('filled');
            slot.style.backgroundImage = `url(data:image/jpeg;base64,${image})`;
            slot.dataset.imageIndex = String(imageIndex);
            slot.classList.toggle('selected', selectedMultiIndex === imageIndex);
        } else {
            slot.classList.remove('filled');
            slot.classList.remove('selected');
            slot.style.backgroundImage = 'none';
            slot.dataset.imageIndex = '';
        }
    });

    if (selectedMultiIndex == null) {
        deleteBtn.style.top = '';
    } else {
        const selectedSlot = startSlot + selectedMultiIndex;
        const slotHeight = 44;
        const slotGap = 6;
        const slotsStartTop = 44;
        deleteBtn.style.top = `${slotsStartTop + (selectedSlot * (slotHeight + slotGap)) + 6}px`;
    }
}

function toggleCaptureMode() {
    captureMode = captureMode === 'single' ? 'multi' : 'single';
    selectedMultiIndex = null;
    renderCaptureModeButton();
    renderMultiTray();
}

function handleMultiSlotSelect(event) {
    const slot = event.currentTarget;
    if (!slot.classList.contains('filled')) return;

    const imageIndex = Number(slot.dataset.imageIndex);
    if (!Number.isFinite(imageIndex)) return;

    selectedMultiIndex = selectedMultiIndex === imageIndex ? null : imageIndex;
    renderMultiTray();
}

function handleDeleteSelectedMulti() {
    if (selectedMultiIndex == null) return;
    multiTrayImages.splice(selectedMultiIndex, 1);
    selectedMultiIndex = null;
    renderMultiTray();
}


// ============================================================================
// UI HELPERS
// ============================================================================

function formatTimestamp(date) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const yyyy = date.getFullYear();
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${mm}/${dd}/${yyyy} ${hh}:${min}`;
}

function updateSyncBadge(stats) {
    const badge = document.getElementById('sync-badge');
    const count = stats.pending;

    badge.textContent = count;
    badge.classList.remove('pending', 'syncing', 'processing');

    if (isGalleryQueueing) {
        badge.classList.add('processing');
    } else if (stats.syncing > 0) {
        badge.classList.add('syncing');
    } else if (count > 0) {
        badge.classList.add('pending');
    }

    // Keep queue modal live while open.
    updateQueueModalStats(stats);
}

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
}

function showError(message) {
    document.getElementById('error-message').textContent = message;
    document.getElementById('error-screen').classList.remove('hidden');
}

function triggerFlash() {
    const flash = document.getElementById('flash');
    flash.classList.remove('active');
    void flash.offsetWidth; // Force reflow to restart animation
    flash.classList.add('active');

    // Keep this aligned with shutter-blink CSS animation duration.
    setTimeout(() => flash.classList.remove('active'), 200);
}

function renderAppVersion() {
    const versionEl = document.getElementById('app-version');
    if (!versionEl) return;
    versionEl.textContent = APP_VERSION;
}


// ============================================================================
// QUEUE MODAL
// ============================================================================

function openQueueModal() {
    document.getElementById('queue-modal').classList.remove('hidden');
    refreshQueueModalStats();
    processQueue(); // Ensure sync continues while modal is visible.

    if (queueStatsInterval) clearInterval(queueStatsInterval);
    queueStatsInterval = setInterval(refreshQueueModalStats, 750);
}

function closeQueueModal() {
    document.getElementById('queue-modal').classList.add('hidden');
    if (queueStatsInterval) {
        clearInterval(queueStatsInterval);
        queueStatsInterval = null;
    }
}

async function refreshQueueModalStats() {
    const stats = await getQueueStats();
    updateQueueModalStats(stats);
}

function updateQueueModalStats(stats) {
    const modal = document.getElementById('queue-modal');
    if (!modal || modal.classList.contains('hidden')) return;

    document.getElementById('stat-pending').textContent = stats.pending;
    document.getElementById('stat-syncing').textContent = stats.syncing;
    document.getElementById('stat-failed').textContent = stats.failed;

    const spinner = document.getElementById('queue-upload-spinner');
    if (spinner) {
        spinner.classList.toggle('active', stats.syncing > 0 || isGalleryQueueing);
    }
}

async function handleClearQueue() {
    const count = await clearAllPhotos();
    showToast(`Cleared ${count} photo${count !== 1 ? 's' : ''}`);
    closeQueueModal();
    const stats = await getQueueStats();
    updateSyncBadge(stats);
}


// ============================================================================
// EVENT HANDLERS
// ============================================================================

function setupEventHandlers() {
    // Shutter button
    document.getElementById('shutter-btn').addEventListener('click', handleCapture);

    // User name / retailer inputs
    const nameInput = document.getElementById('user-name');
    nameInput.addEventListener('change', handleNameChange);
    nameInput.addEventListener('blur', handleNameChange);

    const retailerInput = document.getElementById('retailer-name');
    retailerInput.addEventListener('change', handleRetailerChange);
    retailerInput.addEventListener('blur', handleRetailerChange);

    // Info box tap → focus first empty input
    document.getElementById('info-box').addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'LABEL') return;
        if (!nameInput.value) nameInput.focus();
        else retailerInput.focus();
    });

    // Sync badge tap → queue modal
    document.getElementById('sync-badge').addEventListener('click', openQueueModal);

    // Queue modal controls
    document.getElementById('queue-modal-close').addEventListener('click', closeQueueModal);
    document.getElementById('clear-queue-btn').addEventListener('click', handleClearQueue);
    document.getElementById('queue-modal').addEventListener('click', (e) => {
        if (e.target.id === 'queue-modal') closeQueueModal();
    });

    // Zoom button tap → reset to 1×
    document.getElementById('zoom-btn').addEventListener('click', async () => {
        await resetZoom();
        updateZoomIndicator();
    });

    // Capture mode + multi tray upload
    document.getElementById('capture-mode-btn').addEventListener('click', toggleCaptureMode);
    document.getElementById('multi-upload-btn').addEventListener('click', handleMultiTrayUpload);
    document.getElementById('multi-delete-btn').addEventListener('click', handleDeleteSelectedMulti);
    document.querySelectorAll('.multi-slot').forEach((slot) => {
        slot.addEventListener('click', handleMultiSlotSelect);
    });

    // Gallery upload (bottom-left icon).
    document.getElementById('gallery-input').addEventListener('change', handleGallerySelection);
    document.getElementById('gallery-btn').addEventListener('click', () => {
        const input = document.getElementById('gallery-input');

        // Best-effort path toward opening directly into the media picker UI.
        // Browser/OS may still show source options depending on platform policy.
        if (typeof input.showPicker === 'function') {
            input.showPicker();
        } else {
            input.click();
        }
    });
}


// ============================================================================
// APP LIFECYCLE
// ============================================================================

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('resize', positionMultiTray);

window.addEventListener('beforeunload', () => {
    stopCamera(cameraStream);
});
