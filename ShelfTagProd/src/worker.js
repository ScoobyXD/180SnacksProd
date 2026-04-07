/**
 * ShelfTag — Cloudflare Worker
 * ============================
 * Handles the backend API pipeline:
 *   POST /api/sync   → Store image in R2 → Gemini Flash Lite extraction → Airtable record
 *   GET  /api/health  → Health check (frontend uses this to detect connectivity)
 *   GET  /uploads/*   → Serve images from R2 (so Airtable can download them)
 *
 * Static frontend files are served automatically by the [assets] config in wrangler.toml.
 * This worker only receives requests that DON'T match a static file.
 *
 * Environment bindings (set in wrangler.toml + wrangler secret):
 *   env.IMAGES          — R2 bucket binding
 *   env.GEMINI_API_KEY  — Google AI Studio key (secret)
 *   env.AIRTABLE_PAT    — Airtable Personal Access Token (secret)
 *   env.AIRTABLE_BASE_ID  — Airtable base ID
 *   env.AIRTABLE_TABLE_ID — Airtable table ID
 */

const WORKER_VERSION = '2026-04-02-r1';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // ---- CORS preflight ----
        if (request.method === 'OPTIONS') {
            return corsResponse();
        }

        try {
            // ---- API routes ----
            if (url.pathname === '/api/health') {
                return withCORS(handleHealth(env));
            }

            if (url.pathname === '/api/sync' && request.method === 'POST') {
                return withCORS(await handleSync(request, env));
            }

            // ---- Serve images from R2 ----
            if (url.pathname.startsWith('/uploads/') && (request.method === 'GET' || request.method === 'HEAD')) {
                return await handleImage(url.pathname, request.method, env);
            }

            // ---- Nothing matched ----
            return new Response('Not Found', { status: 404 });

        } catch (error) {
            console.error('Worker error:', error);
            return withCORS(Response.json(
                { success: false, error: error.message },
                { status: 500 }
            ));
        }
    }
};


// ============================================================================
// HEALTH CHECK
// ============================================================================

function handleHealth(env) {
    return Response.json({
        status: 'ok',
        gemini_configured: !!env.GEMINI_API_KEY,
        airtable_configured: !!env.AIRTABLE_PAT,
        r2_configured: !!env.IMAGES,
        worker_version: WORKER_VERSION,
    });
}


// ============================================================================
// SYNC PIPELINE — the core of the app
// ============================================================================

async function handleSync(request, env) {
    const requestOrigin = new URL(request.url).origin;
    const imageBaseUrl = String(env.IMAGE_BASE_URL || '').trim().replace(/\/$/, '') || requestOrigin;
    // ---- Parse request ----
    const body = await request.json();
    const { image_base64, images_base64, metadata } = body;
    const imageList = Array.isArray(images_base64) && images_base64.length > 0
        ? images_base64
        : (image_base64 ? [image_base64] : []);

    if (imageList.length === 0 || !metadata) {
        return Response.json(
            { success: false, error: 'Missing images_base64/image_base64 or metadata' },
            { status: 400 }
        );
    }

    console.log(`[Sync ${WORKER_VERSION}] Processing ${imageList.length} image(s) from ${metadata.user_name} at ${metadata.retailer}`);

    // ---- Step 1: Store images in R2 (with metadata for debugging) ----
    const filenames = [];
    const imageUrls = [];
    for (let i = 0; i < imageList.length; i++) {
        const filename = `${crypto.randomUUID()}-${i + 1}.jpg`;
        const imageBytes = base64ToBytes(imageList[i]);

        await env.IMAGES.put(filename, imageBytes, {
            httpMetadata: { contentType: 'image/jpeg' },
            customMetadata: {
                user_name: metadata.user_name || '',
                retailer: metadata.retailer || '',
                timestamp: metadata.timestamp || '',
                latitude: String(metadata.latitude || ''),
                longitude: String(metadata.longitude || ''),
                capture_mode: imageList.length > 1 ? 'multi' : 'single',
                image_index: String(i + 1),
                image_count: String(imageList.length),
            },
        });

        filenames.push(filename);
        imageUrls.push(`${imageBaseUrl}/uploads/${filename}`);
        console.log(`[Sync] Image stored in R2: ${filename} (${(imageBytes.byteLength / 1024).toFixed(0)} KB)`);
    }

    // ---- Step 2: Extract product data with Gemini Flash Lite ----
    let extraction = null;
    try {
        extraction = await extractWithGemini(imageList, env.GEMINI_API_KEY);
        console.log(
            `[Sync] Extracted: ${extraction.flavor || 'unknown'} | ${extraction.brand || 'unknown'} | `
            + `${extraction.nw_oz || '?'}oz | regular:$${extraction.retail_regular || '?'} | `
            + `discount:$${extraction.retail_discounted ?? '?'}`
        );
    } catch (geminiError) {
        console.error(`[Sync] Gemini extraction failed: ${geminiError.message}`);
        return Response.json({
            success: false,
            error: `Gemini extraction failed: ${geminiError.message}`,
            r2_filenames: filenames,
        });
    }

    // ---- Step 3: Create Airtable record ----
    try {
        const recordId = await createAirtableRecord(
            extraction,
            metadata,
            imageUrls,
            env.AIRTABLE_PAT,
            env.AIRTABLE_BASE_ID,
            env.AIRTABLE_TABLE_ID
        );
        console.log(`[Sync] Airtable record created: ${recordId}`);

        return Response.json({
            success: true,
            airtable_record_id: recordId,
            image_count: imageList.length,
            extracted_data: extraction,
        });
    } catch (airtableError) {
        console.error(`[Sync] Airtable failed: ${airtableError.message}`);
        return Response.json({
            success: false,
            error: `Airtable failed: ${airtableError.message}`,
            extracted_data: extraction,
            r2_filenames: filenames,
        });
    }
}


// ============================================================================
// GEMINI FLASH LITE — Image → Structured Product Data
// ============================================================================


const PRODUCT_CATEGORIES = [
    "Nuts",
    "Seeds",
    "Trail Mix",
    "Clusters",
    "Bars",
    "Confectionery",
    "Candy",
    "Chips",
    "Savory Snack",
    "Popcorn",
    "Snack Mix",
    "Dried Fruit",
    "Frozen/Refrigerated",
    "Others",
];

const EXTRACTION_PROMPT = `You are analyzing one or more photos of the SAME snack product on a retail store shelf.
Your job is to combine information across all provided images and extract specific product information.

Extract the following fields:

1. **flavor**: The product name or flavor name as written on the packaging (e.g. "Serenity Trail Mix", "Keto Chocolate Trail Mix", "Deluxe Mixed Nuts").
   - This is the specific product variant, NOT the brand name.

2. **brand**: The manufacturer or brand name (e.g. "Southern Grove", "Power Up", "Planters Nutrition", "Great Value").
   - Usually appears as a logo or prominent text on the package.

3. **flavor_description**: A comma-separated list of the key ingredients or flavors visible on the packaging.
   - Example: "Almonds, Walnuts, Raisins, Dried Cranberries, Hazelnuts, Pecans"
   - Look for ingredient callouts on the front of the package, NOT the nutrition facts panel.

4. **category**: Classify the product into EXACTLY ONE of these categories:
   - "Nuts", "Seeds", "Trail Mix", "Clusters", "Bars", "Confectionery", "Candy", "Chips", "Savory Snack", "Popcorn", "Snack Mix", "Dried Fruit", "Frozen/Refrigerated", "Others"
   - Use "Others" only if none of the other categories clearly fit.

5. **count**: The weight or size exactly as printed on the package (e.g. "16oz", "8ct 1.75oz", "1 LB 454g").
   - Copy this exactly as written on the package.

6. **type**: Classify the product packaging as ONE of these three options:
   - "Single Bag" — a single bag/pouch/container sold individually
   - "Multi Box" — a box containing multiple individual bags/pouches
   - "Multi Bag" — multiple bags bundled/wrapped together as one unit

7. **nw_oz**: The total net weight in OUNCES as a decimal number.
   - For single items: just the weight in oz (convert from grams if needed: grams ÷ 28.3495)
   - For multi-packs: multiply count × per-unit weight (e.g. 8 × 1.75oz = 14.0)
   - Return as a number, not a string.

8. **retail_regular**: The regular retail price from the shelf tag or price label.
   - Look for the price tag on the shelf, NOT on the product packaging.
   - If both a sale price and regular price are shown, use the REGULAR price.
   - Return as a number without the dollar sign (e.g. 4.19, not "$4.19").

9. **retail_discounted**: The discounted/sale price from the shelf tag if present.
   - Return the discounted price when it is explicitly shown (club price, sale price, promo price).
   - If no discounted price is visible, return null.
   - Return as a number without the dollar sign.

IMPORTANT RULES:
- If you cannot determine a field from the image, set it to null. Do NOT guess.
- If multiple photos are provided, they all represent the same product. Fuse all evidence before deciding.
- If multiple products are visible, extract data for the product that is most prominent/centered in the image.
- Focus on the FRONT of the package and the SHELF PRICE TAG.

Respond with valid JSON only.`;

const RESPONSE_SCHEMA = {
    type: "object",
    properties: {
        flavor: { type: "string", nullable: true },
        brand: { type: "string", nullable: true },
        flavor_description: { type: "string", nullable: true },
        category: { type: "string", nullable: true, enum: PRODUCT_CATEGORIES },
        count: { type: "string", nullable: true },
        type: { type: "string", nullable: true, enum: ["Single Bag", "Multi Box", "Multi Bag"] },
        nw_oz: { type: "number", nullable: true },
        retail_regular: { type: "number", nullable: true },
        retail_discounted: { type: "number", nullable: true },
    },
    required: ["flavor", "brand", "flavor_description", "category", "count", "type", "nw_oz", "retail_regular", "retail_discounted"]
};


async function extractWithGemini(imageBase64List, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent`;
    const parts = imageBase64List.map((imageBase64) => ({
        inline_data: {
            mime_type: "image/jpeg",
            data: imageBase64,
        }
    }));
    parts.push({ text: EXTRACTION_PROMPT });

    const payload = {
        contents: [{
            parts
        }],
        generationConfig: {
            response_mime_type: "application/json",
            response_schema: RESPONSE_SCHEMA,
            temperature: 0.1,
        }
    };

    const response = await fetch(`${url}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error ${response.status}: ${errorText}`);
    }

    const result = await response.json();

    try {
        const contentText = result.candidates[0].content.parts[0].text;
        return JSON.parse(contentText);
    } catch (e) {
        console.error('Gemini parse error:', JSON.stringify(result));
        throw new Error(`Failed to parse Gemini response: ${e.message}`);
    }
}


// ============================================================================
// AIRTABLE — Create Record
// ============================================================================

async function createAirtableRecord(extraction, metadata, imageUrls, pat, baseId, tableId) {
    // Detect international currency from coordinates
    let currencyNote = null;
    if (metadata.latitude != null && metadata.longitude != null) {
        const lat = metadata.latitude;
        const lon = metadata.longitude;
        const continentalUS = (lat >= 24.5 && lat <= 49.4) && (lon >= -124.8 && lon <= -66.9);
        const alaska = (lat >= 51.0 && lat <= 71.5) && (lon >= -180.0 && lon <= -129.0);
        const hawaii = (lat >= 18.5 && lat <= 22.5) && (lon >= -160.5 && lon <= -154.5);

        if (!continentalUS && !alaska && !hawaii) {
            currencyNote = `International (lat: ${lat.toFixed(2)}, lon: ${lon.toFixed(2)}) — confirm currency`;
        }
    }

    // Build fields — only include non-null values
    const fields = {};

    if (extraction.flavor != null) fields["Flavor"] = extraction.flavor;
    if (extraction.brand != null) fields["Brand"] = extraction.brand;
    if (extraction.flavor_description != null) fields["Flavor Description"] = extraction.flavor_description;
    if (extraction.category != null) fields["Category"] = extraction.category;
    if (extraction.count != null) fields["Count"] = extraction.count;
    if (extraction.type != null) fields["Type"] = extraction.type;
    if (extraction.nw_oz != null) fields["NW oz"] = extraction.nw_oz;
    if (extraction.retail_regular != null) fields["Retail Regular"] = extraction.retail_regular;
    if (extraction.retail_discounted != null) fields["Retail Discounted"] = extraction.retail_discounted;
    // NOTE: "RT/oz", "FX NW oz", and "RT/oz Discounted" are Formula fields in Airtable — do NOT write to them.
    // RT/oz = {Retail Regular}/{FX NW oz}
    // FX NW oz = IF({NW g} = BLANK(), {NW oz}, {NW g} * 0.03527396)
    // RT/oz Discounted = {Retail Discounted}/{FX NW oz}

    // Metadata
    fields["Retailer"] = metadata.retailer;
    if (metadata.timestamp) {
        fields["Date of Visit"] = metadata.timestamp.split(" ")[0]; // MM/DD/YYYY
    }

    // Image attachment — Airtable downloads from this URL
    fields["Image"] = imageUrls.map((url) => ({ url })); // Multiple images in single row supported

    // Currency note
    if (currencyNote) fields["Notes"] = currencyNote;

    // ---- Send to Airtable ----
    const url = `https://api.airtable.com/v0/${baseId}/${tableId}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${pat}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            records: [{ fields }]
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Airtable API error ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    return result.records[0].id;
}


// ============================================================================
// IMAGE SERVING — Serve product photos from R2
// ============================================================================

async function handleImage(pathname, method, env) {
    // pathname is like "/uploads/abc123.jpg"
    const key = pathname.replace('/uploads/', '');

    const object = await env.IMAGES.get(key);
    if (!object) {
        return new Response('Image not found', { status: 404 });
    }

    const headers = {
        'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
        'Content-Length': String(object.size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
    };

    if (method === 'HEAD') {
        return new Response(null, { headers });
    }

    return new Response(object.body, { headers });
}


// ============================================================================
// HELPERS
// ============================================================================


/**
 * Convert a base64 string to a Uint8Array.
 */
function base64ToBytes(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

/**
 * CORS preflight response.
 */
function corsResponse() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
        },
    });
}

/**
 * Add CORS headers to any response.
 */
function withCORS(response) {
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}
