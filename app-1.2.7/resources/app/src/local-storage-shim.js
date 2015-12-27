const fs = require('fs');
const path = require('path');

// NB: This is an evil hack - Electron doesn't persist localStorage, see
// https://github.com/atom/electron/issues/1731
module.exports = (fileName) => {
  const LocalStorage = require('./browser/local-storage');
  const app = require('remote').require('app');

  let pathToLs = path.join(app.getDataPath(), fileName);
  let fileSystemLs = new LocalStorage(pathToLs);

  if (!fs.statSyncNoException(pathToLs)) {
    for (let i = 0, len = window.localStorage.length; i < len; i++) {
      let key = window.localStorage.key(i);
      console.log(`Migrating ${key} from localStorage to file system`);

      let value = window.localStorage.getItem(key);
      fileSystemLs.setItem(key, value);
    }
    fileSystemLs.save();
  }

  Object.defineProperty(window, 'localStorage', {
    writable: false,
    value: fileSystemLs
  });

  window.addEventListener('beforeunload', () => window.localStorage.save());
};
