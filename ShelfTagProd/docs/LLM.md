# ShelfTag — 180 Snacks Product Photo Scanner

## Purpose of This Document

This is the single source of truth for the ShelfTag project. It serves three audiences simultaneously:

1. **Field reps / office workers** — how to install, use, and troubleshoot the app (start at [User Manual](#user-manual))
2. **Engineers** — technical architecture, codebase walkthrough, how to run and extend the system (start at [Engineer Manual](#engineer-manual))
3. **LLM instances / future developers** — every architectural decision, why it was made, what was rejected and why, known quirks, and open items (the entire document, but especially [Architecture Decisions & Rationale](#architecture-decisions--rationale) and [Known Quirks & Edge Cases](#known-quirks--edge-cases))

**If you are an LLM picking up this project: read the entire document before making changes. Every architectural decision was made through deliberate discussion — don't change things without understanding why they were chosen.**

---

## Table of Contents

- [User Manual](#user-manual)
  - [What is ShelfTag?](#what-is-snap)
  - [First-Time Setup](#first-time-setup)
  - [Daily Use](#daily-use)
  - [Tips & Troubleshooting](#tips--troubleshooting)
  - [How Updates Work](#how-updates-work)
- [Engineer Manual](#engineer-manual)
  - [The Business Problem](#the-business-problem)
  - [System Architecture](#system-architecture)
  - [Data Flow](#data-flow)
  - [Tech Stack](#tech-stack)
  - [Project Structure](#project-structure)
  - [Microservice Responsibilities](#microservice-responsibilities)
  - [Airtable Integration](#airtable-integration)
  - [Gemini Flash Lite Extraction](#gemini-flash-lite-extraction)
  - [Offline Architecture](#offline-architecture)
  - [Currency Detection via Geolocation](#currency-detection-via-geolocation)
  - [PWA Behavior & Distribution](#pwa-behavior--distribution)
  - [Security Rules](#security-rules)
  - [Prerequisites & Deployment](#prerequisites--deployment)
  - [Deploying to Cloudflare Workers](#deploying-to-cloudflare-workers)
  - [Phone Camera Access](#phone-camera-access)
- [Architecture Decisions & Rationale](#architecture-decisions--rationale)
  - [Why Gemini Flash Lite (not Claude, GPT-4o, or open-source OCR)](#why-gemini-flash-lite)
  - [Why Cloudflare (not Vercel, AWS, Supabase)](#why-cloudflare)
  - [Why No Image Compression](#why-no-image-compression)
  - [Why Vanilla JS (no React, no build step)](#why-vanilla-js)
  - [Why localStorage + IndexedDB (not browser cache)](#why-localstorage--indexeddb)
- [Known Quirks & Edge Cases](#known-quirks--edge-cases)
- [Open Items / TODOs](#open-items--todos)

---

# User Manual

## What is ShelfTag?

ShelfTag is a camera app on your phone that replaces manual data entry. Instead of writing down product names, prices, and weights and then typing them into Airtable later, you just take photos. ShelfTag reads the photo, pulls out all the information, and puts it directly into Airtable for you.

## First-Time Setup

This takes about 5 minutes.

**1. Open the link on your phone.** You'll receive a URL or QR code from your manager. The current dev URL is `shelftagdev.jonathankim829.workers.dev`. Production should use a custom domain like `app.shelftag.io` (or `shelftag.io`).

**2. Allow camera access.** When the app asks for camera permission, tap "Allow." This is required — the whole app is a camera.

**3. Allow location access (optional).** If prompted for location, tap "Allow." This helps the app detect when you're shopping internationally so it can note the local currency. The app works fine without it.

**4. Add to your Home Screen:**
- **iPhone:** Tap the Share button (square with arrow) → scroll down → tap "Add to Home Screen" → tap "Add"
- **Android:** Chrome will show a banner saying "Add ShelfTag to Home Screen" → tap "Install"
- Now you have a ShelfTag icon on your home screen that opens like a regular app

**5. Enter your name.** Tap the info box near the top-center of the camera view. Type your name in the "Name" field.

**6. Select the retailer.** In the same box, choose from the retailer dropdown list.

**7. You're done.** Your name and retailer are saved automatically. Next time you open the app, they'll still be there.

## Daily Use

1. **Open ShelfTag** from your home screen.
2. **Update the retailer** if you're at a different store than last time. Your name stays the same — just select the correct retailer.
3. **Point your phone at a product** on the shelf. Make sure you can see the product name and brand on the package, the price tag on the shelf below or beside it, and the weight/size on the package.
4. **Tap the white shutter button** to take the photo. You'll see a brief flash — that means it worked.
5. **Keep going.** Take photos of as many products as you need. Each photo is saved automatically.
6. **Photos sync automatically.** When your phone has a good connection (Wi-Fi or cell signal), photos upload in the background. The red number badge in the top-right shows how many photos are waiting to upload. When it disappears, everything is synced.
7. **Check Airtable.** Within a few minutes of syncing, new rows appear in the Store Visits Database with all the product data filled in automatically.

## Tips & Troubleshooting

**Bad signal in a store?** No problem. Photos are saved on your phone and will upload as soon as you get signal again — even if you close the app.

**Changing retailers?** Tap the retailer dropdown in the top info box and select the current store.

**Red badge won't go away?** Make sure you have a good internet connection. The badge shows how many photos are still waiting to upload. If it persists, check that the Cloudflare Worker is running properly.

**Camera shows black screen?** Make sure you allowed camera permission. Check that no other app is using the camera. On iPhone, make sure you're using Safari (Chrome on iOS has limited camera API support for PWAs).

**"Camera permission denied" error?** Go to your phone's Settings → Browser → Camera and enable access. Or clear the site data and reload.

**App not opening?** Try opening the URL in your browser again and re-adding to your home screen.

**Airtable shows no new rows?** Check the Cloudflare Worker logs (via `wrangler tail` or the Cloudflare dashboard) for error messages. Verify your Worker environment variables have valid API keys with the correct scopes.

**App doesn't work offline?** The app must be loaded at least once with a good connection to cache files. After that first load, it works offline. If it still doesn't work, open DevTools → Application → Service Workers and verify the service worker is registered.

**Gemini returns null for fields?** The photo might not clearly show the product name, price tag, or weight. Make sure the photo includes both the product packaging and the shelf price tag. Hold the phone steady to avoid blur.

**App behaving oddly after an update?** Close it completely and reopen it. See below.

## How Updates Work

The app updates itself automatically. When the team pushes a new version, the next time you open ShelfTag it will quietly download the update in the background. You don't need to do anything — no App Store, no update button.

If the app seems stuck on an old version: close it completely, reopen it, and wait a few seconds. If that doesn't work, clear the site data in your browser settings and reload from the URL. As a last resort, remove the home screen icon, revisit the URL, and re-add to home screen.

---

# Engineer Manual

## The Business Problem

180 Snacks is a medium-sized snack manufacturer that sells to Costco, TJX group, and similar retailers. To track competitor pricing, they send field reps to retail stores (Costco, Walmart, Marshalls, Aldi, Food4Less, etc.) to photograph competitor products and record data: product name, brand, price, weight, flavor description, packaging type. This data goes into an Airtable called "Store Visits Database" for competitive pricing analysis.

Currently this is 100% manual — reps take photos, then later sit down and type everything into Airtable by hand. ShelfTag automates this: take a photo, AI extracts the data, row appears in Airtable automatically.

## System Architecture

```
Phone (PWA)                    Backend (Cloudflare Worker)      External APIs
─────────────                  ─────────────────────────        ─────────────
Camera capture                 storage_service
  ↓                              → stores image in R2
IndexedDB queue                    → returns Worker `/uploads/*` URL (R2 proxied)
  ↓ (when online)
POST /api/sync                 gemini_service                  → Google Gemini Flash Lite
  ↓                              → sends image + prompt
                                   → gets structured JSON
                               airtable_service                → Airtable REST API
                                 → creates record with
                                   extracted fields +
                                   image URL + metadata
                               ─────────────────────────
                               Worker orchestrates
                               all three services

Deployed at: shelftagdev.jonathankim829.workers.dev
```

### UI Spec

- Fullscreen camera viewfinder (looks exactly like the native phone camera)
- Top bar: small semi-transparent box with two fields — user's name and retailer selector
- These fields persist via localStorage (survive app close, phone restart, etc.)
- First time opening: fields are empty, user taps to type
- Subsequent opens: fields are pre-filled from last session
- Large circular shutter button centered at the bottom
- Gallery upload icon on the bottom-left (same horizontal axis as shutter + zoom). Opens iOS/Android photo picker for batch queueing with an enforced cap (30 images max) to reduce Safari memory crashes.
- Capture mode toggle on the bottom-right:
  - **Single mode**: shutter immediately queues one photo
  - **Multi mode**: up to 4 images are staged in a tray, then queued together as one sync item
- Red sync badge (top-right) shows count of photos waiting to upload. Tappable — opens queue modal with stats and "Clear Queue" button.
- Green/red connectivity dot (top-left) shows online/offline status
- Camera flash effect on capture for visual feedback
- Toast notification ("Photo captured!") on successful capture
- **Pinch-to-zoom** on the viewfinder: uses hardware zoom via `MediaStreamTrack.applyConstraints()`. Zoom level indicator appears bottom-right, on the same horizontal axis as the shutter button (e.g. "2.5×"). Turns yellow when zoomed — tap to reset to 1×. Hidden on devices that don't support zoom.
- **Tap-to-focus** on the viewfinder: shows a yellow square focus ring (iOS camera style) at the tap point. Attempts hardware refocus via `focusMode` constraint toggle. Visual feedback works on all devices; hardware focus is best-effort.
- Gesture discrimination: single brief tap = focus, two-finger pinch = zoom. Taps on UI elements (inputs, buttons, badges) pass through normally.

## Data Flow

Step by step, what happens when a user takes a photo:

1. User takes photo → full resolution JPEG captured via `getUserMedia` API
2. Photo + metadata (user name, retailer, timestamp MM/DD/YYYY HH:MM, GPS coords) stored in IndexedDB
3. Sync module detects connectivity (`navigator.onLine` + Worker health check ping)
4. When online: POST `{ images_base64, metadata }` to `/api/sync` (single capture still works via legacy `image_base64`)
5. Worker stores image in Cloudflare R2 → constructs a Worker-hosted `/uploads/<file>` URL
6. Worker sends image to Gemini Flash Lite with extraction prompt → gets structured JSON
7. Worker creates Airtable record via REST API with all fields + image URL
8. Airtable downloads the image from the Worker `/uploads/*` URL and stores its own copy
9. Airtable Formula fields (RT/oz, FX NW oz, RT/oz Discounted) compute automatically from the written data
10. Worker acknowledges receipt (success or pipeline failure) → frontend deletes local copy from IndexedDB

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS PWA | No build step, no framework overhead, works offline |
| Backend | Cloudflare Workers | Serverless, scales automatically, free tier, zero cold starts |
| Image storage | Cloudflare R2 | Zero egress fees (critical since Airtable downloads each image) |
| AI extraction | Google Gemini Flash Lite (`gemini-flash-lite-latest`) | Cheapest reliable multimodal LLM (~$0.0001/photo) |
| Database | Airtable (existing) | Already in use by the team, REST API |
| Local persistence | localStorage + IndexedDB | Standard browser APIs, no dependencies |

## Project Structure

```
shelftag/
├── .gitignore
├── package.json                  # Wrangler dev dependency, deploy/dev/tail scripts
├── wrangler.toml                 # Cloudflare Workers config (R2 binding, env vars, asset dir)
│
├── src/
│   └── worker.js                 # Cloudflare Worker: API routes, Gemini extraction, Airtable, R2 image serving
│
├── docs/
│   └── LLM.md                    # Documentation (this file)
│
├── frontend/                     # PWA served by wrangler.toml [assets] directive
│   ├── index.html                # Main PWA page (fullscreen camera UI)
│   ├── manifest.json             # PWA manifest (standalone mode, icons)
│   ├── sw.js                     # Service worker (offline caching, auto-updates)
│   ├── css/
│   │   └── styles.css            # Camera app styles (dark theme, native camera feel)
│   ├── js/
│   │   ├── app.js                # Main: init all modules, UI logic, event handlers
│   │   ├── camera.js             # getUserMedia, viewfinder, full-res photo capture
│   │   ├── storage.js            # IndexedDB (photo queue) + localStorage (user prefs)
│   │   ├── sync.js               # Sync queue: connectivity detection, sequential upload
│   │   └── geo.js                # Geolocation: watchPosition, getCurrentPosition
│   └── icons/
│       ├── icon-192.png          # PWA home screen icon
│       └── icon-512.png          # PWA splash screen icon
```

**Deployed at:** `shelftagdev.jonathankim829.workers.dev`

## Microservice Responsibilities

| Service | File | Responsibility | External Dependency |
|---|---|---|---|
| Gemini Service | `gemini_service` | Image → structured product data | Google Gemini Flash Lite API |
| Storage Service | `storage_service` | Image storage in R2 + public URL construction | Cloudflare R2 |
| Airtable Service | `airtable_service` | Record creation in Airtable | Airtable REST API |
| Orchestrator | Cloudflare Worker | Routes, CORS, pipeline orchestration | Cloudflare Workers runtime |

## Airtable Integration

### Credentials

- **Personal Access Token (PAT):** generated at airtable.com/create/tokens
- **Required scopes:** `data.records:write`, `data.records:read`
- **Base ID:** `app8EiNoHjPoOl7y0`
- **Table ID:** `tblvy7IdKWweV8Jdj`
- All stored as Cloudflare Worker environment variables (via `wrangler secret`) — NEVER in frontend code

### API

`POST https://api.airtable.com/v0/{baseId}/{tableId}` with Bearer token auth. Image attachments are passed as `[{"url": "..."}]` — Airtable downloads and stores its own copy. Field names in the JSON body must EXACTLY match Airtable column names.

### Column Mapping (confirmed from screenshots, left to right)

| Airtable Column | Source | Notes |
|---|---|---|
| **Flavor** | Gemini Flash Lite | Product/flavor name (e.g. "Serenity Trail Mix") |
| **Date of Visit** | App metadata | MM/DD/YYYY format |
| **Image** | R2 URL | Photo attachment |
| **Retailer** | App metadata | User-entered store name from the app |
| **Brand** | Gemini Flash Lite | Manufacturer (e.g. "Southern Grove", "Power Up") |
| **Flavor Description** | Gemini Flash Lite | Comma-separated ingredients from package front |
| **Count** | Gemini Flash Lite | As printed on package (e.g. "16oz", "8ct 1.75oz") |
| **Type** | Gemini Flash Lite | One of: "Single Bag", "Multi Box", "Multi Bag" — visual judgment |
| **NW oz** | Gemini Flash Lite | Total net weight in ounces (number). For multi-packs: count × per-unit weight. |
| **Retail Regular** | Gemini Flash Lite | Shelf price (number, no dollar sign) |
| **Retail Discounted** | Gemini Flash Lite | Discounted/sale price when visible (number, no dollar sign). Null if absent. |
| **RT/oz** | Airtable Formula | = {Retail Regular} / {FX NW oz}. Computed automatically by Airtable — the Worker does NOT write to this field. |
| **RT/oz Discounted** | Airtable Formula | = {Retail Discounted} / {FX NW oz}. Computed automatically by Airtable — the Worker does NOT write to this field. |
| **Notes** | Auto or blank | Blank unless outside US → auto-populated with currency info via geolocation |
| **NW g** | Manual | User fills in Airtable (used for international products with gram-based weights) |
| **FX NW oz** | Airtable Formula | = IF({NW g} = BLANK(), {NW oz}, {NW g} * 0.03527396). Computed automatically by Airtable — the Worker does NOT write to this field. |
| **Category** | Manual | User fills in Airtable |

## Gemini Flash Lite Extraction

### API Details

- **Model:** `gemini-flash-lite-latest` (structured output mode)
- **Endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent`
- **Auth:** API key as query parameter
- **Cost:** Extremely cheap — Flash Lite is the most cost-effective multimodal model in the Gemini lineup. Roughly **$0.0001 per photo** or less (50 photos ≈ half a penny).

### Key Configuration

- `response_mime_type: "application/json"` + JSON schema → forces structured output, guaranteed valid JSON, no parsing failures
- `temperature: 0.1` → consistent factual extraction, not creative
- Image sent as inline base64 data with `mime_type: "image/jpeg"`
- Model returns `null` for fields it can't determine (better than hallucinating)

### Extraction Prompt

Located in `gemini_service.py` (deployed as part of the Cloudflare Worker). Instructs the model to extract: flavor, brand, flavor_description, count, type, nw_oz, retail_regular. Handles multi-packs by computing total weight (count × per-unit weight). Picks the most prominent product if multiple are in frame. Uses regular price if both sale and regular are visible.

### JSON Schema (for structured output mode)

```json
{
  "type": "object",
  "properties": {
    "flavor": { "type": "string", "nullable": true },
    "brand": { "type": "string", "nullable": true },
    "flavor_description": { "type": "string", "nullable": true },
    "count": { "type": "string", "nullable": true },
    "type": { "type": "string", "nullable": true, "enum": ["Single Bag", "Multi Box", "Multi Bag"] },
    "nw_oz": { "type": "number", "nullable": true },
    "retail_regular": { "type": "number", "nullable": true }
  },
  "required": ["flavor", "brand", "flavor_description", "count", "type", "nw_oz", "retail_regular"]
}
```

### Edge Cases Requiring Prompt Iteration

These will surface during real-world testing with store photos:

- **Multi-packs:** Costco boxes containing 24 individual bags — LLM must compute total net weight across all bags, not just read one bag's label. This is the trickiest extraction task.
- **Partially obscured price tags:** common in cluttered shelf displays.
- **Multiple products in frame:** LLM must identify the primary/centered product.
- **International products with gram-only weights:** NW oz conversion needed, or leave for manual entry.
- **Sale price vs regular price:** LLM should use regular price when both are visible.
- **"Overview" rows in Airtable:** some existing rows (1, 6, 16) are section headers, not products. The app should not create these.

## Offline Architecture

The app is designed for stores with poor or no connectivity:

1. **Service worker** caches ALL app files on first load — app opens from local cache with zero network needed.
2. **IndexedDB** stores full-resolution photos + metadata locally. Capacity is typically GB-scale on modern phones.
3. **Sync module** monitors connectivity via `navigator.onLine` + Worker health check ping.
4. When online, sync module drains the queue **sequentially** (one photo at a time to avoid overwhelming the Worker).
5. If connectivity drops mid-sync, it stops and retries when signal returns.
6. A **30-second periodic retry** acts as a safety net.

### Background Sync (iOS — unsolved)

iOS Safari aggressively kills background PWA execution and **does NOT support the Background Sync API (SyncManager)**. There is no reliable way to upload photos from a PWA while the app is backgrounded on iOS.

**What was tried and failed:**
- `visibilitychange` → `hidden` flush: fires all pending uploads when the app goes to background. iOS suspends the PWA before uploads complete.
- Background Sync API (`SyncManager`): not implemented in Safari at all.

**Current approach:** Foreground-only uploads with aggressive retry. When the app returns to foreground, sync resumes immediately. The 30-second periodic timer and `online` event provide additional coverage. Photos queue safely in IndexedDB until the user reopens the app.

**For guaranteed background uploads:** A native app wrapper (WKWebView + URLSession background download/upload tasks) would be needed. This is tracked as an open item.

## Currency Detection via Geolocation

- Geolocation API pings on app open + `watchPosition` for continuous updates
- Worker checks coordinates against US bounding boxes (continental + Alaska + Hawaii)
- If outside US: populates Airtable "Notes" column with `"International (lat: XX.XX, lon: YY.YY) — confirm currency"`
- **Production improvement:** integrate a reverse geocoding API (Google Maps or OpenCage) for exact country → currency mapping
- GPS can be flaky indoors — this is best-effort, app works fine without it
- No reliance on reading currency symbols from price tags (they often aren't there)

## PWA Behavior & Distribution

**Distribution:** No app store needed. Users visit the URL (`shelftagdev.jonathankim829.workers.dev` for dev, or `app.shelftag.io` / `shelftag.io` for production) in their phone browser and tap "Add to Home Screen." Can share via QR code.

**Session behavior:** Tapping the home screen icon reopens the same context, not a new tab. State is restored from localStorage/IndexedDB if the OS kills the process. The `manifest.json` uses `"display": "standalone"` mode.

**Updates:** Service worker caches all app files locally so the app works fully offline after first load. When code is updated on Cloudflare Workers, the service worker detects the change on next app open and pulls new files silently. No user action needed.

## Security Rules

- API keys (Gemini, Airtable) are ONLY stored in Cloudflare Worker environment variables (set via `wrangler secret` or Cloudflare dashboard)
- Frontend NEVER has direct access to any API key
- Phone only talks to the Worker endpoint (`shelftagdev.jonathankim829.workers.dev`)
- R2 bucket is **not required to be public**. Images are served through the Worker route (`/uploads/*`) from the same origin as the API, so Airtable fetches through your domain instead of `*.r2.dev`.
- `.env` files are for local development reference only and are git-ignored

### Image Delivery (Old vs New, Technical Detail)

**Old approach (problematic for production):**
- After `env.IMAGES.put(...)`, the Worker returned attachment URLs like `https://<public-bucket-id>.r2.dev/<filename>`.
- That requires a **public R2 dev domain** (`*.r2.dev`) and bypasses your Worker/domain layer.
- Cloudflare explicitly positions public dev URLs as convenience endpoints, with stricter limits and fewer production guarantees than custom-domain traffic through your zone/Worker.
- Operational downside: image fetch traffic from Airtable goes straight to `r2.dev`, so you lose centralized control (routing, policy, analytics, branding domain, future auth rules) at your Worker edge.

**Current approach (production-safe architecture):**
- Worker still writes raw bytes into R2 via `env.IMAGES.put(...)`.
- Instead of `*.r2.dev`, Worker stores Airtable attachment URLs as `https://<image-base-domain>/uploads/<filename>`.
  - Resolution order in code: `env.IMAGE_BASE_URL` (if set) → fallback to incoming request origin.
- The `/uploads/*` route in `src/worker.js` performs `env.IMAGES.get(key)` and streams bytes back to Airtable.
- Benefits:
  - Works with custom domains (`app.shelftag.io`, etc.).
  - No direct dependency on public `*.r2.dev`.
  - Keeps all client/API/image traffic under your Worker zone and controls.
  - Easier future hardening (WAF rules, signed-token gateway, tighter caching policy).
  - Compatible with clients/integrations that send `HEAD` before `GET` on attachment URLs.

**R2 Public Development URL toggle (`*.r2.dev`):**
- For this Worker-proxy architecture, you can safely **disable** the R2 Public Development URL.
- Disabling it does **not** break Worker `env.IMAGES.put/get` access.
- Keep it enabled only if you still directly reference `https://<bucket>.r2.dev/...` anywhere.

## Prerequisites & Deployment

### Software Requirements

| Software | Version | Purpose |
|---|---|---|
| Node.js | 18+ | Wrangler CLI (Cloudflare Workers tooling) |
| Wrangler | Latest | Cloudflare Workers CLI for deploy, secrets, tail |
| Git | Any recent | Version control |
| Modern browser | Chrome/Safari/Firefox | Testing the PWA |

### API Keys Required

**1. Google Gemini Flash Lite API Key**
- Go to aistudio.google.com/apikey
- Sign in with a Google account
- Click "Create API Key"
- Copy the key

**2. Airtable Personal Access Token (PAT)**
- Go to airtable.com/create/tokens
- Click "Create new token"
- Name it "ShelfTag"
- Add scopes: `data.records:write` and `data.records:read`
- Under "Access", add the "Store Visits Database" base
- Click "Create token" and copy it

## Deploying to Cloudflare Workers

### Initial Setup (already completed)

These steps have already been done and don't need to be repeated:

```bash
cd shelftag
npm install                                    # Installs wrangler
npx wrangler r2 bucket create shelftagprod     # R2 bucket for product images
npx wrangler secret put GEMINI_API_KEY         # Google AI Studio key
npx wrangler secret put AIRTABLE_PAT           # Airtable Personal Access Token
npx wrangler deploy                            # Initial deployment
```

Note: `AIRTABLE_BASE_ID` and `AIRTABLE_TABLE_ID` are set as plain `[vars]` in `wrangler.toml` (not secrets — they're not sensitive).

### Redeploying After Code Changes

Any time you change frontend files (CSS, JS, HTML) or the Worker backend (`src/worker.js`), redeploy with:

```bash
npx wrangler deploy
```

That's it — one command pushes both the Worker code and all `frontend/` static assets together. Changes are live within seconds.

If you update the service worker cache version in `sw.js` (e.g. `shelftag-v15` → `shelftag-v16`), phones will pull the new files on next app open. Bump that cache key any time you change CSS/JS/HTML that the SW caches. Also bump the in-app version label (`APP_VERSION` in `frontend/js/app.js`) every frontend deploy. The cache key format and app label format can differ.

The Worker is live at: `shelftagdev.jonathankim829.workers.dev`

### Move Production to `shelftag.io` (Cloudflare)

Use these exact steps to avoid exposing `*.workers.dev` in production:

1. Add `shelftag.io` to Cloudflare DNS (if not already there) and ensure nameservers are delegated to Cloudflare.
2. In Cloudflare dashboard: **Workers & Pages → shelftagdev (or prod Worker) → Settings → Domains & Routes**.
3. Click **Add Custom Domain** and enter `app.shelftag.io` (recommended) or `shelftag.io` (root).
4. Accept DNS record creation (Cloudflare creates/updates the proxied CNAME/flattened record automatically).
5. Wait for SSL provisioning (usually a few minutes), then verify `https://app.shelftag.io/api/health`.
6. Update any shared QR codes/links to the new domain.
7. Optional but recommended: keep `workers.dev` enabled for emergency fallback only.
8. For this repository, set production Worker `name` separately (e.g., `shelftagprod`) and deploy that environment so dev/prod URLs stay isolated.

### Test + Production Environment Mapping (recommended for your setup)

You mentioned you maintain full duplicates (test + prod): Worker URL, R2 bucket, Gemini key, Airtable base/table, and domains. Use this mapping:

1. **Test environment**
   - Worker hostname: `shelftagtest.jonathankim829.workers.dev` (or current test worker)
   - Custom domain: `test.shelftag.io`
   - R2 bucket: `shelftag-images-test`
   - Secrets: test Gemini key + test Airtable PAT
   - Airtable vars: test base/table IDs
2. **Production environment**
   - Worker hostname: `shelftagprod.jonathankim829.workers.dev` (internal fallback only)
   - Custom domain: `app.shelftag.io` (or `shelftag.io`)
   - R2 bucket: `shelftag-images-prod`
   - Secrets: prod Gemini key + prod Airtable PAT
   - Airtable vars: prod base/table IDs

**Cloudflare steps for each environment (repeat for test, then prod):**
1. Workers & Pages → select the target Worker/environment.
2. Settings → Domains & Routes → Add Custom Domain.
3. Set test to `test.shelftag.io`, set prod to `app.shelftag.io` (or apex).
4. Confirm proxied DNS record creation in Cloudflare DNS.
5. Wait for certificate issuance.
6. Verify health:
   - `https://test.shelftag.io/api/health` (test)
   - `https://app.shelftag.io/api/health` (prod)
7. Confirm one end-to-end sync in each environment and verify Airtable rows land in the matching base (test vs prod).

### Testing

1. Open `shelftagdev.jonathankim829.workers.dev` on your phone
2. Allow camera access when prompted
3. Enter your name and select a retailer
4. Point the camera at a snack product and tap the shutter button
5. Check `wrangler tail` for logs showing image stored → Gemini extraction → Airtable record created
6. Check Airtable — a new row should appear with all fields populated

### Monitoring

- **Live logs:** `wrangler tail` streams real-time Worker logs
- **Dashboard:** Cloudflare dashboard → Workers & Pages → shelftag → Logs
- **R2 storage:** Cloudflare dashboard → R2 → shelftagprod bucket

## Phone Camera Access

Cloudflare Workers serve over HTTPS by default, so camera access works on all phones without any special configuration. No need for `chrome://flags` hacks or self-signed certificates.

### Cloudflare Pricing

Free tier covers this use case entirely: Workers (100k requests/day), R2 (10GB storage, 10M reads/month, 1M writes/month, zero egress). If scaling: Workers Pro = $5/month for 10M requests, R2 beyond free = $0.015/GB/month storage. Zero egress on R2 is critical since Airtable downloads every image.

---

# Architecture Decisions & Rationale

This section exists so that future engineers and LLM instances understand *why* things are the way they are. These decisions were made through deliberate back-and-forth discussion and should not be changed without understanding the reasoning.

## Why Gemini Flash Lite

**Rejected alternatives and why:**

- **Claude / GPT-4o:** More expensive for no quality gain on this specific task. The extraction is straightforward (read text off a package, identify a price tag) — it doesn't need frontier-model reasoning. Jonathan also pushed back on the initial recommendation of Claude Vision due to potential bias toward Anthropic's own products, which led to an open evaluation of all options.
- **Gemini 2.0 Flash (full):** Overkill for this task. Flash Lite (`gemini-flash-lite-latest`) handles the extraction just as well at lower cost. The task is reading text and prices from product photos — doesn't need the extra capability of full Flash.
- **Open-source OCR (Tesseract, PaddleOCR):** These only extract raw text. They cannot understand context — which text is the brand vs the flavor vs the ingredients. They cannot judge whether a product is a single bag or a multi-pack. They cannot identify which of several price tags belongs to which product. The extraction task requires multimodal understanding, not just character recognition.
- **Why Gemini Flash Lite wins:** Multimodal (understands images natively), structured output mode (guaranteed valid JSON — no parsing failures), extremely cheap (~$0.0001/photo, 50 photos for half a penny). The structured output mode is the key differentiator — instead of hoping the model formats its response correctly, you tell the API "respond as JSON matching this exact schema" and Gemini enforces it at the model level.

## Why Cloudflare

**Rejected alternatives and why:**

- **Vercel / AWS / Supabase:** All charge egress fees. Since Airtable downloads every image from our storage, egress costs would add up. R2's zero egress is the deciding factor.
- **Local FastAPI prototype first:** Considered and rejected — going straight to Cloudflare Workers avoids the complexity of maintaining two deployment targets and translating Python services to Worker-compatible code later. The Worker runtime is production from day one.
- **Why Cloudflare wins:** R2 has zero egress fees. Workers + R2 are in one ecosystem. Free tier covers the entire use case. HTTPS out of the box (critical for camera access on phones). Already deployed at `shelftagdev.jonathankim829.workers.dev`.

## Why No Image Compression

This was explicitly debated and decided:

- JPEG compression is lossy and irreversible — you cannot "decompress" a JPEG to get the original quality back. (Jonathan initially suggested compressing for upload then "decompressing" on the backend — this was clarified as not possible.)
- Accuracy of AI extraction is the priority. A lower-quality image risks the model misreading a price tag, misspelling a brand name, or failing to identify multi-pack details.
- Compression will ONLY be revisited if upload speeds become a real problem in practice.
- If revisited: an empirical quality sweep must be run first — test Gemini Flash Lite extraction accuracy at various resolutions and JPEG quality levels before locking in any settings. Do NOT sacrifice extraction quality to save storage or bandwidth.

## Why Vanilla JS

No React, Vue, or any framework. No build step (no webpack, vite, etc.).

- The frontend is a camera viewfinder with two text fields, a button, and a sync badge. It doesn't need component libraries or state management.
- No build step means the service worker caches exactly what's on disk — no compilation artifacts, no source maps, no cache-busting complexity.
- Any engineer can read the code without knowing a framework.

## Why localStorage + IndexedDB

Jonathan initially asked why we don't just use "browser cache." The distinction:

- **Browser cache** is controlled by the browser's eviction policies — the browser can delete cached data whenever it needs space, and you can't store structured data in it. It's for HTTP response caching, not application state.
- **localStorage** is a simple key-value store that persists until explicitly cleared. Perfect for user preferences (name, retailer). Survives app close, phone restart, browser updates. ~5MB limit, which is fine for two text fields.
- **IndexedDB** is a full database in the browser. Stores structured data and binary blobs (like full-resolution photos). Capacity is typically GB-scale. Perfect for the offline photo queue.

---

# Known Quirks & Edge Cases

**"FX NW oz" is a Formula field:** FX NW oz is an Airtable Formula column: `IF({NW g} = BLANK(), {NW oz}, {NW g} * 0.03527396)`. It normalizes weight to ounces whether the source value is in oz or grams. The Worker does not write to this field.

**iPhone + Chrome PWA limitation:** Chrome on iOS has limited `getUserMedia` support for PWAs. Field reps using iPhones should use Safari.

**GPS indoors:** Geolocation can be flaky inside stores. Currency detection is best-effort — the app works fine without GPS. The primary use is simply detecting whether the user is outside the US.

**Airtable "overview" rows:** Some existing rows in the Airtable (rows 1, 6, 16 in screenshots) appear to be section headers, not product entries. The app should not create these — they're manually managed.

**Airtable image download timing:** When the Worker creates a record with an image URL, Airtable asynchronously downloads the image from the Worker `/uploads/*` route, which streams bytes from R2. This avoids direct dependency on public `*.r2.dev` endpoints.

**Service worker update behavior:** ShelfTag now sends `SKIP_WAITING` to newly installed workers and reloads on `controllerchange`, so new deployments should activate on the next open/reload instead of requiring multiple full app closes. Still bump `CACHE_VERSION` in `sw.js` whenever frontend assets change.

**Version display + bump rule:** The UI shows an explicit version under the top-left status indicator (format `v##.##`; current code value is `v01.10`). Bump this label for frontend behavior changes, and also bump `CACHE_VERSION` in `sw.js` in the same deploy. The two values can use different formats.

**Gallery upload memory guardrail:** iOS Safari PWAs can crash under high in-memory image loads. Keep batch uploads capped and process gallery files sequentially (never decode dozens of full-res photos in parallel). Current cap: 30 selected images per batch.

**Airtable PAT truncation:** Airtable PATs are long (60+ characters). If `wrangler secret put AIRTABLE_PAT` results in 401 errors, the token was likely pasted incorrectly or truncated. Regenerate at airtable.com/create/tokens and re-enter.

**IndexedDB stuck photos:** If the app is closed mid-upload (user locks phone, browser kills tab), photos get stuck as 'syncing' in IndexedDB and never clear. The sync module calls `resetStuckPhotos()` at the start of each cycle to recover these. Photos that fail 5 times are auto-deleted. When debugging, clearing site data on the phone flushes the entire IndexedDB.

**Gemini returns nulls for non-product photos:** This is correct behavior. The extraction prompt says "if you cannot determine a field, set it to null." When tested with photos of fingers, Gemini correctly returned all nulls. Real snack product photos with visible packaging and price tags will populate the fields.

**R2 custom metadata:** Each image stored in R2 includes custom metadata (user_name, retailer, timestamp, lat/lon) for debugging. This is separate from the Airtable record — if Airtable creation fails, the metadata is still recoverable from R2.

**Sync badge behavior:** The badge counts only 'pending' photos (not 'syncing'). This means the count drops the moment upload begins, matching what appears in Cloudflare. Badge is always visible: green "0" when all synced, red with count when photos are waiting, orange pulse when actively uploading.

**Phone → Worker → IndexedDB deletion policy:** Photos are deleted from IndexedDB as soon as the Worker returns ANY HTTP response (even if Gemini or Airtable failed downstream). The image is safely in R2 at that point. Only true network failures (no response received) keep the photo for retry. This prevents the infinite re-upload loop that occurs when Airtable is misconfigured.

**Zoom values are raw hardware values, not Apple-style labels:** The zoom indicator shows the raw value from `MediaStreamTrack.getSettings().zoom`. On iPhones with ultra-wide lenses, hardware `1.0` is NOT the same as Apple's "1×" — Apple maps hardware `2.0` to their "1×". ShelfTag intentionally ignores this mapping and shows raw values. Reset always goes to hardware `1.0`. **LLM NOTE:** A previous iteration tried to reverse-engineer Apple's zoom mapping (`defaultZoom = 2.0`, `displayZoom = hardware / defaultZoom`) to match the native camera app's labels. This broke repeatedly because `applyConstraints({ zoom })` behaves inconsistently across iOS versions, and the mapping logic created confusing display values (e.g. "0.5×" when the user expected "1.0×"). The simple approach — raw hardware values, reset to 1.0 — is the correct choice. Do not re-add display zoom mapping.

**Tap-to-focus is best-effort:** The app now attempts multiple hardware focus strategies in order: ImageCapture point-of-interest focus, MediaTrack constraint-based point-of-interest/single-shot focus, then fallback autofocus refresh toggles. Safari/iOS still does not reliably expose true point-of-interest focus on all devices, so behavior varies by hardware/browser build.

**iOS background uploads are unsolved:** Safari does not support Background Sync API. The `visibilitychange` flush approach was tested but iOS suspends the PWA before uploads complete. The app currently relies on foreground-only sync — photos queue in IndexedDB and upload when the user reopens the app. This works fine for typical use (field reps open the app, take photos, close it, reopen later), but photos won't upload while the app is in the background.

---