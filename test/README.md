# Test Content for Local CDN Simulation

Each subdirectory (`cdna/`, `cdnb/`, `cdnc/`) acts as a separate fake CDN origin.
Place identical CMAF-packaged content in each directory so the steering system
can switch between them.

## Quick Start

```bash
# 1. Build the project
npm run bootstrap

# 2. Start all services (main-steering, edge-steering, sandbox)
npm run dev

# 3. Open http://localhost:5555
```

## Using the Sandbox

### Step 1: Register the edge fleet

The main-steering needs to know about the edge instance to propagate commands.
In the right panel under **Fleet**, click **Register** (defaults: cloudflare,
us-east, `http://localhost:3077`). Without this, priority/exclude commands won't
reach the edge.

### Step 2: Apply & Play

Click **Apply & Play** in the left panel. This runs the full pipeline:

1. POSTs CDN providers to main-steering (hot-swap)
2. Calls `/session/init` — gets a `ManifestUpdateRequest` with priorities + encoded `_ss` state
3. Fetches the source manifest (e.g., `master.m3u8`) from the primary CDN directory
4. Transforms it via the manifest-updater WASM bridge — injects `#EXT-X-CONTENT-STEERING`
   with `SERVER-URI` pointing to the edge steering proxy, clones all variants with
   `PATHWAY-ID="cdn-a"`, `PATHWAY-ID="cdn-b"`, `PATHWAY-ID="cdn-c"`
5. Creates a blob URL and feeds it to hls.js/dash.js — playback starts from cdn-a (default)

### Step 3: Steer to a different CDN

In the right panel under **Priorities**, change the order (e.g., `cdn-b,cdn-a,cdn-c`)
and click **Set Priorities**. This:

1. Main-steering increments the generation counter
2. Fans the command out to the edge fleet via `POST /control`
3. Edge stores the override
4. On the next steering poll (default TTL 300s, or 10s during QoE events),
   hls.js asks `/steer/hls?_ss=...&_HLS_pathway=cdn-a`
5. Edge returns `PATHWAY-PRIORITY: ["cdn-b","cdn-a","cdn-c"]`
6. hls.js switches to the cdn-b pathway — segments now load from `/test/cdnb/`

### Step 4: Exclude a CDN (disaster recovery)

Under **Exclude / Clear**, enter a pathway (e.g., `cdn-a`) and click **Exclude**.
The edge will remove that CDN from rotation — the player switches to the next
available pathway.

### Step 5: Clear overrides

Click **Clear All** to reset all overrides. Edge reverts to the original
contract-weighted priorities.

## How the Steering Loop Works

```
┌──────────┐  1. initial manifest    ┌────────────────┐
│  Player  │ ◀──────────────────────  │ Sandbox Server │
│ (hls.js) │                          │   (:5555)      │
│          │  2. poll SERVER-URI      │                │
│          │ ──────────────────────▶  │ /steer/hls     │ ──▶ edge-steering (:3077)
│          │                          │                │
│          │  3. PATHWAY-PRIORITY     │                │
│          │ ◀──────────────────────  │                │
│          │                          └────────────────┘
│          │  4. fetch segments from
│          │     new pathway CDN
│          │ ──────────────────────▶  /test/cdnb/seg-*.m4s
└──────────┘
```

The sandbox proxy routes both `/api/steer/*` (initial UI requests) and
`/steer/*` (RELOAD-URI follow-ups from the edge) to edge-steering. The edge
uses `BASE_PATH="/steer"` for RELOAD-URIs, so the player resolves them against
the sandbox origin.

## Other Controls

| Control | Where | What it does |
|---------|-------|--------------|
| **Protocol toggle** | Left panel | Switch between HLS (hls.js) and DASH (dash.js) |
| **Manifest Path** | Left panel | Filename to fetch from CDN dir (default: `master.m3u8` / `manifest.mpd`) |
| **Fleet** | Right panel | Register/deregister edge instances |
| **Contracts** | Right panel | Set CDN commit volumes and track usage |
| **Edge Control** | Right panel | Send raw `ControlCommand` JSON directly to edge |
| **Encode/Decode** | Right panel | Inspect `_ss` session state (base64url ↔ JSON) |
| **System Status** | Right panel | Live generation counter, providers, fleet, contracts |

## Packaging Big Buck Bunny as CMAF

### Option 1: ffmpeg

```bash
# Download source
curl -O https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4

# Package as CMAF with multiple bitrates (HLS + DASH)
ffmpeg -i BigBuckBunny_320x180.mp4 \
  -map 0:v -map 0:v -map 0:a \
  -c:v:0 libx264 -b:v:0 800k -s:v:0 640x360 \
  -c:v:1 libx264 -b:v:1 1500k -s:v:1 1280x720 \
  -c:a aac -b:a 128k \
  -f dash \
  -seg_duration 4 \
  -init_seg_name 'init-$RepresentationID$.m4s' \
  -media_seg_name 'seg-$RepresentationID$-$Number$.m4s' \
  -use_template 1 -use_timeline 0 \
  -adaptation_sets "id=0,streams=v id=1,streams=a" \
  -hls_playlist 1 \
  manifest.mpd

# Copy to each CDN directory
for cdn in cdna cdnb cdnc; do
  cp -r *.mpd *.m3u8 *.m4s "$cdn/"
done
```

### Option 2: Shaka Packager

```bash
packager \
  'in=BigBuckBunny.mp4,stream=video,init_segment=init-v.m4s,segment_template=seg-v-$Number$.m4s' \
  'in=BigBuckBunny.mp4,stream=audio,init_segment=init-a.m4s,segment_template=seg-a-$Number$.m4s' \
  --mpd_output manifest.mpd \
  --hls_master_playlist_output manifest.m3u8 \
  --segment_duration 4

for cdn in cdna cdnb cdnc; do
  cp -r *.mpd *.m3u8 *.m4s "$cdn/"
done
```

## Directory Structure

After packaging with ffmpeg `-f dash -hls_playlist 1`, each CDN directory will contain:

```
test/cdna/
  manifest.mpd          # DASH manifest
  master.m3u8           # HLS master playlist
  media_0.m3u8          # HLS media playlist (video track 0)
  media_1.m3u8          # HLS media playlist (video track 1)
  media_2.m3u8          # HLS media playlist (audio)
  init-0.m4s            # CMAF init segments
  init-1.m4s
  init-2.m4s
  seg-0-1.m4s           # CMAF media segments
  seg-0-2.m4s
  ...
test/cdnb/
  (same files)
test/cdnc/
  (same files)
```

The sandbox UI defaults:
- HLS manifest path: `master.m3u8`
- DASH manifest path: `manifest.mpd`

The sandbox UI pre-configures these as:
- `cdn-a` → `http://localhost:5555/test/cdna`
- `cdn-b` → `http://localhost:5555/test/cdnb`
- `cdn-c` → `http://localhost:5555/test/cdnc`

## Troubleshooting

**404 on manifest**: Check the "Manifest Path" field in the left panel matches
the actual filename in your CDN directory (e.g., `master.m3u8` not `manifest.m3u8`).

**Steering not switching CDNs**: Make sure you've registered the edge fleet first
(right panel → Fleet → Register). Without fleet registration, priority commands
don't reach the edge.

**Set Priorities returns empty results**: The `propagateCommand` fans out to all
fleet instances matching the region. If no fleet instances exist, the result is empty.
Register at least one edge instance first.

**Generation counter / stale commands**: The edge uses a monotonic generation counter.
If you reset the edge (`Reset Edge` button) but main-steering's generation is already
high, subsequent low-generation direct edge commands will be rejected. Use main-steering
controls (Priorities/Exclude/Clear) which auto-increment the generation, or reset
everything by restarting `npm run dev`.
