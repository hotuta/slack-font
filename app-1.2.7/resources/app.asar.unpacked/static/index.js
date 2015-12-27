// Warning: You almost certainly do *not* want to edit this code - instead, you
// want to edit src/renderer/main.coffee instead

var startup = function() {
  // Filter out user's paths from require search list
  var re = /[\\\/]\.node_/i;
  var requirePaths = require('module').globalPaths;
  var newPaths = [];

  for (var i=0; i < requirePaths.length; i++) {
    if (requirePaths[i].match(re))  continue;
    newPaths.push(requirePaths[i]);
  }

  require('module').globalPaths = newPaths;
  
  var url = require('url');

  // Skip "?loadSettings=".
  var fileUri = url.parse(window.location.href);
  
  var queryParts = fileUri.query.split('&');
  var loadSettingsStr = null;
  
  for(var j=0; j < queryParts.length; j++) {
    if (queryParts[j].match(/loadSettings/)) {
      loadSettingsStr = queryParts[j].replace("loadSettings=", "");
      break;
    }
  }
  
  var loadSettings = JSON.parse(decodeURIComponent(loadSettingsStr));

  // Require before the module cache in dev mode
  window.loadSettings = loadSettings;

  var noCommitVersion = loadSettings.version.split('-')[0];
  var shouldSuppressErrors = loadSettings.devMode;
  if (!loadSettings.isSpec) {
    require('../src/renderer/bugsnag-setup')(shouldSuppressErrors, noCommitVersion);
  }

  // Start the crash reporter before anything else.
  /* TODO: This seems to not work, need to investigate
  require('crash-reporter').start({
    productName: 'Slack',
    companyName: 'Slack Technologies',
    // By explicitly passing the app version here, we could save the call
    // of "require('remote').require('app').getVersion()".
    extra: {_version: loadSettings.appVersion}
  });
  */

  require(loadSettings.bootstrapScript);
  require('ipc').send('window-command', 'window:loaded');
};


document.addEventListener("DOMContentLoaded", function() {
  try {
    startup();
  } catch (e) {
    console.log(e.stack);
    
    if (window.Bugsnag) {
      window.Bugsnag.notifyException(e, "Renderer crash");
    }
    
    throw e;
  }
});
