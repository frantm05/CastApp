/**
 * Local HTTP Stream Proxy
 *
 * Runs a lightweight HTTP server on the phone that proxies stream requests
 * to the actual CDN with correct headers (Referer, User-Agent, etc.).
 *
 * For HLS streams: instead of sending the m3u8 playlist to the TV (which
 * most DLNA TVs don't understand), we parse the playlist, download each
 * .ts segment ourselves, and stream them as one continuous MPEG-TS to the TV.
 * This works because .ts segments are MPEG Transport Stream chunks that
 * concatenate cleanly into a valid stream.
 */

import TcpSocket from 'react-native-tcp-socket';
import * as Network from 'expo-network';
import { DeviceEventEmitter } from 'react-native';

const TAG = '[StreamProxy]';
const PROXY_PORT = 8765;
const MAX_PORT_RETRIES = 5;

interface ProxyRoute {
  targetUrl: string;
  referer: string;
  origin: string;
  isHLS?: boolean;
  seekOffset?: number;
  variantUrl?: string;
}

interface HLSSegment {
  url: string;
  duration: number;
}

export interface QualityOption {
  bandwidth: number;
  width?: number;
  height?: number;
  url: string;
  label: string;
}

/** Track active HLS streaming sessions so we can stop them */
let activeHLSAbort: AbortController | null = null;

let server: ReturnType<typeof TcpSocket.createServer> | null = null;
let currentPort: number = PROXY_PORT;
let localIP: string = '0.0.0.0';
let routes: Map<string, ProxyRoute> = new Map();
let routeCounter = 0;
let lastParsedTotalDuration = 0;

/**
 * Get the local WiFi IP address of the phone.
 * Uses expo-network (native API) as primary method, TCP socket as fallback.
 */
async function getLocalIP(targetHost?: string): Promise<string> {
  // Primary: expo-network (most reliable on Android)
  try {
    const ip = await Network.getIpAddressAsync();
    console.log(`${TAG} expo-network IP: ${ip}`);
    if (ip && ip !== '0.0.0.0' && ip !== '::') {
      return ip;
    }
  } catch (e) {
    console.log(`${TAG} expo-network failed:`, e);
  }

  // Fallback: TCP socket connection to known-reachable host
  const hosts = [
    ...(targetHost ? [targetHost] : []),
    '192.168.0.1',
    '8.8.8.8',
  ];

  for (const host of hosts) {
    try {
      const ip = await new Promise<string | null>((resolve) => {
        console.log(`${TAG} Trying IP detection via TCP to ${host}`);
        const sock = TcpSocket.createConnection({ host, port: 80 }, () => {
          try {
            const addr = sock.address() as { address?: string };
            const a = addr?.address;
            console.log(`${TAG} Socket addr from ${host}:`, JSON.stringify(addr));
            sock.destroy();
            resolve(a && a !== '0.0.0.0' && a !== '::' ? a : null);
          } catch {
            sock.destroy();
            resolve(null);
          }
        });
        const t = setTimeout(() => { sock.destroy(); resolve(null); }, 2000);
        sock.on('error', () => { clearTimeout(t); sock.destroy(); resolve(null); });
        sock.on('connect', () => clearTimeout(t));
      });
      if (ip) return ip;
    } catch {
      // continue
    }
  }

  console.log(`${TAG} All IP detection methods failed`);
  return '0.0.0.0';
}

// ──────────────────────────────────────────────
// Utility helpers
// ──────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveUrl(url: string, base: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  try {
    const baseObj = new URL(base);
    if (url.startsWith('/')) {
      return `${baseObj.protocol}//${baseObj.host}${url}`;
    }
    const basePath = baseObj.pathname.substring(0, baseObj.pathname.lastIndexOf('/') + 1);
    return `${baseObj.protocol}//${baseObj.host}${basePath}${url}`;
  } catch {
    return url;
  }
}

function parseHttpRequest(data: string): { method: string; path: string } | null {
  const firstLine = data.split('\r\n')[0] || data.split('\n')[0];
  const parts = firstLine.split(' ');
  if (parts.length < 2) return null;
  return { method: parts[0], path: parts[1] };
}

function parseRangeHeader(data: string): string | null {
  const match = data.match(/Range:\s*(.+)/i);
  return match ? match[1].trim() : null;
}

/**
 * Register a stream URL and get back a local proxy URL the TV can access.
 * For HLS streams, we'll serve continuous MPEG-TS so the URL ends in .ts
 */
export function registerStream(targetUrl: string, pageUrl: string, variantUrl?: string): string {
  routeCounter++;
  const isHLS = /\.m3u8/i.test(targetUrl);
  const routeId = `s${routeCounter}`;
  const ext = isHLS ? 'ts' : /\.mpd/i.test(targetUrl) ? 'mpd' : 'mp4';
  const path = `/${routeId}/stream.${ext}`;

  let origin = '';
  let referer = pageUrl;
  try {
    const u = new URL(pageUrl);
    origin = u.origin;
    referer = pageUrl;
  } catch { /* keep as-is */ }

  routes.set(path, { targetUrl, referer, origin, isHLS, variantUrl });
  console.log(`${TAG} Registered route ${path} → ${targetUrl.substring(0, 80)}... (HLS: ${isHLS})`);

  const proxyUrl = `http://${localIP}:${currentPort}${path}`;
  return proxyUrl;
}

/**
 * Build fetch headers with proper Referer/User-Agent.
 */
function buildHeaders(route: ProxyRoute): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  if (route.referer) headers['Referer'] = route.referer;
  if (route.origin) headers['Origin'] = route.origin;
  return headers;
}

/**
 * Fetch an m3u8 playlist and parse out segment URLs.
 * If it's a master playlist (contains variant streams), resolve the best variant first.
 */
async function resolveHLSSegments(
  m3u8Url: string,
  route: ProxyRoute,
  signal: AbortSignal
): Promise<{ segments: HLSSegment[]; isLive: boolean; nextReloadMs: number; totalDuration: number }> {
  const headers = buildHeaders(route);
  const resp = await fetch(m3u8Url, { headers, signal, redirect: 'follow' });
  if (!resp.ok) throw new Error(`m3u8 fetch failed: ${resp.status}`);
  const body = await resp.text();
  console.log(`${TAG} m3u8 (${body.length} bytes) from ${m3u8Url.substring(0, 80)}`);

  // Master playlist: pick user-selected variant or best quality
  if (body.includes('#EXT-X-STREAM-INF')) {
    const variantUrl = route.variantUrl || selectBestVariant(body, m3u8Url);
    console.log(`${TAG} Using variant: ${variantUrl.substring(0, 80)}`);
    return resolveHLSSegments(variantUrl, route, signal);
  }

  // Parse media playlist with segment durations
  const lines = body.split('\n').map(l => l.trim());
  const segments: HLSSegment[] = [];
  let targetDuration = 6;
  let lastExtinf = 0;
  const isLive = !body.includes('#EXT-X-ENDLIST');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseInt(line.split(':')[1], 10) || 6;
    }
    if (line.startsWith('#EXTINF:')) {
      lastExtinf = parseFloat(line.split(':')[1].split(',')[0]) || 0;
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    segments.push({ url: resolveUrl(line, m3u8Url), duration: lastExtinf || targetDuration });
    lastExtinf = 0;
  }

  const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);
  console.log(`${TAG} Parsed ${segments.length} segments, ${totalDuration.toFixed(0)}s total, live=${isLive}`);

  return { segments, isLive, nextReloadMs: targetDuration * 1000, totalDuration };
}

/**
 * Select the best quality variant from a master playlist.
 */
function selectBestVariant(masterBody: string, masterUrl: string): string {
  const lines = masterBody.split('\n').map(l => l.trim());
  let bestBandwidth = 0;
  let bestUrl = '';

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      // Next non-empty, non-comment line is the URL
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith('#')) {
          if (bandwidth > bestBandwidth) {
            bestBandwidth = bandwidth;
            bestUrl = lines[j];
          }
          break;
        }
      }
    }
  }

  if (!bestUrl) {
    // Fallback: first non-comment line after any STREAM-INF
    for (const line of lines) {
      if (line && !line.startsWith('#')) {
        bestUrl = line;
        break;
      }
    }
  }

  return resolveUrl(bestUrl, masterUrl);
}

/**
 * Parse all variants from a master playlist for quality selection.
 */
function parseVariants(masterBody: string, masterUrl: string): QualityOption[] {
  const lines = masterBody.split('\n').map(l => l.trim());
  const variants: QualityOption[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const resMatch = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
      const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      const width = resMatch ? parseInt(resMatch[1], 10) : undefined;
      const height = resMatch ? parseInt(resMatch[2], 10) : undefined;

      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith('#')) {
          const label = height ? `${height}p` : `${Math.round(bandwidth / 1000)}k`;
          variants.push({ bandwidth, width, height, url: resolveUrl(lines[j], masterUrl), label });
          break;
        }
      }
    }
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants;
}

/**
 * Fetch a single .ts segment and return it as Uint8Array.
 */
async function fetchSegment(url: string, route: ProxyRoute, signal: AbortSignal): Promise<Uint8Array> {
  const headers = buildHeaders(route);
  const resp = await fetch(url, { headers, signal, redirect: 'follow' });
  if (!resp.ok) throw new Error(`Segment fetch failed: ${resp.status} for ${url.substring(0, 60)}`);
  const buf = await resp.arrayBuffer();
  return new Uint8Array(buf);
}

async function fetchSegmentWithRetry(url: string, route: ProxyRoute, signal: AbortSignal, maxRetries = 3): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetchSegment(url, route, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      if (attempt === maxRetries) throw err;
      console.log(`${TAG} Segment retry ${attempt}/${maxRetries}: ${(err as Error).message}`);
      await delay(1000 * attempt);
    }
  }
  throw new Error('unreachable');
}

/**
 * Stream HLS as continuous MPEG-TS to the TV socket.
 * 
 * For VOD: fetches all segments sequentially and pipes them.
 * For Live: keeps polling the playlist for new segments and pipes them.
 */
async function streamHLStoSocket(
  socket: ReturnType<typeof TcpSocket.createConnection>,
  route: ProxyRoute
): Promise<void> {
  if (activeHLSAbort) activeHLSAbort.abort();
  activeHLSAbort = new AbortController();
  const signal = activeHLSAbort.signal;

  let socketAlive = true;
  socket.on('error', () => { socketAlive = false; });
  socket.on('close', () => { socketAlive = false; });

  // Consume seek offset
  const seekSeconds = route.seekOffset ?? 0;
  route.seekOffset = undefined;

  try {
    const header = [
      'HTTP/1.1 200 OK',
      'Content-Type: video/mp2t',
      'Transfer-Encoding: chunked',
      'Connection: keep-alive',
      'Access-Control-Allow-Origin: *',
      '',
      '',
    ].join('\r\n');
    socket.write(header);

    const sentSegments = new Set<string>();
    let isLive = true;
    let iterations = 0;
    const MAX_LIVE_ITERATIONS = 7200;
    let consecutiveEmptyPolls = 0;

    // Seek: track cumulative time to skip segments
    let seekSkipDone = seekSeconds <= 0;
    let cumulativeSkipTime = 0;

    while (socketAlive && !signal.aborted && iterations < MAX_LIVE_ITERATIONS) {
      iterations++;
      let result: { segments: HLSSegment[]; isLive: boolean; nextReloadMs: number; totalDuration: number };
      try {
        result = await resolveHLSSegments(route.targetUrl, route, signal);
      } catch (err) {
        if (signal.aborted || !socketAlive) break;
        console.log(`${TAG} Playlist fetch error, retrying in 3s:`, err);
        await delay(3000);
        continue;
      }

      isLive = result.isLive;
      lastParsedTotalDuration = result.totalDuration;
      let newSegments = 0;

      for (const seg of result.segments) {
        if (signal.aborted || !socketAlive) break;
        if (sentSegments.has(seg.url)) continue;

        // Seek: skip segments before target time
        if (!seekSkipDone) {
          cumulativeSkipTime += seg.duration;
          if (cumulativeSkipTime < seekSeconds) {
            sentSegments.add(seg.url);
            continue;
          }
          seekSkipDone = true;
          console.log(`${TAG} Seek: skipped to ${cumulativeSkipTime.toFixed(1)}s (target ${seekSeconds}s)`);
        }

        try {
          const data = await fetchSegmentWithRetry(seg.url, route, signal);
          if (!socketAlive || signal.aborted) break;

          const sizeHex = data.length.toString(16);
          socket.write(`${sizeHex}\r\n`);
          socket.write(uint8ToBase64(data), 'base64');
          socket.write('\r\n');

          sentSegments.add(seg.url);
          newSegments++;
          console.log(`${TAG} Streamed segment ${sentSegments.size} (${data.length} bytes)`);
        } catch (err) {
          if (signal.aborted || !socketAlive) break;
          console.log(`${TAG} Segment failed after retries:`, (err as Error).message);
          sentSegments.add(seg.url); // mark to avoid infinite retry
        }
      }

      if (!isLive && newSegments === 0) {
        console.log(`${TAG} VOD complete. Sent ${sentSegments.size} segments.`);
        break;
      }

      if (isLive) {
        if (newSegments === 0) {
          consecutiveEmptyPolls++;
          if (consecutiveEmptyPolls >= 3) {
            console.log(`${TAG} Warning: ${consecutiveEmptyPolls} consecutive empty playlist polls`);
          }
          if (consecutiveEmptyPolls >= 5) {
            console.log(`${TAG} HLS playlist stale — aborting, signalling re-cast`);
            DeviceEventEmitter.emit('streamProxy:stale');
            break;
          }
        } else {
          consecutiveEmptyPolls = 0;
        }
        await delay(newSegments === 0 ? result.nextReloadMs / 2 : result.nextReloadMs);
      }
    }

    if (socketAlive) {
      try {
        socket.write('0\r\n\r\n');
      } catch { /* socket may already be closed */ }
    }
  } catch (err) {
    console.log(`${TAG} HLS stream error:`, err);
  } finally {
    if (!socketAlive && !signal.aborted) {
      console.log(`${TAG} Socket died while stream active — emitting disconnect`);
      DeviceEventEmitter.emit('streamProxy:socketLost');
    }
    try { socket.destroy(); } catch { /* ignore */ }
    console.log(`${TAG} HLS streaming session ended`);
  }
}

/**
 * Handle an incoming request from the TV.
 */
async function handleRequest(socket: ReturnType<typeof TcpSocket.createConnection>, rawData: string): Promise<void> {
  const req = parseHttpRequest(rawData);
  if (!req) {
    sendResponse(socket, 400, 'Bad Request', 'text/plain', 'Invalid request');
    return;
  }

  console.log(`${TAG} ${req.method} ${req.path}`);

  const route = routes.get(req.path);
  if (!route) {
    console.log(`${TAG} No route for ${req.path}, known routes: ${Array.from(routes.keys()).join(', ')}`);
    sendResponse(socket, 404, 'Not Found', 'text/plain', 'Unknown route');
    return;
  }

  // HLS streams → stream as continuous MPEG-TS
  if (route.isHLS) {
    console.log(`${TAG} Starting HLS→MPEG-TS stream for TV`);
    await streamHLStoSocket(socket, route);
    return;
  }

  // Non-HLS: simple proxy passthrough
  try {
    const headers = buildHeaders(route);

    // Forward Range header if present
    const rangeHeader = parseRangeHeader(rawData);
    if (rangeHeader) headers['Range'] = rangeHeader;

    console.log(`${TAG} Proxying to: ${route.targetUrl.substring(0, 100)}`);

    const response = await fetch(route.targetUrl, { headers, redirect: 'follow' });

    if (!response.ok) {
      console.log(`${TAG} Upstream returned ${response.status}`);
      sendResponse(socket, response.status, 'Upstream Error', 'text/plain', `Upstream: ${response.status}`);
      return;
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const arrayBuffer = await response.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    console.log(`${TAG} Proxying ${data.length} bytes (${contentType})`);
    sendBinaryResponse(socket, 200, 'OK', contentType, data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`${TAG} Proxy error: ${msg}`);
    sendResponse(socket, 502, 'Bad Gateway', 'text/plain', `Proxy error: ${msg}`);
  }
}

function sendResponse(
  socket: ReturnType<typeof TcpSocket.createConnection>,
  statusCode: number,
  statusText: string,
  contentType: string,
  body: string
): void {
  const bodyBytes = stringToBytes(body);
  const header = [
    `HTTP/1.1 ${statusCode} ${statusText}`,
    `Content-Type: ${contentType}`,
    `Content-Length: ${bodyBytes.length}`,
    'Access-Control-Allow-Origin: *',
    'Connection: close',
    '',
    '',
  ].join('\r\n');

  try {
    socket.write(header);
    socket.write(body);
    socket.destroy();
  } catch (e) {
    console.log(`${TAG} Socket write error:`, e);
  }
}

function sendBinaryResponse(
  socket: ReturnType<typeof TcpSocket.createConnection>,
  statusCode: number,
  statusText: string,
  contentType: string,
  data: Uint8Array
): void {
  const header = [
    `HTTP/1.1 ${statusCode} ${statusText}`,
    `Content-Type: ${contentType}`,
    `Content-Length: ${data.length}`,
    'Access-Control-Allow-Origin: *',
    'Connection: close',
    '',
    '',
  ].join('\r\n');

  try {
    socket.write(header);
    // Write binary data as base64 since react-native-tcp-socket supports it
    socket.write(uint8ToBase64(data), 'base64');
    socket.destroy();
  } catch (e) {
    console.log(`${TAG} Binary write error:`, e);
  }
}

function stringToBytes(str: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    bytes.push(str.charCodeAt(i) & 0xff);
  }
  return bytes;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // React Native has btoa
  return btoa(binary);
}

/**
 * Start the proxy server. Returns the base URL (e.g. http://192.168.0.78:8765).
 * @param deviceHost - IP of the DLNA device (used to discover our local IP)
 */
export async function startProxy(deviceHost?: string): Promise<string> {
  if (server) {
    // If IP was 0.0.0.0, retry detection
    if (localIP === '0.0.0.0' && deviceHost) {
      localIP = await getLocalIP(deviceHost);
      console.log(`${TAG} Re-detected IP: ${localIP}`);
    }
    console.log(`${TAG} Proxy already running at http://${localIP}:${currentPort}`);
    return `http://${localIP}:${currentPort}`;
  }

  // Determine local IP
  localIP = await getLocalIP(deviceHost);
  console.log(`${TAG} Local IP: ${localIP}`);

  return new Promise((resolve, reject) => {
    let retries = 0;
    const tryBind = (port: number) => {
      const srv = TcpSocket.createServer((socket) => {
        let requestData = '';
        socket.on('data', (chunk) => {
          if (typeof chunk === 'string') {
            requestData += chunk;
          } else {
            // Uint8Array → string
            const decoder = new TextDecoder();
            requestData += decoder.decode(chunk as Uint8Array);
          }
          // Simple heuristic: HTTP request ends with double CRLF
          if (requestData.includes('\r\n\r\n') || requestData.includes('\n\n')) {
            handleRequest(socket as unknown as ReturnType<typeof TcpSocket.createConnection>, requestData);
          }
        });
        socket.on('error', (err) => {
          console.log(`${TAG} Client socket error:`, err);
        });
      });

      srv.on('error', (err: Error & { code?: string }) => {
        console.log(`${TAG} Server error on port ${port}:`, err.message);
        if (err.code === 'EADDRINUSE' && retries < MAX_PORT_RETRIES) {
          retries++;
          tryBind(port + 1);
        } else {
          reject(new Error(`Cannot start proxy: ${err.message}`));
        }
      });

      srv.listen({ port, host: '0.0.0.0' }, () => {
        server = srv;
        currentPort = port;
        const baseUrl = `http://${localIP}:${currentPort}`;
        console.log(`${TAG} ═══ Proxy running at ${baseUrl} ═══`);
        resolve(baseUrl);
      });
    };

    tryBind(PROXY_PORT);
  });
}

/**
 * Stop the proxy server and clear all routes.
 */
export function stopProxy(): void {
  if (activeHLSAbort) {
    activeHLSAbort.abort();
    activeHLSAbort = null;
  }
  if (server) {
    try {
      server.close();
    } catch {}
    server = null;
  }
  routes.clear();
  routeCounter = 0;
  console.log(`${TAG} Proxy stopped`);
}

/**
 * Stop any active HLS streaming session (e.g. when user presses Stop).
 */
export function stopActiveStream(): void {
  if (activeHLSAbort) {
    activeHLSAbort.abort();
    activeHLSAbort = null;
    console.log(`${TAG} Active HLS stream aborted`);
  }
}

/**
 * Clear all registered routes (useful when switching streams).
 */
export function clearRoutes(): void {
  routes.clear();
  routeCounter = 0;
}

/**
 * Seek the active HLS stream to a position (in seconds).
 * Sets seek offset on all HLS routes and aborts the current stream.
 * Caller must re-cast (Stop → SetAVTransportURI → Play) for the TV to reconnect.
 */
export function seekStream(seconds: number): void {
  for (const [, route] of routes) {
    if (route.isHLS) route.seekOffset = seconds;
  }
  if (activeHLSAbort) {
    activeHLSAbort.abort();
    activeHLSAbort = null;
  }
  console.log(`${TAG} Seek to ${seconds}s, stream aborted for re-cast`);
}

/**
 * Get the total duration (in seconds) of the last parsed HLS playlist.
 * Returns 0 if unknown.
 */
export function getStreamTotalDuration(): number {
  return lastParsedTotalDuration;
}

/**
 * Fetch available quality variants from an HLS master playlist.
 * Returns empty array if not a master playlist or on error.
 */
export async function fetchQualities(m3u8Url: string, pageUrl: string): Promise<QualityOption[]> {
  let origin = '';
  let referer = pageUrl;
  try {
    const u = new URL(pageUrl);
    origin = u.origin;
  } catch { /* */ }

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: referer,
  };
  if (origin) headers['Origin'] = origin;

  try {
    const resp = await fetch(m3u8Url, { headers, redirect: 'follow' });
    if (!resp.ok) return [];
    const body = await resp.text();
    if (!body.includes('#EXT-X-STREAM-INF')) return [];
    return parseVariants(body, m3u8Url);
  } catch {
    return [];
  }
}

/**
 * Check if the proxy is currently running.
 */
export function isProxyRunning(): boolean {
  return server !== null;
}

/**
 * Get the current proxy base URL.
 */
export function getProxyBaseUrl(): string {
  return `http://${localIP}:${currentPort}`;
}
