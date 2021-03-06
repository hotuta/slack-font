import fs from 'fs';
import path from 'path';
import {spawn} from 'child_process';
import {p} from './get-path';
import mkdirp from 'mkdirp';

const logger = require('./browser/logger').init(__filename);

// NB: Save this off so that we can use this in SSB Interop context
const globalProcess = process;

// Handles auto-launch by creating shortcuts in the Windows Startup folder.
// We accomplish this using Squirrel's Update.exe.
export default class AutoLaunch {
  constructor() {
    this.updateDotExe = path.resolve(path.dirname(globalProcess.execPath), '..', 'update.exe');
    this.target = path.basename(globalProcess.execPath);

    if (globalProcess.platform === 'linux') {
      this.autostartDir = p`${'appData'}/../autostart`;
      this.slackDesktopFile = p`/usr/share/applications/slack.desktop`;
      this.targetSlackDesktopFile = p`${this.autostartDir}/slack.desktop'`;
    }
  }

  // Public: Determines whether auto-launch is enabled
  //
  // True if it is enabled.
  isEnabled() {
    if (globalProcess.platform === 'win32') {
      let shortcut = p`${'appData'}/Microsoft/Windows/Start Menu/Programs/Startup/Slack.lnk`;
      
      return !!fs.statSyncNoException(shortcut);
    }

    if (globalProcess.platform === 'linux') {
      return !!fs.statSyncNoException(this.targetSlackDesktopFile);
    }

    return false;
  }

  // Public: Enables auto-launch on login
  //
  // Returns an awaitable Promise
  async enable() {
    if (!this.canModifyShortcuts()) return;

    if (globalProcess.platform === 'win32') {
      logger.info(`Creating shortcut to ${this.target} in Startup folder`);
      let args = ['--createShortcut', this.target, '-l', 'Startup', '-a', '"--startup"'];

      try {
        await spawn(this.updateDotExe, args).toPromise();
      } catch (e) {
        logger.error(`Creating shortcut failed: ${e}`);
      }
    } else if (globalProcess.platform === 'linux') {
      mkdirp.sync(this.autostartDir);
      fs.symlinkSync(this.slackDesktopFile, this.targetSlackDesktopFile);
    }
  }

  // Public: Disables auto-launch on login
  //
  // Returns an awaitable Promise
  async disable() {
    if (!this.canModifyShortcuts()) return;

    if (globalProcess.platform === 'win32') {
      logger.info(`Removing shortcut to ${this.target} from Startup folder`);
      let args = ['--removeShortcut', this.target, '-l', 'Startup'];

      try {
        await spawn(this.updateDotExe, args).toPromise();
      } catch (e) {
        logger.error(`Removing shortcut failed: ${e}`);
      }
    } else if (globalProcess.platform === 'linux') {
      if (!fs.statSyncNoException(this.targetSlackDesktopFile)) return;
      fs.unlinkSync(this.targetSlackDesktopFile);
    }
  }

  // Private: Check for edge cases where Update.exe may not be accessible
  //
  // Returns true if we can modify shortcuts, false otherwise
  canModifyShortcuts() {
    if (globalProcess.platform === 'win32') {
      if (global.devMode) {
        logger.warn("Auto-launch shortcuts disabled in devMode");
        return false;
      }

      if (!fs.statSyncNoException(this.updateDotExe)) {
        logger.error(`Nothing found at ${this.updateDotExe}, did you remove it?`);
        return false;
      }
    }

    if (globalProcess.platform === 'linux') {
      return fs.statSyncNoException(this.slackDesktopFile);
    }

    return true;
  }
}
