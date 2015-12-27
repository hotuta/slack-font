import fs from 'fs';
import path from 'path';
import bugsnag from 'bugsnag';

let logger = null;

export default class BugsnagReporter {
  constructor(resourcePath, devMode) {
    let packageJson = path.resolve(resourcePath, 'package.json');
    let version = JSON.parse(fs.readFileSync(packageJson)).version;

    bugsnag.register('acaff8df67924f677747922423057034', {
      releaseStage: devMode ? 'development' : 'production',
      appVersion: version,
      packageJson: packageJson,
      projectRoot: resourcePath,
      onUncaughtError: (e) => {
        // TODO: We should use Update.exe to restart on Windows here, but for
        // now just roll with it
        logger = logger || require('./logger').init(__filename, this);
        logger.error(e.stack || e);
      }
    });
  }

  autoNotify(callback) {
    bugsnag.autoNotify(callback);
  }
}
