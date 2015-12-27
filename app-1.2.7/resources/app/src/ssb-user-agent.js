import {version} from '../package.json';
import {isWindows10OrHigher} from './native-interop';

export default function() {
  if (global.navigator.userAgent.match(/Slack_SSB/)) {
    return global.navigator.userAgent;
  }
  
  // NB: We used to pass AtomShell as part of the user agent, but now it's
  // the productName, which is unfortunately also Slack. For sanity's sake,
  // we're going to just patch this for now back to AtomShell.
  let userAgent = global.navigator.userAgent.replace(/(Slack|Electron)\/0\.([\d\.]+) /, 'AtomShell/0.$2 ');
  userAgent += ` Slack_SSB/${version.split('-')[0]}`;
  
  if (process.platform !== 'win32') return userAgent;

  // NB: Because of VersionLie we don't actually get the right OS version, let's
  // patch it for our records
  if (isWindows10OrHigher()) {
    userAgent = userAgent.replace(/Windows NT [0-9]\.[0-9]/, "Windows NT 10.0");
  }

  return userAgent;
}
