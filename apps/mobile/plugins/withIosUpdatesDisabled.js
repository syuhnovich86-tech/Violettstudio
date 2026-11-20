const { promises: fs } = require('fs');
const path = require('path');
const plist = require('@expo/plist').default;
const { withFinalizedMod } = require('expo/config-plugins');

// iOS is distributed only as a newly signed binary. Keep Android OTA support,
// but make the Apple build independent from the internal updates service.
module.exports = function withIosUpdatesDisabled(config) {
  return withFinalizedMod(config, ['ios', async (result) => {
    const expoPlistPath = path.join(
      result.modRequest.platformProjectRoot,
      result.modRequest.projectName,
      'Supporting',
      'Expo.plist',
    );
    const values = plist.parse(await fs.readFile(expoPlistPath, 'utf8'));
    values.EXUpdatesEnabled = false;
    values.EXUpdatesCheckOnLaunch = 'NEVER';
    delete values.EXUpdatesURL;
    delete values.EXUpdatesRuntimeVersion;
    await fs.writeFile(expoPlistPath, plist.build(values));
    return result;
  }]);
};
