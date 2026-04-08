/**
 * useDLNACast — Custom hook that bridges the DLNA control service
 * with the Zustand app store and provides a simple API to the UI.
 *
 * Handles: cast, play, pause, stop, seek, and transport state polling.
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { Alert } from 'react-native';
import { useAppStore } from '../context/appStore';
import {
  castStream,
  setAVTransportURI,
  play as dlnaPlay,
  pause as dlnaPause,
  stop as dlnaStop,
  getTransportInfo,
  getPositionInfo,
} from '../services/dlna';
import type { TransportInfo, PositionInfo } from '../services/dlna';
import {
  startProxy, registerStream, clearRoutes, stopActiveStream,
  seekStream, getStreamTotalDuration,
} from '../services/proxy/streamProxy';

const TAG = '[useDLNACast]';
const POLL_INTERVAL_MS = 3000;
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export interface CastHook {
  cast: (variantUrl?: string) => Promise<void>;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
  seekTo: (positionSeconds: number) => Promise<void>;
  transportInfo: TransportInfo | null;
  positionInfo: PositionInfo | null;
  isPolling: boolean;
  streamDuration: number;
}

export function useDLNACast(): CastHook {
  const {
    selectedStream,
    selectedDevice,
    isCasting,
    setCasting,
    setCastingStatus,
  } = useAppStore();

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [transportInfo, setTransportInfo] = useState<TransportInfo | null>(null);
  const [positionInfo, setPositionInfo] = useState<PositionInfo | null>(null);
  const [streamDuration, setStreamDuration] = useState(0);
  const isPollingRef = useRef(false);
  const proxyUrlRef = useRef<string | null>(null);
  const deviceHostRef = useRef<string | undefined>(undefined);

  const getControlURL = useCallback((): string | null => {
    if (!selectedDevice?.controlURL) {
      console.log(TAG, 'No device or controlURL available');
      return null;
    }
    return selectedDevice.controlURL;
  }, [selectedDevice]);

  // ────────────────────────────────────
  // Transport state polling
  // ────────────────────────────────────

  const pollTransportState = useCallback(async () => {
    const controlURL = getControlURL();
    if (!controlURL) return;

    try {
      const [transport, position] = await Promise.all([
        getTransportInfo(controlURL),
        getPositionInfo(controlURL),
      ]);

      setTransportInfo(transport);
      setPositionInfo(position);

      console.log(
        TAG,
        `Poll: state=${transport.currentTransportState} pos=${position.relTime}/${position.trackDuration}`
      );

      // Update stream duration from proxy
      const dur = getStreamTotalDuration();
      if (dur > 0) setStreamDuration(dur);
      // Sync transport state → app store
      switch (transport.currentTransportState) {
        case 'PLAYING':
          setCastingStatus('playing');
          break;
        case 'PAUSED_PLAYBACK':
          setCastingStatus('paused');
          break;
        case 'STOPPED':
          setCastingStatus('stopped');
          break;
        case 'TRANSITIONING':
          setCastingStatus('loading');
          break;
        case 'NO_MEDIA_PRESENT':
          setCastingStatus('idle');
          setCasting(false);
          break;
        default:
          console.log(TAG, 'Unknown transport state:', transport.currentTransportState);
      }

      // If errored, update status
      if (transport.currentTransportStatus === 'ERROR_OCCURRED') {
        console.log(TAG, 'Transport reports error');
        setCastingStatus('error');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(TAG, 'Poll error:', msg);
      // Don't set error status for transient network issues during polling
    }
  }, [getControlURL, setCasting, setCastingStatus]);

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return; // already polling
    isPollingRef.current = true;
    console.log(TAG, 'Starting transport polling');
    // Immediate first poll
    pollTransportState();
    pollTimerRef.current = setInterval(pollTransportState, POLL_INTERVAL_MS);
  }, [pollTransportState]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    isPollingRef.current = false;
    console.log(TAG, 'Stopped transport polling');
  }, []);

  // Start/stop polling based on casting state
  useEffect(() => {
    if (isCasting) {
      startPolling();
    } else {
      stopPolling();
    }
    return () => stopPolling();
  }, [isCasting, startPolling, stopPolling]);

  // ────────────────────────────────────
  // Cast actions
  // ────────────────────────────────────

  const cast = useCallback(async (variantUrl?: string) => {
    const controlURL = getControlURL();
    if (!controlURL || !selectedStream) {
      Alert.alert('Cannot Cast', 'Please select both a stream and a device first.');
      return;
    }

    console.log(TAG, '═══ Initiating cast ═══');
    console.log(TAG, 'Stream:', selectedStream.url);
    console.log(TAG, 'Device:', selectedDevice?.friendlyName);
    console.log(TAG, 'Variant:', variantUrl || 'auto (best)');

    setCasting(true);
    setCastingStatus('loading');

    try {
      let deviceHost: string | undefined;
      try {
        deviceHost = new URL(controlURL).hostname;
      } catch { /* ignore */ }
      deviceHostRef.current = deviceHost;

      console.log(TAG, 'Starting stream proxy...');
      await startProxy(deviceHost);
      clearRoutes();
      const proxyUrl = registerStream(selectedStream.url, selectedStream.pageUrl, variantUrl);
      proxyUrlRef.current = proxyUrl;
      console.log(TAG, 'Proxy URL for TV:', proxyUrl);

      await castStream(controlURL, proxyUrl, 'CastApp Stream');
      setCastingStatus('playing');
      console.log(TAG, 'Cast successful — playback started via proxy');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(TAG, 'Cast FAILED:', msg);
      setCastingStatus('error');
      Alert.alert('Cast Failed', `Could not cast to TV:\n\n${msg}`);
    }
  }, [getControlURL, selectedStream, selectedDevice, setCasting, setCastingStatus]);

  const play = useCallback(async () => {
    const controlURL = getControlURL();
    if (!controlURL) return;
    try {
      console.log(TAG, 'Play');
      await dlnaPlay(controlURL);
      setCastingStatus('playing');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(TAG, 'Play error:', msg);
      Alert.alert('Play Error', msg);
    }
  }, [getControlURL, setCastingStatus]);

  const pause = useCallback(async () => {
    const controlURL = getControlURL();
    if (!controlURL) return;
    try {
      console.log(TAG, 'Pause');
      await dlnaPause(controlURL);
      setCastingStatus('paused');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(TAG, 'Pause error:', msg);
      // Some devices don't support pause — fall back info
      Alert.alert('Pause Error', `${msg}\n\nNote: Some TVs do not support pausing DLNA streams.`);
    }
  }, [getControlURL, setCastingStatus]);

  const stop = useCallback(async () => {
    const controlURL = getControlURL();
    // Stop the proxy stream regardless
    stopActiveStream();
    if (!controlURL) return;
    try {
      console.log(TAG, 'Stop');
      await dlnaStop(controlURL);
      setCastingStatus('stopped');
      setCasting(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(TAG, 'Stop error:', msg);
      // Force local state to stopped anyway
      setCastingStatus('stopped');
      setCasting(false);
    }
  }, [getControlURL, setCasting, setCastingStatus]);

  const seekTo = useCallback(
    async (positionSeconds: number) => {
      const controlURL = getControlURL();
      if (!controlURL || !proxyUrlRef.current) return;

      console.log(TAG, `Seeking to ${positionSeconds}s`);
      setCastingStatus('loading');

      try {
        seekStream(positionSeconds);
        await dlnaStop(controlURL);
        await wait(500);
        await setAVTransportURI(controlURL, proxyUrlRef.current, 'CastApp Stream');
        await wait(1000);
        await dlnaPlay(controlURL);
        setCastingStatus('playing');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(TAG, 'Seek error:', msg);
        setCastingStatus('playing'); // restore state on error
      }
    },
    [getControlURL, setCastingStatus]
  );

  return {
    cast,
    play,
    pause,
    stop,
    seekTo,
    transportInfo,
    positionInfo,
    isPolling: isPollingRef.current,
    streamDuration,
  };
}
