/**
 * ShelfTag — Local Storage Module
 * ============================
 * Manages two types of local storage:
 * 
 * 1. localStorage — for small persistent user preferences:
 *    - User name (persists across sessions)
 *    - Retailer name (persists across sessions)
 * 
 * 2. IndexedDB — for queued photos waiting to be synced:
 *    - Full resolution JPEG images (2-5 MB each)
 *    - Associated metadata (user, retailer, timestamp, geolocation)
 *    - Sync status (pending / synced / failed)
 */

const DB_NAME = 'shelftag-180snacks';
const DB_VERSION = 1;
const STORE_NAME = 'photos';

let db = null;

// ============================================================================
// IndexedDB SETUP
// ============================================================================

export async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, {
                    keyPath: 'id',
                    autoIncrement: true
                });
                store.createIndex('status', 'status', { unique: false });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                console.log('[Storage] IndexedDB store created');
            }
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('[Storage] IndexedDB opened successfully');
            resolve(db);
        };

        request.onerror = (event) => {
            console.error('[Storage] IndexedDB error:', event.target.error);
            reject(event.target.error);
        };
    });
}


// ============================================================================
// PHOTO QUEUE OPERATIONS (IndexedDB)
// ============================================================================

export async function queuePhoto(imageOrImagesBase64, metadata) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const images = Array.isArray(imageOrImagesBase64) ? imageOrImagesBase64 : [imageOrImagesBase64];

        const record = {
            image_base64: images[0], // legacy compatibility
            images_base64: images,
            metadata: metadata,
            status: 'pending',
            created_at: new Date().toISOString(),
            sync_attempts: 0,
            last_error: null,
        };

        const request = store.add(record);

        request.onsuccess = () => {
            const id = request.result;
            const sizeMB = images.reduce((sum, img) => sum + (img.length * 0.75 / 1024 / 1024), 0);
            console.log(`[Storage] Photo queued: #${id} (${images.length} image${images.length !== 1 ? 's' : ''}, ${sizeMB.toFixed(1)} MB)`);
            resolve(id);
        };

        request.onerror = () => {
            console.error('[Storage] Failed to queue photo:', request.error);
            reject(request.error);
        };
    });
}


export async function getPendingPhotos() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('status');
        const request = index.getAll('pending');

        request.onsuccess = () => {
            console.log(`[Storage] ${request.result.length} pending photos found`);
            resolve(request.result);
        };

        request.onerror = () => reject(request.error);
    });
}


export async function updatePhotoStatus(id, status, error = null) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(id);

        request.onsuccess = () => {
            const record = request.result;
            if (!record) {
                reject(new Error(`Photo #${id} not found`));
                return;
            }

            record.status = status;
            record.last_error = error;
            if (status === 'syncing') {
                record.sync_attempts += 1;
            }

            const updateRequest = store.put(record);
            updateRequest.onsuccess = () => {
                console.log(`[Storage] Photo #${id} status → ${status}`);
                resolve();
            };
            updateRequest.onerror = () => reject(updateRequest.error);
        };

        request.onerror = () => reject(request.error);
    });
}


export async function deleteSyncedPhoto(id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);

        request.onsuccess = () => {
            console.log(`[Storage] Photo #${id} deleted from local queue`);
            resolve();
        };

        request.onerror = () => reject(request.error);
    });
}


/**
 * Reset photos stuck in 'syncing' or 'failed' status back to 'pending'.
 * 
 * If the app closes mid-upload, photos get stuck as 'syncing' forever.
 * Failed photos are retried up to 5 times, then deleted.
 */
export async function resetStuckPhotos() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => {
            let resetCount = 0;

            for (const record of request.result) {
                let needsReset = false;

                if (record.status === 'syncing') {
                    needsReset = true;
                }

                if (record.status === 'failed') {
                    if (record.sync_attempts < 5) {
                        needsReset = true;
                    } else {
                        console.warn(`[Storage] Photo #${record.id} failed ${record.sync_attempts} times, deleting`);
                        store.delete(record.id);
                    }
                }

                if (needsReset) {
                    record.status = 'pending';
                    store.put(record);
                    resetCount++;
                }
            }

            transaction.oncomplete = () => {
                if (resetCount > 0) {
                    console.log(`[Storage] Reset ${resetCount} stuck photos back to pending`);
                }
                resolve(resetCount);
            };

            transaction.onerror = () => reject(transaction.error);
        };

        request.onerror = () => reject(request.error);
    });
}


/**
 * Delete ALL photos from the local queue, regardless of status.
 * Called from the "Clear Queue" button in the queue modal.
 * 
 * This is a nuclear option for when photos get stuck.
 * Does NOT affect photos already uploaded to Airtable/R2.
 * 
 * @returns {number} Number of photos that were deleted
 */
export async function clearAllPhotos() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        // Count first so we can report how many were cleared
        const countRequest = store.count();

        countRequest.onsuccess = () => {
            const count = countRequest.result;
            const clearRequest = store.clear();

            clearRequest.onsuccess = () => {
                console.log(`[Storage] Cleared all ${count} photos from queue`);
                resolve(count);
            };

            clearRequest.onerror = () => reject(clearRequest.error);
        };

        countRequest.onerror = () => reject(countRequest.error);
    });
}


export async function getQueueStats() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => {
            const stats = { pending: 0, syncing: 0, synced: 0, failed: 0 };
            request.result.forEach(record => {
                const imageCount = Array.isArray(record.images_base64) && record.images_base64.length > 0
                    ? record.images_base64.length
                    : 1;
                stats[record.status] = (stats[record.status] || 0) + imageCount;
            });
            resolve(stats);
        };

        request.onerror = () => reject(request.error);
    });
}


// ============================================================================
// USER PREFERENCES (localStorage)
// ============================================================================

export function saveUserName(name) {
    localStorage.setItem('shelftag_user_name', name);
}

export function getUserName() {
    return localStorage.getItem('shelftag_user_name') || '';
}

export function saveRetailer(retailer) {
    localStorage.setItem('shelftag_retailer', retailer);
}

export function getRetailer() {
    return localStorage.getItem('shelftag_retailer') || '';
}
