import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useNavigation, NavigationProp } from '@react-navigation/native';
import { useAppStore } from '../context/appStore';
import {
  play as dlnaPlay,
  pause as dlnaPause,
  stop as dlnaStop,
} from '../services/dlna';

type RootTabs = { Browser: undefined; Devices: undefined; NowPlaying: undefined };

export default function CastingMiniBar() {
  const {
    selectedStream,
    selectedDevice,
    castingStatus,
    isCasting,
    setCasting,
    setCastingStatus,
  } = useAppStore();
  const navigation = useNavigation<NavigationProp<RootTabs>>();

  if (!isCasting || castingStatus === 'idle' || castingStatus === 'stopped') return null;

  const isPlaying = castingStatus === 'playing';
  const isPaused = castingStatus === 'paused';
  const controlURL = selectedDevice?.controlURL;

  const handlePlayPause = async () => {
    if (!controlURL) return;
    try {
      if (isPlaying) {
        await dlnaPause(controlURL);
        setCastingStatus('paused');
      } else {
        await dlnaPlay(controlURL);
        setCastingStatus('playing');
      }
    } catch {
      // Silently fail in mini-bar — detailed errors shown in NowPlaying
    }
  };

  const handleStop = async () => {
    if (controlURL) {
      try {
        await dlnaStop(controlURL);
      } catch {
        // Force local state even on error
      }
    }
    setCastingStatus('stopped');
    setCasting(false);
  };

  const statusLabel =
    castingStatus === 'playing'
      ? 'Playing'
      : castingStatus === 'paused'
        ? 'Paused'
        : castingStatus === 'loading'
          ? 'Loading...'
          : castingStatus === 'error'
            ? 'Error'
            : 'Casting';

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={() => navigation.navigate('NowPlaying')}
      activeOpacity={0.8}
    >
      {/* Status dot */}
      <View
        style={[
          styles.dot,
          castingStatus === 'playing' && styles.dotPlaying,
          castingStatus === 'paused' && styles.dotPaused,
          castingStatus === 'loading' && styles.dotLoading,
          castingStatus === 'error' && styles.dotError,
        ]}
      />

      {/* Info */}
      <View style={styles.info}>
        <Text style={styles.streamLabel} numberOfLines={1}>
          {selectedStream?.type === 'm3u8'
            ? 'HLS Stream'
            : selectedStream?.type === 'mp4'
              ? 'MP4 Stream'
              : 'Stream'}{' '}
          → {selectedDevice?.friendlyName || 'TV'}
        </Text>
        <Text style={styles.statusLabel}>{statusLabel}</Text>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        {(isPlaying || isPaused) && (
          <TouchableOpacity onPress={handlePlayPause} style={styles.controlBtn}>
            <Text style={styles.controlIcon}>{isPlaying ? '⏸' : '▶'}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={handleStop} style={styles.controlBtn}>
          <Text style={[styles.controlIcon, styles.stopIcon]}>⏹</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a2a3e',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#00d4ff44',
    gap: 10,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#555',
  },
  dotPlaying: {
    backgroundColor: '#4caf50',
  },
  dotPaused: {
    backgroundColor: '#ff9800',
  },
  dotLoading: {
    backgroundColor: '#00d4ff',
  },
  dotError: {
    backgroundColor: '#f44336',
  },
  info: {
    flex: 1,
    gap: 2,
  },
  streamLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  statusLabel: {
    color: '#888',
    fontSize: 11,
  },
  controls: {
    flexDirection: 'row',
    gap: 6,
  },
  controlBtn: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#2a2a4a',
    borderRadius: 10,
  },
  controlIcon: {
    fontSize: 15,
    color: '#fff',
  },
  stopIcon: {
    color: '#f44336',
  },
});
