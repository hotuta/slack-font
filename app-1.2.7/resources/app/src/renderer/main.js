// NB: Stop a rare crash where debug tries to write to an fd and fails,
// brings down the app
require('debug').log = console.info.bind(console);

const rx = require('rx');
rx.config.longStackSupport = true;

const TeamsViewController = require('./teams-view-controller');
const Reporter = require('./metrics-reporter');
const DictionarySync = require('./dictionary-sync');
const setupCrashReporter = require('../setup-crash-reporter');

const path = require('path');
const _ = require('lodash');

const logger = require('../browser/logger').init(__filename);

global.slackApplication = require('remote').getGlobal('slackApplication');

if (global.loadSettings.liveReload) {
  const LiveReload = require('./livereload');
  let paths = ['src', 'static', 'spec'];
  let realPaths = _.map(paths, (x) => path.resolve(global.loadSettings.resourcePath, x));

  let liveReload = new LiveReload(realPaths);
  global.attachLiveReload = liveReload.attach();
}

global.dictionarySync = new DictionarySync();
global.dictionarySync.downloadAllLanguagesIfNeeded()
  .subscribe(
    () => logger.debug("Downloaded all languages"),
    (e) => logger.error(`Failed to download dictionaries: ${e.message}`));

// Set us so that we never show scroll bars for the outer content
document.body.setAttribute('style', 'width: 100%; height: 100%; margin:0px; overflow:hidden;');

global.metricsReporter = new Reporter();
setupCrashReporter(global.loadSettings);

if (!global.loadSettings.devMode) {
  global.metricsReporter.handleBrowserEvents();
  global.teamsViewController = new TeamsViewController({reporter: global.metricsReporter});
}

global.teamsViewController = global.teamsViewController || new TeamsViewController();
global.teamsViewController.attachToDom()
  .subscribe(() => logger.info("Attached to DOM"));

window.addEventListener('beforeunload', () => {
  global.metricsReporter.dispose();
  return true;
});
