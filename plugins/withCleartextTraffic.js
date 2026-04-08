const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Expo config plugin that enables cleartext HTTP traffic on Android.
 * Required for DLNA because UPnP device description URLs use plain HTTP.
 * Also ensures CHANGE_WIFI_MULTICAST_STATE is in the manifest for SSDP.
 */
const withCleartextTraffic = (config) => {
  return withAndroidManifest(config, async (config) => {
    const androidManifest = config.modResults;
    const mainApplication = androidManifest.manifest.application?.[0];

    if (mainApplication) {
      mainApplication.$['android:usesCleartextTraffic'] = 'true';
      console.log('[CastApp Plugin] Enabled usesCleartextTraffic for DLNA HTTP');
    }

    return config;
  });
};

module.exports = withCleartextTraffic;
