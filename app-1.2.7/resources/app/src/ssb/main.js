// Filter out user's paths from require search list
var re = /[\\\/]\.node_/i;
var requirePaths = require('module').globalPaths;
var newPaths = [];

for (var i=0; i < requirePaths.length; i++) {
  if (requirePaths[i].match(re))  continue;
  newPaths.push(requirePaths[i]);
}

// NB: Stop a rare crash where debug tries to write to an fd and fails,
// brings down the app
require('debug').log = console.info.bind(console);

require('module').globalPaths = newPaths;

const ipc = require('ipc');
const rx = require('rx-dom');

const AppIntegration = require('./app');
const ClipboardIntegration = require('./clipboard');
const DockIntegration = require('./dock');
const NotificationIntegration = require('./notify');
const TeamIntegration = require('./team');
const DownloadIntegration = require('./downloads');
const ContextMenuIntegration = require('./context-menu');
const SpellCheckingHelper = require('./spell-checking');
const WindowApi = require('./window-api');
const WindowOpener = require('./window-opener');
const WindowOpenOverride = require('./window-open-override');
const Calls = require('./calls');
const setupCrashReporter = require('../setup-crash-reporter');

const logger = require('../browser/logger').init(__filename);

window.globalLogger = logger;

setupCrashReporter(global.loadSettings);

window.rendererEvalAsync = (blob) => {
  let data = null;
  try {
    data = JSON.parse(decodeURIComponent(atob(blob)));
    let result = eval(data.code);
    
    if (result === undefined || result === null) {
      data.result = null;
    } else {
      data.result = JSON.stringify(result);
    }
  } catch (error) {
    data.error = { stack: error.stack, message: error.message };
  }

  if (data.guestInstanceId || data.browserWindowId) {
    // Send to the browser which will reroute to data.guestId's webContents
    ipc.send('eval-async', data);
  } else {
    ipc.sendToHost('eval-async', data);
  }
};

let webFrame = window.webFrame = require('web-frame');
webFrame.registerUrlSchemeAsSecure('slack-resources');

let spellCheckingHelper = new SpellCheckingHelper();

// NB: Wait until we're in page context before we try to set up our input
// listener
var postDOMSetup = () => {
  if (!window || !window.location || !window.winssb) {
    setTimeout(postDOMSetup, 250);
    return;
  }

  // NB: Even touching localStorage in a data URI will cause errors to be thrown
  if (window.location.protocol !== 'data:') {
    window.winssb.ls = window.localStorage;
  }
};

setTimeout(postDOMSetup, 250);

let contextMenu = new ContextMenuIntegration(spellCheckingHelper ?
  spellCheckingHelper.currentKeyboardLanguage :
  rx.Observable.empty());

// Determine whether we're in a WebView or a BrowserWindow, and either way,
// capture our identifying information. If we're actually in a WebView, this
// will identify the hosting window
const browserWindowId = require('remote').getCurrentWindow().id;

let _calls = null;
try {
  _calls = new Calls();
} catch (e) {
  console.log ("Calls failed to load, bailing");
}

window.winssb = {
  app: new AppIntegration(),

  clipboard: new ClipboardIntegration(),

  dock: new DockIntegration(),

  notice: new NotificationIntegration(),

  teams: new TeamIntegration(),

  downloads: new DownloadIntegration(),

  window: new WindowApi(browserWindowId, process.guestInstanceId),

  contextMenu: contextMenu,

  calls: _calls,

  // this is for backwards compatibility with webapp, which currently refers to everything as 'screehero' and not 'calls'
  screenhero: _calls,

  spellCheckingHelper: spellCheckingHelper,

  browserWindowId: browserWindowId
};

if (!_calls) delete window.winssb.calls;

// NB: If this is set, we know we're running in the context of a WebView
if (process.guestInstanceId) {
  window.winssb.guestInstanceId = process.guestInstanceId;
} else {
  window.opener = new WindowOpener();
}

new WindowOpenOverride();
