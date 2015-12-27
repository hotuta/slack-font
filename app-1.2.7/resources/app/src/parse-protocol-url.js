// Public: Parses a passed-in protocol URL for protocol items that we have to
// handle early in startup.
//
// Returns an {Object} optionally containing any of the following keys:
//    :devMode - True if running in developer mode, which exposes devTools
//    :devEnv - The dev environment we are pointed at, e.g., 'dev13'
//    :releaseChannel - The release channel we are using, 'beta' or 'prod'
//    :openDevToolsOnStart - True to open devTools on app start
//    :pretendNotReallyWindows10 - True to act like older versions of Windows
export function parseProtocolUrl(protoUrl='') {
  let ret = {};
  let m = protoUrl.match(/devEnv=(dev\d+|staging)/);

  if (m) {
    ret.devMode = true;
    ret.devEnv = m[1];
  }
  
  m = protoUrl.match(/releaseChannel=(beta|prod)/);
  if (m) {
    ret.releaseChannel = m[1];
  }

  m = protoUrl.match(/openDevToolsOnStart/);
  if (m) {
    ret.openDevToolsOnStart = true;
  }

  m = protoUrl.match(/notReallyWindows10/);
  if (m) {
    ret.pretendNotReallyWindows10 = true;
  }

  return ret;
}