/**
 * DLNA/SSDP Discovery Service
 *
 * Uses SSDP (Simple Service Discovery Protocol) over UDP multicast
 * to find DLNA MediaRenderer devices on the local network.
 *
 * Protocol flow:
 * 1. Send M-SEARCH multicast to 239.255.255.250:1900
 * 2. Listen for unicast HTTP responses from devices
 * 3. Parse LOCATION header from each response
 * 4. Fetch device description XML from LOCATION URL
 * 5. Extract friendlyName, modelName, AVTransport controlURL
 */

import dgram from 'react-native-udp';
import { DLNADevice } from '../../context/appStore';

const TAG = '[DLNA Discovery]';

const SSDP_MULTICAST_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

// Search for both MediaRenderer and AVTransport service
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:service:AVTransport:1',
  'ssdp:all', // fallback: discover everything, filter later
  'upnp:rootdevice',
  'urn:schemas-upnp-org:device:Basic:1',
];

function buildSearchMessage(searchTarget: string): string {
  return [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_MULTICAST_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    'MX: 4',
    `ST: ${searchTarget}`,
    'USER-AGENT: CastApp/1.0 UPnP/1.1',
    '',
    '',
  ].join('\r\n');
}

/**
 * Parse SSDP response headers into key-value pairs.
 */
export function parseSSDPResponse(
  response: string
): { location: string; usn: string; st: string } | null {
  const headers: Record<string, string> = {};

  const lines = response.split('\r\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.substring(0, colonIdx).trim().toLowerCase();
      const value = line.substring(colonIdx + 1).trim();
      headers[key] = value;
    }
  }

  if (!headers['location']) {
    console.log(TAG, 'Response missing LOCATION header, skipping');
    return null;
  }

  return {
    location: headers['location'],
    usn: headers['usn'] || 'unknown',
    st: headers['st'] || '',
  };
}

/**
 * Fetch and parse the UPnP device description XML from the LOCATION URL.
 * Extracts friendlyName, modelName, and the AVTransport controlURL.
 */
export async function fetchDeviceDescription(
  locationUrl: string
): Promise<Partial<DLNADevice> | null> {
  console.log(TAG, 'Fetching device description from:', locationUrl);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(locationUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log(TAG, 'HTTP error fetching description:', response.status);
      return null;
    }

    const xml = await response.text();
    console.log(TAG, 'Device XML (first 600 chars):', xml.substring(0, 600));

    // Extract basic device info
    const friendlyName =
      xml.match(/<friendlyName>([^<]+)<\/friendlyName>/)?.[1] || 'Unknown Device';
    const modelName =
      xml.match(/<modelName>([^<]+)<\/modelName>/)?.[1] || undefined;
    const manufacturer =
      xml.match(/<manufacturer>([^<]+)<\/manufacturer>/)?.[1] || '';

    console.log(TAG, `Device: "${friendlyName}" (${modelName || '?'}) by ${manufacturer}`);

    // Find AVTransport service controlURL
    // The XML structure is: <service> ... <serviceType>...AVTransport...</serviceType> ... <controlURL>/path</controlURL> ... </service>
    const controlURL = findAVTransportControlURL(xml);

    if (!controlURL) {
      console.log(TAG, 'No AVTransport controlURL found for:', friendlyName);
      // Still return the device — it might be a renderer without AVTransport in the root XML
      // Some devices put it in a separate service description
    }

    // Build absolute control URL
    let absoluteControlURL = '';
    if (controlURL) {
      try {
        const base = new URL(locationUrl);
        if (controlURL.startsWith('http')) {
          absoluteControlURL = controlURL;
        } else {
          const path = controlURL.startsWith('/') ? controlURL : '/' + controlURL;
          absoluteControlURL = `${base.protocol}//${base.host}${path}`;
        }
      } catch {
        absoluteControlURL = controlURL;
      }
    }

    console.log(TAG, 'AVTransport controlURL:', absoluteControlURL || '(not found)');

    return {
      friendlyName,
      modelName,
      controlURL: absoluteControlURL,
      location: locationUrl,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(TAG, 'Error fetching device description:', message);
    return null;
  }
}

/**
 * Parse the device description XML to find the AVTransport service controlURL.
 * Handles multiple <service> blocks and finds the one with AVTransport serviceType.
 */
function findAVTransportControlURL(xml: string): string | null {
  // Strategy 1: Find <service> block containing AVTransport
  const serviceBlocks = xml.match(/<service>[\s\S]*?<\/service>/gi) || [];
  for (const block of serviceBlocks) {
    if (/AVTransport/i.test(block)) {
      const urlMatch = block.match(/<controlURL>([^<]+)<\/controlURL>/i);
      if (urlMatch) return urlMatch[1];
    }
  }

  // Strategy 2: Broader search for controlURL near AVTransport text
  const avMatch = xml.match(/AVTransport[\s\S]{0,500}?<controlURL>([^<]+)<\/controlURL>/i);
  if (avMatch) return avMatch[1];

  // Strategy 3: Look for any controlURL as a last resort
  const anyMatch = xml.match(/<controlURL>([^<]+)<\/controlURL>/i);
  if (anyMatch) {
    console.log(TAG, 'Using first controlURL found (may not be AVTransport):', anyMatch[1]);
    return anyMatch[1];
  }

  return null;
}

// ------------------------------------------------------------------
// Active discovery state (to allow stopping)
// ------------------------------------------------------------------
let activeSocket: ReturnType<typeof dgram.createSocket> | null = null;
let discoveryTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Stop any in-progress discovery scan.
 */
export function stopDiscovery(): void {
  if (discoveryTimeout) {
    clearTimeout(discoveryTimeout);
    discoveryTimeout = null;
  }
  if (activeSocket) {
    try {
      activeSocket.close();
      console.log(TAG, 'Socket closed');
    } catch (e) {
      console.log(TAG, 'Error closing socket:', e);
    }
    activeSocket = null;
  }
}

/**
 * Discover DLNA MediaRenderer devices on the local network.
 *
 * @param onDeviceFound  Called each time a new device is resolved.
 * @param timeoutMs      How long to listen for responses (default 6s).
 * @returns              Promise that resolves when the scan is finished.
 */
export function discoverDevices(
  onDeviceFound: (device: DLNADevice) => void,
  timeoutMs: number = 10000
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Clean up any previous scan
    stopDiscovery();

    const seenLocations = new Set<string>();
    const pendingFetches: Promise<void>[] = [];

    console.log(TAG, '=== Starting SSDP discovery ===');
    console.log(TAG, 'Timeout:', timeoutMs, 'ms');

    const tryBind = (port: number) => {
      const socket = dgram.createSocket({ type: 'udp4' });
      activeSocket = socket;

      socket.once('listening', () => {
        const address = socket.address();
        console.log(TAG, 'Socket bound to port:', address.port);

        // Join multicast group so we receive SSDP replies on Android
        try {
          socket.addMembership(SSDP_MULTICAST_ADDRESS);
          console.log(TAG, 'Joined multicast group', SSDP_MULTICAST_ADDRESS);
        } catch (e) {
          console.log(TAG, 'addMembership failed (non-fatal):', e);
        }

        // Send M-SEARCH for each search target
        // Stagger sends slightly to avoid packet loss
        SEARCH_TARGETS.forEach((st, index) => {
          setTimeout(() => {
            const message = buildSearchMessage(st);
            console.log(TAG, `Sending M-SEARCH for ST=${st}`);
            socket.send(
              message,
              undefined,
              undefined,
              SSDP_PORT,
              SSDP_MULTICAST_ADDRESS,
              (err?: Error) => {
                if (err) {
                  console.log(TAG, 'Send error:', err.message);
                } else {
                  console.log(TAG, 'M-SEARCH sent successfully for:', st);
                }
              }
            );
          }, index * 300);
        });

        // Send a second round after 2 seconds for reliability
        setTimeout(() => {
          if (!activeSocket) return;
          const message = buildSearchMessage(SEARCH_TARGETS[0]);
          console.log(TAG, 'Sending follow-up M-SEARCH');
          socket.send(message, undefined, undefined, SSDP_PORT, SSDP_MULTICAST_ADDRESS, () => {});
        }, 2000);
      });

      socket.on('message', (msg: string | Uint8Array, rinfo: { address: string; port: number }) => {
        const responseStr = typeof msg === 'string' ? msg : new TextDecoder().decode(msg);
        console.log(TAG, `Response from ${rinfo.address}:${rinfo.port} (${responseStr.length} bytes)`);

        const parsed = parseSSDPResponse(responseStr);
        if (!parsed) return;

        // Skip if we already fetched this LOCATION
        if (seenLocations.has(parsed.location)) {
          console.log(TAG, 'Duplicate location, skipping:', parsed.location);
          return;
        }
        seenLocations.add(parsed.location);

        console.log(TAG, 'New device location:', parsed.location);
        console.log(TAG, '  USN:', parsed.usn);
        console.log(TAG, '  ST:', parsed.st);

        // Fetch the device description XML in parallel
        const fetchPromise = fetchDeviceDescription(parsed.location)
          .then((desc) => {
            if (!desc || !desc.friendlyName) return;

            const device: DLNADevice = {
              usn: parsed.usn,
              friendlyName: desc.friendlyName,
              location: parsed.location,
              controlURL: desc.controlURL || '',
              modelName: desc.modelName,
            };

            console.log(TAG, '✓ Device resolved:', device.friendlyName, '→', device.controlURL);
            onDeviceFound(device);
          })
          .catch((err) => {
            console.log(TAG, 'Error resolving device:', err);
          });

        pendingFetches.push(fetchPromise);
      });

      socket.on('error', (err: Error & { code?: string }) => {
        // If port 1900 fails, fall back to ephemeral port
        if (port === SSDP_PORT && err.code === 'EADDRINUSE') {
          console.log(TAG, 'Port 1900 busy, falling back to ephemeral port');
          try { socket.close(); } catch { /* ignore */ }
          activeSocket = null;
          tryBind(0);
          return;
        }
        console.log(TAG, 'Socket error:', err.message);
      });

      // Bind to explicit address, try fixed port 1900 first then fallback to 0
      socket.bind({ port, address: '0.0.0.0' });

      // Set timeout to stop discovery
      discoveryTimeout = setTimeout(async () => {
        console.log(TAG, '=== Discovery timeout reached ===');
        console.log(TAG, 'Unique locations found:', seenLocations.size);

        // Wait for all pending description fetches to complete
        await Promise.allSettled(pendingFetches);

        stopDiscovery();
        console.log(TAG, '=== Discovery complete ===');
        resolve();
      }, timeoutMs);
    };

    try {
      // Try port 1900 first (some Android versions need it), fall back to ephemeral
      tryBind(SSDP_PORT);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(TAG, 'Fatal discovery error:', message);
      stopDiscovery();
      reject(new Error(`SSDP discovery failed: ${message}`));
    }
  });
}
