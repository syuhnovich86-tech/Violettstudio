const { withAndroidManifest, withGradleProperties } = require('expo/config-plugins');

/**
 * WorkManager creates its Room database implementation through reflection.
 * R8 in the current Expo/AGP toolchain can remove that constructor and crash
 * the app before MainActivity is created. Keep release minification disabled
 * until the upstream WorkManager consumer rules are compatible with this
 * toolchain.
 */
module.exports = function withAndroidReleaseSafety(config) {
  let resultConfig = withGradleProperties(config, (result) => {
    const key = 'android.enableMinifyInReleaseBuilds';
    const existing = result.modResults.find(
      (item) => item.type === 'property' && item.key === key,
    );

    if (existing) {
      existing.value = 'false';
    } else {
      result.modResults.push({ type: 'property', key, value: 'false' });
    }

    return result;
  });

  // Extract native libraries during installation so ARM libraries can be
  // resolved reliably on devices and on Android's native-bridge emulator.
  resultConfig = withGradleProperties(resultConfig, (result) => {
    const key = 'expo.useLegacyPackaging';
    const existing = result.modResults.find((item) => item.type === 'property' && item.key === key);
    if (existing) existing.value = 'true';
    else result.modResults.push({ type: 'property', key, value: 'true' });
    return result;
  });

  if (process.env.VIOLETTA_ALLOW_CLEARTEXT !== 'true') {
    resultConfig = withAndroidManifest(resultConfig, (result) => {
      const app = result.modResults.manifest.application[0];
      const metadata = app['meta-data'] || (app['meta-data'] = []);
      const updateUrl = metadata.find((item) => item.$['android:name'] === 'expo.modules.updates.EXPO_UPDATE_URL');
      const url = 'https://vita29.taild51e5c.ts.net/api/v1/mobile/updates/manifest';
      if (updateUrl) updateUrl.$['android:value'] = url;
      else metadata.push({ $: { 'android:name': 'expo.modules.updates.EXPO_UPDATE_URL', 'android:value': url } });
      return result;
    });
  }

  if (process.env.VIOLETTA_ALLOW_CLEARTEXT === 'true') {
    resultConfig = withAndroidManifest(resultConfig, (result) => {
      result.modResults.manifest.application[0].$['android:usesCleartextTraffic'] = 'true';
      return result;
    });
  }
  return resultConfig;
};
