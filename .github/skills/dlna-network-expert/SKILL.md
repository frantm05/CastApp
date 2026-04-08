---
name: dlna-network-expert
description: Expert knowledge on DLNA, SSDP, UPnP AVTransport, HLS proxy, and all network-layer code in CastApp. Use when working on discovery.ts, control.ts, streamProxy.ts, or useDLNACast.ts.
---

## DLNA/Network Expert — CastApp

### Architecture overview
```
Phone (Android)
  └─ SSDP UDP multicast → discovers TV on LAN
  └─ HTTP SOAP → controls TV (AVTransport:1)
  └─ TCP server :8765 → streams video TO TV
       ├─ HLS (.m3u8): fetch segments, concatenate as chunked MPEG-TS
       └─ MP4/direct: proxy passthrough with correct headers
```

### Key files
- `src/services/dlna/discovery.ts` — SSDP M-SEARCH via react-native-udp
- `src/services/dlna/control.ts` — SOAP: SetAVTransportURI, Play, Pause, Stop, Seek, GetTransportInfo, GetPositionInfo
- `src/services/proxy/streamProxy.ts` — TCP HTTP server, HLS→MPEG-TS converter
- `src/hooks/useDLNACast.ts` — orchestrates proxy + DLNA control + Zustand state

### Critical constraints
- TV (Philips OLED 55OLED770) uses port 49153 for UPnP description
- DLNA renderer expects `video/mp2t` content-type for MPEG-TS
- DIDL-Lite metadata: always include `protocolInfo` with `DLNA.ORG_FLAGS=01700000000000000000000000000000`
- HLS: send chunked Transfer-Encoding, each chunk = one .ts segment as hex-size + data
- Seek = abort current HLS stream + Stop DLNA + SetAVTransportURI + Play (TV re-fetches from proxy)
- IP detection order: expo-network → TCP socket probe to gateway → fallback 0.0.0.0

### Common failure modes to check
1. `controlURL` is empty → TV found via SSDP but AVTransport not parsed from XML
2. Stream not reaching TV → phone IP is 0.0.0.0 (IP detection failed)
3. TV rejects SOAP → try empty metadata fallback in castStream()
4. HLS stalls → check segment retry logic and AbortController lifecycle
5. Port conflict → MAX_PORT_RETRIES tries ports 8765–8770

### When implementing changes
- Preserve the 3-strategy fallback in `castStream()` (with-metadata → empty-metadata → no-metadata)
- Never block the UDP socket creation — SSDP requires binding to port 0 (random)
- Always abort `activeHLSAbort` before starting a new HLS session
- `getStreamTotalDuration()` must be updated after each playlist parse