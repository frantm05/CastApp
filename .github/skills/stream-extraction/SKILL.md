---
name: stream-extraction
description: Stream detection and extraction from WebView. Use when working on injectedScript.ts, BrowserScreen.tsx, or adding support for new streaming sites.
---

## Stream Extraction — CastApp

### How extraction works
1. `EARLY_HOOKS_JS` — injected BEFORE page loads, hooks `XMLHttpRequest.open`, `fetch`, and `HTMLMediaElement.src` to intercept stream URLs
2. `INJECTED_JS` — injected AFTER page loads, scans existing `<video>`, `<source>`, `<iframe>` elements
3. All captures call `window.ReactNativeWebView.postMessage(JSON.stringify({type: 'STREAM_FOUND', url, source}))`
4. `BrowserScreen` listens in `handleMessage`, deduplicates via `addStream()` in Zustand

### Stream types detected
- `.m3u8` → HLS (most common for live/VOD sites)
- `.mp4` → Direct MP4 (downloadable videos)
- `.mpd` → DASH (partially supported)
- XHR/fetch network requests intercepted at JS level

### Ad blocking
`AD_BLOCK_PATTERNS` in BrowserScreen blocks navigation to known ad domains BEFORE they load. Add new patterns to this array.

### Referer handling
When navigating into an iframe player, set `refererHeader` to the parent page URL so the player doesn't reject the request. This is handled by `setRefererHeader(url)` before changing `url` state.

### Rules when modifying extraction
- Never break the `EARLY_HOOKS_JS` / `INJECTED_JS` split — early hooks MUST run before content loads
- `injectedJavaScriptForMainFrameOnly={true}` — only inject into main frame (not sub-iframes directly)
- `injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}` — EARLY hooks run in all frames
- All messages from WebView must be valid JSON — wrap in try/catch
- Stream URLs must start with `http://` or `https://` — filter out blob: and data: URLs

### Adding a new site extractor
1. Identify the stream URL pattern (use browser devtools Network tab)
2. If XHR/fetch hook already captures it → no code change needed
3. If player uses blob URLs or MSE → add site-specific logic in INJECTED_JS
4. Test by checking the extracted streams bar in BrowserScreen