const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getPrebuildConfigAsync } = require('@expo/prebuild-config');
const { compileModsAsync, withAndroidManifest } = require('expo/config-plugins');
const withAndroidReleaseSafety = require('../plugins/withAndroidReleaseSafety');

const projectRoot = path.resolve(__dirname, '..');
const base = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8')).expo;
const directUpdateUrl = 'https://31-10-64-46.sslip.io/api/v1/mobile/updates/manifest';
const previousUpdateUrl = 'https://vita29.taild51e5c.ts.net/api/v1/mobile/updates/manifest';
const updateKey = 'expo.modules.updates.EXPO_UPDATE_URL';
const enabledKey = 'expo.modules.updates.ENABLED';

function appFrom(config) {
  return config._internal.modResults.android.manifest.manifest.application[0];
}

function metadata(app, name) {
  const entries = (app['meta-data'] || []).filter((entry) => entry.$['android:name'] === name);
  assert.equal(entries.length, 1, `Expected exactly one native metadata entry for ${name}`);
  return entries[0].$['android:value'];
}

async function checkLegacyManifest(hasUpdateUrl) {
  let config = withAndroidReleaseSafety(structuredClone(base));
  // Seed the actual Expo mod pipeline with an old native manifest, or with
  // the same manifest before its update URL was added. No files are written.
  config = withAndroidManifest(config, (result) => {
    const app = result.modResults.manifest.application[0];
    app.$['android:usesCleartextTraffic'] = 'true';
    app['meta-data'] = [
      { $: { 'android:name': enabledKey, 'android:value': 'true' } },
      ...(hasUpdateUrl ? [{ $: { 'android:name': updateKey, 'android:value': previousUpdateUrl } }] : []),
    ];
    return result;
  });
  const compiled = await compileModsAsync(config, {
    projectRoot, platforms: ['android'], introspect: true,
  });
  const app = appFrom(compiled);
  assert.equal(metadata(app, updateKey), directUpdateUrl);
  assert.equal(metadata(app, enabledKey), 'true');
  assert.equal(app.$['android:usesCleartextTraffic'], 'false');
}

async function main() {
  const previousCleartext = process.env.VIOLETTA_ALLOW_CLEARTEXT;
  process.env.VIOLETTA_ALLOW_CLEARTEXT = 'false';
  try {
    assert.equal(base.android.versionCode, 7);
    assert.equal(base.android.runtimeVersion, '0.6.0');
    assert.equal(base.updates.url, previousUpdateUrl, 'Shared/iOS update URL must remain unchanged');

    // Evaluate the complete installed Expo prebuild plugins, including their
    // real ordering. Introspection deliberately avoids creating native files.
    const { exp } = await getPrebuildConfigAsync(projectRoot, { platforms: ['android', 'ios'] });
    const compiled = await compileModsAsync(exp, {
      projectRoot, platforms: ['android', 'ios'], introspect: true,
    });
    const app = appFrom(compiled);
    assert.equal(metadata(app, updateKey), directUpdateUrl);
    assert.equal(metadata(app, enabledKey), 'true');
    assert.equal(metadata(app, 'expo.modules.updates.EXPO_UPDATES_CHECK_ON_LAUNCH'), 'ALWAYS');
    assert.equal(app.$['android:usesCleartextTraffic'], 'false');
    const runtime = compiled._internal.modResults.android.strings.resources.string
      .find((entry) => entry.$.name === 'expo_runtime_version');
    assert.equal(runtime._, '0.6.0');
    const ios = compiled._internal.modResults.ios.expoPlist;
    assert.equal(ios.EXUpdatesURL, base.updates.url);
    assert.equal(ios.EXUpdatesRuntimeVersion, base.ios.runtimeVersion);
    assert.equal(ios.EXUpdatesEnabled, true);

    await checkLegacyManifest(true);
    await checkLegacyManifest(false);
    console.log('Native prebuild passed: Android build 7/runtime 0.6.0 uses direct HTTPS updates, preserves enabled checks, rejects cleartext, and leaves iOS updates unchanged.');
    console.log('Legacy and missing native update URL cases passed through Expo mod compilation.');
  } finally {
    if (previousCleartext === undefined) delete process.env.VIOLETTA_ALLOW_CLEARTEXT;
    else process.env.VIOLETTA_ALLOW_CLEARTEXT = previousCleartext;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
