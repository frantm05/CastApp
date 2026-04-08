---
name: castapp-architecture
description: Core project context for CastApp. Use for any task touching the codebase structure, stack decisions, or adding new files.
---

## CastApp — Project Context

**Goal:** React Native (Expo, TypeScript) app that lets Android/iOS users cast video streams to a DLNA/UPnP TV (e.g. Philips OLED) without needing external services. Everything runs on-device.

### Stack
- React Native 0.81 + Expo 54 (dev-client, NOT Expo Go)
- TypeScript strict mode
- Zustand (appStore.ts) for global state
- react-native-webview — in-app browser with JS injection
- react-native-tcp-socket — local HTTP proxy server
- react-native-udp — SSDP UDP multicast discovery
- expo-network — local IP detection
- React Navigation bottom tabs (Browser / Devices / NowPlaying)

### Directory structure
```
src/
  components/     # Shared UI components (CastingMiniBar)
  context/        # appStore.ts — Zustand store
  hooks/          # useDLNACast.ts — cast logic hook
  navigation/     # AppNavigator.tsx
  screens/        # BrowserScreen, DevicesScreen, NowPlayingScreen
  services/
    dlna/         # discovery.ts (SSDP/UPnP), control.ts (SOAP/AVTransport)
    extraction/   # injectedScript.ts (WebView JS hooks)
    proxy/        # streamProxy.ts (local HTTP server, HLS→MPEG-TS)
  utils/
plugins/          # withCleartextTraffic Expo config plugin
```

### Core rules
- NEVER use external backend servers — all streaming logic runs on the phone
- Always keep TypeScript strict — no `any` without comment explaining why
- Dark theme only: primary bg `#0d0d1a`, secondary `#1a1a2e`, accent `#00d4ff`
- React Native StyleSheet only — no styled-components or Tailwind
- Use Zustand actions from `useAppStore()` — never mutate state directly
- Proxy port is 8765 (PROXY_PORT in streamProxy.ts)
- DLNA control via SOAP to AVTransport:1 service
- HLS streams are converted to continuous MPEG-TS by the proxy before sending to TV