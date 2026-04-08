import React, { useEffect, useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  TextInput,
} from 'react-native';
import { useAppStore, DLNADevice } from '../context/appStore';
import { discoverDevices, stopDiscovery, fetchDeviceDescription } from '../services/dlna';

export default function DevicesScreen() {
  const {
    devices,
    selectedDevice,
    isScanning,
    addDevice,
    selectDevice,
    setScanning,
    setDevices,
  } = useAppStore();

  const scanCount = useRef(0);
  const [manualIp, setManualIp] = useState('');
  const [isProbing, setIsProbing] = useState(false);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopDiscovery();
    };
  }, []);

  const handleScan = useCallback(async () => {
    if (isScanning) {
      // Stop current scan
      stopDiscovery();
      setScanning(false);
      console.log('[Devices] Scan stopped by user');
      return;
    }

    scanCount.current++;
    const currentScan = scanCount.current;
    console.log(`[Devices] Starting scan #${currentScan}...`);

    setScanning(true);
    // Clear previous devices on new scan
    setDevices([]);

    try {
      await discoverDevices(
        (device: DLNADevice) => {
          // Only add if this scan is still active
          if (scanCount.current === currentScan) {
            addDevice(device);
          }
        },
        8000 // 8 second timeout for thorough discovery
      );
      console.log(`[Devices] Scan #${currentScan} complete`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[Devices] Scan #${currentScan} error:`, message);
      Alert.alert(
        'Scan Error',
        `Failed to scan for devices: ${message}\n\nMake sure you are connected to WiFi and the app has network permissions.`
      );
    } finally {
      if (scanCount.current === currentScan) {
        setScanning(false);
      }
    }
  }, [isScanning, addDevice, setScanning, setDevices]);

  const handleSelectDevice = (device: DLNADevice) => {
    selectDevice(device);
    console.log('[Devices] Selected:', device.friendlyName, '→', device.controlURL);
  };

  /**
   * Probe a TV by IP address — tries common UPnP description paths.
   */
  const handleManualConnect = useCallback(async () => {
    const ip = manualIp.trim();
    if (!ip) {
      Alert.alert('Enter IP', 'Please enter your TV\'s IP address (e.g. 192.168.0.10)');
      return;
    }

    // Normalize: strip protocol if user pasted a full URL
    const cleanIp = ip.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:.*$/, '');

    setIsProbing(true);
    console.log('[Devices] Probing TV at:', cleanIp);

    // Common UPnP device description paths used by Philips and other TVs
    const probePaths = [
      `http://${cleanIp}:1925/`,                          // Philips JointSpace API
      `http://${cleanIp}:8008/ssdp/device-desc.xml`,      // Common DIAL/SSDP
      `http://${cleanIp}:49153/description.xml`,           // Philips common
      `http://${cleanIp}:49152/description.xml`,           // Alt port
      `http://${cleanIp}:1900/description.xml`,            // SSDP port description
      `http://${cleanIp}:8080/description.xml`,            // Alt
      `http://${cleanIp}/description.xml`,                 // Port 80
      `http://${cleanIp}:55000/nrc/sdd_0.xml`,             // Panasonic (just in case)
      `http://${cleanIp}:52323/dmr.xml`,                   // Sony
      `http://${cleanIp}:7676/dmr.xml`,                    // LG
      `http://${cleanIp}:49153/dmr/SamsungMRDesc.xml`,     // Samsung
    ];

    let found = false;

    for (const probeUrl of probePaths) {
      try {
        console.log('[Devices] Trying:', probeUrl);
        const desc = await fetchDeviceDescription(probeUrl);
        if (desc && desc.friendlyName && desc.friendlyName !== 'Unknown Device') {
          const device: DLNADevice = {
            usn: `manual-${cleanIp}`,
            friendlyName: desc.friendlyName,
            location: probeUrl,
            controlURL: desc.controlURL || '',
            modelName: desc.modelName,
          };
          addDevice(device);
          selectDevice(device);
          found = true;
          console.log('[Devices] Manual device found:', device.friendlyName);
          Alert.alert(
            'TV Found!',
            `${device.friendlyName}${device.modelName ? ` (${device.modelName})` : ''}\n\n${
              device.controlURL ? 'AVTransport control URL found ✓' : '⚠ No AVTransport URL — casting may not work'
            }`
          );
          break;
        }
      } catch {
        // Try next path
      }
    }

    if (!found) {
      Alert.alert(
        'TV Not Found',
        `Could not find a DLNA device at ${cleanIp}.\n\n` +
          'Make sure:\n' +
          '• The TV is ON (not standby)\n' +
          '• Digital Media Renderer (DMR) is enabled in TV settings\n' +
          '• The TV is on the same WiFi network\n\n' +
          'You can also try entering the full description URL if you know it (e.g. http://192.168.0.10:49153/description.xml)'
      );
    }

    setIsProbing(false);
  }, [manualIp, addDevice, selectDevice]);

  const renderDevice = ({ item }: { item: DLNADevice }) => {
    const isSelected = selectedDevice?.usn === item.usn;
    const hasControl = !!item.controlURL;

    return (
      <TouchableOpacity
        style={[styles.deviceCard, isSelected && styles.deviceCardSelected]}
        onPress={() => handleSelectDevice(item)}
      >
        <View style={styles.deviceHeader}>
          <Text style={styles.deviceIcon}>📺</Text>
          <View style={styles.deviceInfo}>
            <Text style={styles.deviceName}>{item.friendlyName}</Text>
            <Text style={styles.deviceModel}>
              {item.modelName || 'Unknown model'}
            </Text>
          </View>
        </View>

        <View style={styles.deviceMeta}>
          <Text style={styles.deviceLocation} numberOfLines={1}>
            {item.location}
          </Text>
          <View style={styles.badges}>
            {hasControl ? (
              <View style={styles.badgeOk}>
                <Text style={styles.badgeOkText}>AVTransport ✓</Text>
              </View>
            ) : (
              <View style={styles.badgeWarn}>
                <Text style={styles.badgeWarnText}>No Control URL</Text>
              </View>
            )}
            {isSelected && (
              <View style={styles.badgeSelected}>
                <Text style={styles.badgeSelectedText}>Selected ✓</Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Scan Button */}
      <TouchableOpacity
        style={[styles.scanBtn, isScanning && styles.scanBtnActive]}
        onPress={handleScan}
      >
        {isScanning ? (
          <View style={styles.scanBtnContent}>
            <ActivityIndicator size="small" color="#000" />
            <Text style={styles.scanBtnText}>Scanning... (tap to stop)</Text>
          </View>
        ) : (
          <Text style={styles.scanBtnText}>🔍 Scan for TVs</Text>
        )}
      </TouchableOpacity>

      {/* Manual IP Connect */}
      <View style={styles.manualSection}>
        <Text style={styles.manualLabel}>Or connect by IP address:</Text>
        <View style={styles.manualRow}>
          <TextInput
            style={styles.manualInput}
            value={manualIp}
            onChangeText={setManualIp}
            placeholder="192.168.0.x"
            placeholderTextColor="#555"
            keyboardType="decimal-pad"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isProbing}
          />
          <TouchableOpacity
            style={[styles.manualBtn, isProbing && styles.manualBtnActive]}
            onPress={handleManualConnect}
            disabled={isProbing}
          >
            {isProbing ? (
              <ActivityIndicator size="small" color="#000" />
            ) : (
              <Text style={styles.manualBtnText}>Connect</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Device count */}
      {devices.length > 0 && (
        <Text style={styles.deviceCount}>
          Found {devices.length} device{devices.length !== 1 ? 's' : ''} on your network
        </Text>
      )}

      {/* Device list or empty state */}
      {devices.length === 0 && !isScanning ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>📺</Text>
          <Text style={styles.emptyText}>
            No devices found yet.{'\n'}
            Tap "Scan for TVs" to discover{'\n'}
            DLNA devices on your network.
          </Text>
          <Text style={styles.emptyHint}>
            Make sure your TV is on and{'\n'}
            connected to the same WiFi network.
          </Text>
        </View>
      ) : devices.length === 0 && isScanning ? (
        <View style={styles.emptyState}>
          <ActivityIndicator size="large" color="#00d4ff" />
          <Text style={styles.scanningText}>
            Searching for DLNA devices...{'\n'}
            Sending SSDP discovery packets
          </Text>
        </View>
      ) : (
        <FlatList
          data={devices}
          keyExtractor={(item) => item.usn}
          renderItem={renderDevice}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d0d1a',
    padding: 16,
  },
  scanBtn: {
    backgroundColor: '#00d4ff',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  scanBtnActive: {
    backgroundColor: '#ff9800',
  },
  scanBtnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  scanBtnText: {
    color: '#000',
    fontWeight: 'bold',
    fontSize: 16,
  },
  manualSection: {
    marginBottom: 12,
    gap: 6,
  },
  manualLabel: {
    color: '#888',
    fontSize: 12,
  },
  manualRow: {
    flexDirection: 'row',
    gap: 8,
  },
  manualInput: {
    flex: 1,
    height: 42,
    backgroundColor: '#1a1a2e',
    borderRadius: 10,
    paddingHorizontal: 14,
    color: '#e0e0e0',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#2a2a4a',
  },
  manualBtn: {
    backgroundColor: '#00d4ff',
    borderRadius: 10,
    paddingHorizontal: 18,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 90,
  },
  manualBtnActive: {
    backgroundColor: '#ff9800',
  },
  manualBtnText: {
    color: '#000',
    fontWeight: 'bold',
    fontSize: 14,
  },
  deviceCount: {
    color: '#888',
    fontSize: 13,
    marginBottom: 12,
    textAlign: 'center',
  },
  list: {
    paddingBottom: 20,
  },
  deviceCard: {
    backgroundColor: '#1a1a2e',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  deviceCardSelected: {
    borderColor: '#00d4ff',
    backgroundColor: '#1a2a3e',
  },
  deviceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  deviceIcon: {
    fontSize: 32,
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    color: '#fff',
    fontSize: 17,
    fontWeight: 'bold',
  },
  deviceModel: {
    color: '#888',
    fontSize: 13,
    marginTop: 2,
  },
  deviceMeta: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#2a2a4a',
  },
  deviceLocation: {
    color: '#555',
    fontSize: 12,
    marginBottom: 8,
  },
  badges: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  badgeOk: {
    backgroundColor: '#1b3a1b',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeOkText: {
    color: '#4caf50',
    fontSize: 11,
    fontWeight: 'bold',
  },
  badgeWarn: {
    backgroundColor: '#3a2a1b',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeWarnText: {
    color: '#ff9800',
    fontSize: 11,
    fontWeight: 'bold',
  },
  badgeSelected: {
    backgroundColor: '#1b2a3a',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeSelectedText: {
    color: '#00d4ff',
    fontSize: 11,
    fontWeight: 'bold',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  emptyIcon: {
    fontSize: 64,
  },
  emptyText: {
    color: '#666',
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 24,
  },
  emptyHint: {
    color: '#444',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
    fontStyle: 'italic',
  },
  scanningText: {
    color: '#888',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginTop: 16,
  },
});
