/**
 * DLNA AVTransport Control Service
 *
 * Sends SOAP XML requests to DLNA MediaRenderer devices to control
 * video playback via the AVTransport:1 service.
 *
 * Implements: SetAVTransportURI, Play, Pause, Stop, Seek,
 *             GetTransportInfo, GetPositionInfo
 */

const TAG = '[DLNA Control]';
const AVTRANSPORT_URN = 'urn:schemas-upnp-org:service:AVTransport:1';

// ──────────────────────────────────────────────
// XML / SOAP helpers
// ──────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSOAPEnvelope(action: string, args: Record<string, string>): string {
  const argsXml = Object.entries(args)
    .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
    .join('\n      ');

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"',
    '  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    '  <s:Body>',
    `    <u:${action} xmlns:u="${AVTRANSPORT_URN}">`,
    '      <InstanceID>0</InstanceID>',
    `      ${argsXml}`,
    `    </u:${action}>`,
    '  </s:Body>',
    '</s:Envelope>',
  ].join('\n');
}

/**
 * Extract a simple XML tag value from a SOAP response.
 */
function extractXmlValue(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*>([^<]*)</${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : null;
}

/**
 * Detect MIME type / protocolInfo from a stream URL.
 * The proxy converts HLS to MPEG-TS, so proxied URLs ending in .ts
 * should use video/mp2t. Uses DLNA streaming flags for compatibility.
 */
function getProtocolInfo(url: string): string {
  if (/\.ts(\?|$|#)/i.test(url)) {
    return 'http-get:*:video/mp2t:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
  }
  if (/\.mp4(\?|$|#)/i.test(url)) {
    return 'http-get:*:video/mp4:DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000';
  }
  if (/\.mkv(\?|$|#)/i.test(url)) {
    return 'http-get:*:video/x-matroska:*';
  }
  // Default to MPEG-TS with DLNA streaming flags (our proxy serves this)
  return 'http-get:*:video/mp2t:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
}

// ──────────────────────────────────────────────
// SOAP transport
// ──────────────────────────────────────────────

async function sendSOAPAction(
  controlURL: string,
  action: string,
  args: Record<string, string>,
  timeoutMs: number = 8000
): Promise<string> {
  const body = buildSOAPEnvelope(action, args);
  console.log(`${TAG} → ${action} to ${controlURL}`);
  console.log(`${TAG} SOAP body:\n${body}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(controlURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${AVTRANSPORT_URN}#${action}"`,
      },
      body,
      signal: controller.signal,
    });

    const responseText = await response.text();
    console.log(`${TAG} ← ${action} (${response.status}):`, responseText.substring(0, 500));

    if (!response.ok) {
      // Try to parse UPnP error
      const errorCode = extractXmlValue(responseText, 'errorCode');
      const errorDesc = extractXmlValue(responseText, 'errorDescription');
      const errMsg = errorDesc
        ? `${action} error ${errorCode}: ${errorDesc}`
        : `${action} HTTP ${response.status}`;
      throw new Error(errMsg);
    }

    return responseText;
  } finally {
    clearTimeout(timer);
  }
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Set the URI of the media to play on the DLNA renderer.
 * Includes DIDL-Lite metadata with correct protocolInfo for the stream type.
 */
export async function setAVTransportURI(
  controlURL: string,
  mediaUrl: string,
  title: string = 'CastApp Stream'
): Promise<string> {
  const protocolInfo = getProtocolInfo(mediaUrl);
  console.log(`${TAG} Setting URI with protocolInfo: ${protocolInfo}`);

  const metadata = [
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"',
    '  xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '  xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">',
    '  <item id="0" parentID="-1" restricted="1">',
    `    <dc:title>${escapeXml(title)}</dc:title>`,
    '    <upnp:class>object.item.videoItem</upnp:class>',
    `    <res protocolInfo="${protocolInfo}">${escapeXml(mediaUrl)}</res>`,
    '  </item>',
    '</DIDL-Lite>',
  ].join('');

  return sendSOAPAction(controlURL, 'SetAVTransportURI', {
    CurrentURI: mediaUrl,
    CurrentURIMetaData: metadata,
  });
}

/**
 * Start or resume playback.
 */
export async function play(controlURL: string): Promise<string> {
  return sendSOAPAction(controlURL, 'Play', { Speed: '1' });
}

/**
 * Pause playback.
 */
export async function pause(controlURL: string): Promise<string> {
  return sendSOAPAction(controlURL, 'Pause', {});
}

/**
 * Stop playback and release the transport.
 */
export async function stop(controlURL: string): Promise<string> {
  return sendSOAPAction(controlURL, 'Stop', {});
}

/**
 * Seek to a position. Target format: "HH:MM:SS"
 */
export async function seek(controlURL: string, target: string): Promise<string> {
  return sendSOAPAction(controlURL, 'Seek', {
    Unit: 'REL_TIME',
    Target: target,
  });
}

// ──────────────────────────────────────────────
// Query actions (parsing responses)
// ──────────────────────────────────────────────

export interface TransportInfo {
  currentTransportState: string;   // PLAYING, PAUSED_PLAYBACK, STOPPED, TRANSITIONING, NO_MEDIA_PRESENT
  currentTransportStatus: string;  // OK, ERROR_OCCURRED
  currentSpeed: string;
}

/**
 * Get the current transport state.
 */
export async function getTransportInfo(controlURL: string): Promise<TransportInfo> {
  const xml = await sendSOAPAction(controlURL, 'GetTransportInfo', {});
  return {
    currentTransportState: extractXmlValue(xml, 'CurrentTransportState') || 'UNKNOWN',
    currentTransportStatus: extractXmlValue(xml, 'CurrentTransportStatus') || 'UNKNOWN',
    currentSpeed: extractXmlValue(xml, 'CurrentSpeed') || '1',
  };
}

export interface PositionInfo {
  trackDuration: string;    // "HH:MM:SS" or "NOT_IMPLEMENTED"
  relTime: string;          // "HH:MM:SS" current position
  absTime: string;
  trackURI: string;
}

/**
 * Get current playback position and track duration.
 */
export async function getPositionInfo(controlURL: string): Promise<PositionInfo> {
  const xml = await sendSOAPAction(controlURL, 'GetPositionInfo', {});
  return {
    trackDuration: extractXmlValue(xml, 'TrackDuration') || '00:00:00',
    relTime: extractXmlValue(xml, 'RelTime') || '00:00:00',
    absTime: extractXmlValue(xml, 'AbsTime') || '00:00:00',
    trackURI: extractXmlValue(xml, 'TrackURI') || '',
  };
}

// ──────────────────────────────────────────────
// High-level cast helper
// ──────────────────────────────────────────────

/**
 * Full cast sequence: SetAVTransportURI → Play.
 * Tries multiple strategies if the TV rejects the first attempt:
 *   1. Normal with DIDL-Lite metadata
 *   2. Empty metadata
 *   3. Minimal metadata with video/mp4
 */
export async function castStream(
  controlURL: string,
  mediaUrl: string,
  title?: string
): Promise<void> {
  console.log(`${TAG} ═══ CAST START ═══`);
  console.log(`${TAG} URL: ${mediaUrl}`);
  console.log(`${TAG} Device: ${controlURL}`);

  // Step 1: Stop any current playback
  try {
    await stop(controlURL);
    console.log(`${TAG} Stopped previous playback`);
  } catch {
    console.log(`${TAG} Stop before cast failed (may be ok if nothing was playing)`);
  }

  await delay(500);

  // Try multiple SetAVTransportURI strategies
  const strategies = [
    {
      name: 'with-metadata',
      fn: () => setAVTransportURI(controlURL, mediaUrl, title),
    },
    {
      name: 'empty-metadata',
      fn: () => sendSOAPAction(controlURL, 'SetAVTransportURI', {
        CurrentURI: mediaUrl,
        CurrentURIMetaData: '',
      }),
    },
    {
      name: 'no-metadata',
      fn: () => sendSOAPAction(controlURL, 'SetAVTransportURI', {
        CurrentURI: mediaUrl,
      }),
    },
  ];

  let setUriSuccess = false;
  let lastError = '';

  for (const strategy of strategies) {
    try {
      console.log(`${TAG} Trying strategy: ${strategy.name}`);
      await strategy.fn();
      console.log(`${TAG} SetURI succeeded with strategy: ${strategy.name}`);
      setUriSuccess = true;
      break;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      console.log(`${TAG} Strategy ${strategy.name} failed: ${lastError}`);
      await delay(300);
    }
  }

  if (!setUriSuccess) {
    throw new Error(`All SetAVTransportURI strategies failed. Last error: ${lastError}`);
  }

  // Wait for the TV to buffer
  await delay(1500);

  // Step 3: Play
  await play(controlURL);
  console.log(`${TAG} Play command sent`);
  console.log(`${TAG} ═══ CAST COMPLETE ═══`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
