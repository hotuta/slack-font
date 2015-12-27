import ref from 'ref';
import refStruct from 'ref-struct';
import refArray from 'ref-array';
import ffi from 'ffi';
import fs from 'fs';
import path from 'path';
import {getIdleTime} from '@paulcbetts/system-idle-time';
import _ from 'lodash';
let $ = null;     // nodobjc will be loaded here

var intPtr = null;
var boolPtr = null;
var LASTINPUTINFO = null;
var OSVERSIONINFO = null;
var pOSVERSIONINFO = null;
var pLASTINPUTINFO = null;
var shell32 = null;
var user32 = null;
var kernel32 = null;
var dwmApi = null;

let globalScope = global || window;

let setupWindowsLibs = () => {
  intPtr = intPtr || ref.refType(ref.types.int32);
  boolPtr = boolPtr || ref.refType(ref.types.bool);

  LASTINPUTINFO = LASTINPUTINFO || refStruct({
    cbSize: ref.types.int32,
    dwTime: ref.types.uint32
  });

  OSVERSIONINFO = OSVERSIONINFO || refStruct({
    dwOSVersionInfoSize: ref.types.uint32,
    dwMajorVersion: ref.types.uint32,
    dwMinorVersion: ref.types.uint32,
    dwBuildNumber: ref.types.uint32,
    dwPlatformId: ref.types.uint32,
    szCSDVersion: refArray(ref.types.byte, 128)
  });

  pLASTINPUTINFO = pLASTINPUTINFO || ref.refType(LASTINPUTINFO);
  pOSVERSIONINFO = pOSVERSIONINFO || ref.refType(OSVERSIONINFO);

  shell32 = shell32 || ffi.Library('shell32', {
    'SHQueryUserNotificationState': [ 'int', [ intPtr ] ]
  });

  user32 = user32 || ffi.Library('user32', {
    'GetLastInputInfo': [ 'int', [ pLASTINPUTINFO ] ],
    'GetSystemMetrics': [ 'int', [ 'int' ]]
  });

  kernel32 = kernel32 || ffi.Library('kernel32', {
    'GetVersionExA': [ 'int', [ pOSVERSIONINFO ] ],
    'GetLastError': [ 'uint32', [] ]
  });

  dwmApi = dwmApi || ffi.Library('dwmapi', {
    'DwmIsCompositionEnabled': [ 'int', [ boolPtr ] ]
  });
};

let autoReleasePool = (doWork) => {
  $ = $ || require('@paulcbetts/nodobjc');
  $.framework('Foundation');
  let pool = $.NSAutoreleasePool('alloc')('init');
  doWork();
  pool('drain');
};

var logger = null;

exports = {
  'win32': {

    shouldDisplayNotifications: () => {
      setupWindowsLibs();
      logger = logger || require('./browser/logger').init(__filename);

      let outVal = ref.alloc(intPtr);
      let hr = shell32.SHQueryUserNotificationState(outVal);

      if (hr !== 0) {
        throw new Error(`Failed to query notification state, hr is 0x${hr.toString(16)}`);
      }

      let result = outVal.get();

      // https://msdn.microsoft.com/en-us/library/windows/desktop/bb762533(v=vs.85).aspx
      if (result === 0) return true;    // NB: The call can succeed but return an empty state.
      if (result === 1) return true;    // Screensaver is running or machine is locked, who cares?
      if (result === 5) return true;    // All's good under the hood, boss
      if (result === 7) return true;    // Windows Store app is running, who cares?

      logger.info(`Not displaying notifications due to ${result}`);
      return false;
    },

    getIdleTimeInMs: getIdleTime,

    getOSVersion: () => {
      setupWindowsLibs();

      let result = new OSVERSIONINFO();
      result.dwOSVersionInfoSize = OSVERSIONINFO.size;

      let failed = (kernel32.GetVersionExA(result.ref()) === 0);
      if (failed) {
        let gle = kernel32.GetLastError();
        throw new Error(`Failed to get version information: 0x${gle.toString(16)}`);
      }

      return {
        major: result.dwMajorVersion,
        minor: result.dwMinorVersion,
        build: result.dwBuildNumber
      };
    },

    is64BitOperatingSystem: () => {
      if (process.arch === 'x64') return true;

      let sysRoot = 'C:\\Windows';
      if (fs.statSyncNoException(process.env.SYSTEMROOT || 'C:\\__nothere__')) {
        sysRoot = process.env.SYSTEMROOT;
      }

      // If %SystemRoot%\SysNative exists, we are in a WOW64 FS Redirected application.
      return !!fs.statSyncNoException(path.join(sysRoot, 'sysnative'));
    },

    isWindows8OrHigher: () => {
      let versions = _.map(require('os').release().split('.'), (x) => parseInt(x));
      return (versions[0] * 100 + versions[1]) >= 6*100+2; /*6.2*/
    },

    isWindows10OrHigher: (dontLieToMe=false) => {
      if (this.win10OrHigher || this.win10OrHigher === false) return this.win10OrHigher;

      if (globalScope.loadSettings && globalScope.loadSettings.pretendNotReallyWindows10 && !dontLieToMe) {
        this.win10OrHigher = false;
        return false;
      }

      // NB: Yes, this is the wrong way to do this. Yes, I don't care.
      let sysRoot = 'C:\\Windows';
      if (fs.statSyncNoException(process.env.SYSTEMROOT || 'C:\\__nothere__')) {
        sysRoot = process.env.SYSTEMROOT;
      }

      let is64BitOS = !!fs.statSyncNoException(path.join(sysRoot, 'sysnative'));
      this.win10OrHigher = !!fs.statSyncNoException(path.join(sysRoot, is64BitOS ? 'SysNative' : 'System32', 'win32kbase.sys'));
      return this.win10OrHigher;
    },

    // Public: Determine if this machine can support transparent windows.
    // First check for DWM Composition, then see if we're in a remote session.
    supportsTransparentWindows: () => {
      setupWindowsLibs();
      logger = logger || require('./browser/logger').init(__filename);

      // https://msdn.microsoft.com/en-us/library/windows/desktop/aa969518%28v=vs.85%29.aspx
      let outVal = ref.alloc(boolPtr);
      let hr = dwmApi.DwmIsCompositionEnabled(outVal);

      // https://msdn.microsoft.com/en-us/library/windows/desktop/ms724385%28v=vs.85%29.aspx
      let remoteSession = 0x1000;
      let isRemoteSession = user32.GetSystemMetrics(remoteSession);

      if (hr !== 0) {
        throw new Error(`Failed to check DWM composition, hr is 0x${hr.toString(16)}`);
      }

      let isComposing = outVal.get();
      logger.debug(`DwmIsCompositionEnabled: ${isComposing}, Remote Session: ${isRemoteSession}`);

      return !!(isComposing && !isRemoteSession && !process.env.SLACK_DWM_DISABLED);
    }
  },

  'darwin': {

    // NB: The concept of presentation mode is not the same on OS X, and is
    // also quite a bit trickier to detect. We're just going to punt for now.
    shouldDisplayNotifications: () => true,

    getIdleTimeInMs: getIdleTime,

    getOSVersion: () => {
      let result = { major: 0, minor: 0, build: 0 };
      logger = logger || require('./browser/logger').init(__filename);

      autoReleasePool(() => {
        let versionPList = $.NSString('stringWithUTF8String', '/System/Library/CoreServices/SystemVersion.plist');
        let versionDictionary = $.NSDictionary('dictionaryWithContentsOfFile', versionPList);
        let versionString = versionDictionary('objectForKey', $.NSString('stringWithUTF8String', 'ProductVersion'));

        let versions = versionString.toString().split('.');
        result = {
          major: parseInt(versions[0]),
          minor: parseInt(versions[1]),
          build: parseInt(versions[2])
        };
      });

      logger.debug(`getOSVersion: ${JSON.stringify(result)}`);
      return result;
    },

    // NB: OS X is always 64-bit
    is64BitOperatingSystem: () => true,

    isWindows8OrHigher: () => false,

    isWindows10OrHigher: () => false,

    supportsTransparentWindows: () => true
  },

  'linux': {

    shouldDisplayNotifications: () => {
      return true;
    },

    getIdleTimeInMs: getIdleTime,

    getOSVersion: () => {
      logger = logger || require('./browser/logger').init(__filename);
      logger.error("Not implemented!!!!");

      return { major: 1, minor: 0, build: 0 };
    },

    // NB: We don't support running the 32-bit version on 64-bit OS's
    is64BitOperatingSystem: () => process.arch === 'x64',

    isWindows8OrHigher: () => false,

    isWindows10OrHigher: () => false,

    supportsTransparentWindows: () => true
  }
};

module.exports = exports[process.platform];
