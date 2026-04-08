import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { useAppStore } from '../context/appStore';
import { useDLNACast } from '../hooks/useDLNACast';
import { fetchQualities } from '../services/proxy/streamProxy';
import type { QualityOption } from '../services/proxy/streamProxy';

function timeToSeconds(time: string | undefined): number {
  if (!time || time === 'NOT_IMPLEMENTED') return 0;
  const parts = time.split(':').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function secondsToDisplay(sec: number): string {
  if (sec <= 0) return '--:--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export default function NowPlayingScreen() {
  const {
    selectedStream,
    selectedDevice,
    isCasting,
    castingStatus,
  } = useAppStore();

  const {
    cast,
    play,
    pause,
    stop,
    seekTo,
    positionInfo,
    transportInfo,
    streamDuration,
  } = useDLNACast();

  // Quality state
  const [qualities, setQualities] = useState<QualityOption[]>([]);
  const [selectedQualityIdx, setSelectedQualityIdx] = useState(-1); // -1 = auto (best)

  // Fetch available qualities when stream changes
  useEffect(() => {
    setQualities([]);
    setSelectedQualityIdx(-1);
    if (!selectedStream || selectedStream.type !== 'm3u8') return;
    let cancelled = false;
    fetchQualities(selectedStream.url, selectedStream.pageUrl).then(q => {
      if (!cancelled) setQualities(q);
    });
    return () => { cancelled = true; };
  }, [selectedStream?.url]);

  const isReady = !!(selectedStream && selectedDevice?.controlURL);
  const isActive = isCasting && castingStatus !== 'idle' && castingStatus !== 'stopped';
  const isPlaying = castingStatus === 'playing';
  const isPaused = castingStatus === 'paused';
  const isLoading = castingStatus === 'loading';

  // Current position in seconds
  const currentSeconds = useMemo(() => {
    return timeToSeconds(positionInfo?.relTime);
  }, [positionInfo]);

  // Total duration: prefer TV's report, fallback to proxy-tracked duration
  const totalSeconds = useMemo(() => {
    const tvDur = timeToSeconds(positionInfo?.trackDuration);
    return tvDur > 0 ? tvDur : streamDuration;
  }, [positionInfo, streamDuration]);

  const progress = useMemo(() => {
    if (totalSeconds <= 0) return 0;
    return Math.min(currentSeconds / totalSeconds, 1);
  }, [currentSeconds, totalSeconds]);

  const handleCast = useCallback(() => {
    const variantUrl = selectedQualityIdx >= 0 ? qualities[selectedQualityIdx]?.url : undefined;
    cast(variantUrl);
  }, [cast, qualities, selectedQualityIdx]);

  const handleSeek = useCallback((offsetSeconds: number) => {
    const target = Math.max(0, currentSeconds + offsetSeconds);
    seekTo(target);
  }, [currentSeconds, seekTo]);

  const statusConfig = useMemo(() => {
    switch (castingStatus) {
      case 'playing':
        return { label: 'PLAYING', color: '#4caf50', icon: '▶' };
      case 'paused':
        return { label: 'PAUSED', color: '#ff9800', icon: '⏸' };
      case 'loading':
        return { label: 'LOADING', color: '#00d4ff', icon: '⏳' };
      case 'stopped':
        return { label: 'STOPPED', color: '#888', icon: '⏹' };
      case 'error':
        return { label: 'ERROR', color: '#f44336', icon: '⚠' };
      default:
        return { label: 'IDLE', color: '#555', icon: '○' };
    }
  }, [castingStatus]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* ── Stream Info ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Selected Stream</Text>
        {selectedStream ? (
          <View style={styles.infoCard}>
            <View style={styles.infoHeader}>
              <View style={[
                styles.typeBadge,
                selectedStream.type === 'm3u8' && styles.typeBadgeHls,
                selectedStream.type === 'mp4' && styles.typeBadgeMp4,
              ]}>
                <Text style={styles.typeBadgeText}>
                  {selectedStream.type === 'm3u8' ? 'HLS' : selectedStream.type.toUpperCase()}
                </Text>
              </View>
              <Text style={styles.infoTimestamp}>
                {new Date(selectedStream.timestamp).toLocaleTimeString()}
              </Text>
            </View>
            <Text style={styles.infoUrl} numberOfLines={3} selectable>
              {selectedStream.url}
            </Text>
          </View>
        ) : (
          <View style={styles.placeholderCard}>
            <Text style={styles.placeholderIcon}>🌐</Text>
            <Text style={styles.placeholder}>
              No stream selected.{'\n'}Go to Browser tab and find a stream.
            </Text>
          </View>
        )}
      </View>

      {/* ── Device Info ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Target Device</Text>
        {selectedDevice ? (
          <View style={styles.infoCard}>
            <View style={styles.deviceRow}>
              <Text style={styles.deviceIcon}>📺</Text>
              <View style={styles.deviceText}>
                <Text style={styles.deviceName}>{selectedDevice.friendlyName}</Text>
                <Text style={styles.deviceModel}>
                  {selectedDevice.modelName || 'Unknown model'}
                </Text>
                {!selectedDevice.controlURL && (
                  <Text style={styles.deviceWarning}>
                    ⚠ No AVTransport control URL found
                  </Text>
                )}
              </View>
            </View>
          </View>
        ) : (
          <View style={styles.placeholderCard}>
            <Text style={styles.placeholderIcon}>📺</Text>
            <Text style={styles.placeholder}>
              No device selected.{'\n'}Go to Devices tab and select a TV.
            </Text>
          </View>
        )}
      </View>

      {/* ── Status ── */}
      <View style={styles.statusSection}>
        <View style={[styles.statusBadge, { backgroundColor: statusConfig.color + '22' }]}>
          <Text style={[styles.statusIcon, { color: statusConfig.color }]}>
            {statusConfig.icon}
          </Text>
          <Text style={[styles.statusText, { color: statusConfig.color }]}>
            {statusConfig.label}
          </Text>
        </View>

        {/* Position / Duration */}
        {isActive && (
          <View style={styles.positionRow}>
            <Text style={styles.positionTime}>
              {secondsToDisplay(currentSeconds)}
            </Text>
            <View style={styles.positionBarBg}>
              <View style={[styles.positionBarFill, { width: `${progress * 100}%` }]} />
            </View>
            <Text style={styles.positionTime}>
              {secondsToDisplay(totalSeconds)}
            </Text>
          </View>
        )}

        {/* Transport debug info */}
        {isActive && transportInfo && (
          <Text style={styles.debugInfo}>
            Transport: {transportInfo.currentTransportState} | Status: {transportInfo.currentTransportStatus}
          </Text>
        )}
      </View>

      {/* ── Quality Picker ── */}
      {qualities.length > 1 && !isActive && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quality</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.qualityRow}>
            <TouchableOpacity
              style={[styles.qualityChip, selectedQualityIdx === -1 && styles.qualityChipSelected]}
              onPress={() => setSelectedQualityIdx(-1)}
            >
              <Text style={[styles.qualityChipText, selectedQualityIdx === -1 && styles.qualityChipTextSelected]}>
                Auto
              </Text>
            </TouchableOpacity>
            {qualities.map((q, idx) => (
              <TouchableOpacity
                key={idx}
                style={[styles.qualityChip, selectedQualityIdx === idx && styles.qualityChipSelected]}
                onPress={() => setSelectedQualityIdx(idx)}
              >
                <Text style={[styles.qualityChipText, selectedQualityIdx === idx && styles.qualityChipTextSelected]}>
                  {q.label}
                </Text>
                <Text style={styles.qualityBitrate}>
                  {Math.round(q.bandwidth / 1000)}k
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* ── Quality during playback ── */}
      {qualities.length > 1 && isActive && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quality</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.qualityRow}>
            <TouchableOpacity
              style={[styles.qualityChip, selectedQualityIdx === -1 && styles.qualityChipSelected]}
              onPress={() => {
                setSelectedQualityIdx(-1);
                cast(undefined);
              }}
              disabled={isLoading}
            >
              <Text style={[styles.qualityChipText, selectedQualityIdx === -1 && styles.qualityChipTextSelected]}>
                Auto
              </Text>
            </TouchableOpacity>
            {qualities.map((q, idx) => (
              <TouchableOpacity
                key={idx}
                style={[styles.qualityChip, selectedQualityIdx === idx && styles.qualityChipSelected]}
                onPress={() => {
                  setSelectedQualityIdx(idx);
                  cast(q.url);
                }}
                disabled={isLoading}
              >
                <Text style={[styles.qualityChipText, selectedQualityIdx === idx && styles.qualityChipTextSelected]}>
                  {q.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* ── Controls ── */}
      <View style={styles.controls}>
        {!isActive ? (
          /* ── Cast Button ── */
          <TouchableOpacity
            style={[styles.castBtn, !isReady && styles.castBtnDisabled]}
            onPress={handleCast}
            disabled={!isReady || isLoading}
          >
            {isLoading ? (
              <View style={styles.castBtnContent}>
                <ActivityIndicator size="small" color="#000" />
                <Text style={styles.castBtnText}>Casting...</Text>
              </View>
            ) : (
              <Text style={styles.castBtnText}>📡 Cast to TV</Text>
            )}
          </TouchableOpacity>
        ) : (
          /* ── Playback Controls ── */
          <>
            {/* Seek buttons */}
            <View style={styles.seekRow}>
              <TouchableOpacity style={styles.seekBtn} onPress={() => handleSeek(-30)} disabled={isLoading}>
                <Text style={styles.seekBtnText}>-30s</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.seekBtn} onPress={() => handleSeek(-10)} disabled={isLoading}>
                <Text style={styles.seekBtnText}>-10s</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.seekBtn} onPress={() => handleSeek(10)} disabled={isLoading}>
                <Text style={styles.seekBtnText}>+10s</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.seekBtn} onPress={() => handleSeek(30)} disabled={isLoading}>
                <Text style={styles.seekBtnText}>+30s</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.playbackRow}>
              <TouchableOpacity
                style={[styles.controlBtn, isPlaying && styles.controlBtnActive]}
                onPress={play}
                disabled={isLoading}
              >
                <Text style={styles.controlBtnIcon}>▶</Text>
                <Text style={styles.controlBtnLabel}>Play</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.controlBtn, isPaused && styles.controlBtnActive]}
                onPress={pause}
                disabled={isLoading}
              >
                <Text style={styles.controlBtnIcon}>⏸</Text>
                <Text style={styles.controlBtnLabel}>Pause</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.stopBtn}
                onPress={stop}
              >
                <Text style={styles.stopBtnIcon}>⏹</Text>
                <Text style={styles.stopBtnLabel}>Stop</Text>
              </TouchableOpacity>
            </View>

            {/* Re-cast button */}
            <TouchableOpacity
              style={styles.recastBtn}
              onPress={handleCast}
              disabled={isLoading}
            >
              <Text style={styles.recastBtnText}>🔄 Re-cast stream</Text>
            </TouchableOpacity>
          </>
        )}

        {/* Readiness hints */}
        {!isReady && !isActive && (
          <View style={styles.hints}>
            {!selectedStream && (
              <Text style={styles.hintText}>• Select a stream in the Browser tab</Text>
            )}
            {!selectedDevice && (
              <Text style={styles.hintText}>• Select a TV in the Devices tab</Text>
            )}
            {selectedDevice && !selectedDevice.controlURL && (
              <Text style={styles.hintWarn}>
                • Selected TV has no AVTransport URL — casting may not work
              </Text>
            )}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d0d1a',
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  section: {
    marginBottom: 18,
  },
  sectionTitle: {
    color: '#00d4ff',
    fontSize: 13,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  infoCard: {
    backgroundColor: '#1a1a2e',
    borderRadius: 12,
    padding: 14,
  },
  infoHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  typeBadge: {
    backgroundColor: '#333',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  typeBadgeHls: {
    backgroundColor: '#4a2a00',
  },
  typeBadgeMp4: {
    backgroundColor: '#1b3a1b',
  },
  typeBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  infoTimestamp: {
    color: '#555',
    fontSize: 11,
  },
  infoUrl: {
    color: '#bbb',
    fontSize: 13,
    lineHeight: 18,
  },
  placeholderCard: {
    backgroundColor: '#1a1a2e',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
    gap: 8,
  },
  placeholderIcon: {
    fontSize: 32,
  },
  placeholder: {
    color: '#555',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  deviceIcon: {
    fontSize: 28,
  },
  deviceText: {
    flex: 1,
  },
  deviceName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  deviceModel: {
    color: '#888',
    fontSize: 13,
    marginTop: 2,
  },
  deviceWarning: {
    color: '#ff9800',
    fontSize: 12,
    marginTop: 4,
  },
  statusSection: {
    alignItems: 'center',
    marginBottom: 24,
    gap: 12,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 24,
  },
  statusIcon: {
    fontSize: 18,
  },
  statusText: {
    fontSize: 16,
    fontWeight: 'bold',
    letterSpacing: 2,
  },
  positionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    paddingHorizontal: 8,
  },
  positionTime: {
    color: '#888',
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    minWidth: 45,
    textAlign: 'center',
  },
  positionBarBg: {
    flex: 1,
    height: 4,
    backgroundColor: '#2a2a4a',
    borderRadius: 2,
  },
  positionBarFill: {
    height: 4,
    backgroundColor: '#00d4ff',
    borderRadius: 2,
  },
  debugInfo: {
    color: '#444',
    fontSize: 11,
    textAlign: 'center',
  },
  controls: {
    marginTop: 'auto',
    gap: 12,
  },
  castBtn: {
    backgroundColor: '#00d4ff',
    borderRadius: 16,
    padding: 18,
    alignItems: 'center',
  },
  castBtnDisabled: {
    backgroundColor: '#222',
    opacity: 0.5,
  },
  castBtnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  castBtnText: {
    color: '#000',
    fontSize: 18,
    fontWeight: 'bold',
  },
  playbackRow: {
    flexDirection: 'row',
    gap: 10,
  },
  controlBtn: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  controlBtnActive: {
    borderColor: '#00d4ff',
    backgroundColor: '#0d1a2e',
  },
  controlBtnIcon: {
    fontSize: 22,
    color: '#fff',
  },
  controlBtnLabel: {
    color: '#aaa',
    fontSize: 12,
    marginTop: 4,
    fontWeight: '600',
  },
  stopBtn: {
    flex: 1,
    backgroundColor: '#2a1a1a',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  stopBtnIcon: {
    fontSize: 22,
    color: '#f44336',
  },
  stopBtnLabel: {
    color: '#f44336',
    fontSize: 12,
    marginTop: 4,
    fontWeight: '600',
  },
  recastBtn: {
    backgroundColor: '#1a1a2e',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  recastBtnText: {
    color: '#888',
    fontSize: 14,
  },
  seekRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  seekBtn: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  seekBtnText: {
    color: '#00d4ff',
    fontSize: 13,
    fontWeight: 'bold',
  },
  qualityRow: {
    flexDirection: 'row',
  },
  qualityChip: {
    backgroundColor: '#1a1a2e',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginRight: 8,
    borderWidth: 1.5,
    borderColor: 'transparent',
    alignItems: 'center',
  },
  qualityChipSelected: {
    borderColor: '#00d4ff',
    backgroundColor: '#0d1a2e',
  },
  qualityChipText: {
    color: '#aaa',
    fontSize: 14,
    fontWeight: 'bold',
  },
  qualityChipTextSelected: {
    color: '#00d4ff',
  },
  qualityBitrate: {
    color: '#555',
    fontSize: 10,
    marginTop: 2,
  },
  hints: {
    marginTop: 8,
    gap: 4,
  },
  hintText: {
    color: '#555',
    fontSize: 13,
  },
  hintWarn: {
    color: '#ff9800',
    fontSize: 13,
  },
});
