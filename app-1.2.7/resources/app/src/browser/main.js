global.shellStartTime = Date.now();

// NB: Stop a rare crash where debug tries to write to an fd and fails,
// brings down the app
require('debug').log = console.info.bind(console);

const app = require('app');
const fs = require('fs');
const mkdirp = require('mkdirp');
const path = require('path');
const optimist = require('optimist');
const spawn = require('../spawn-rx');
const _ = require('lodash');

const BugsnagReporter = require('./bugsnag-reporter');
const {isWindows10OrHigher} = require('../native-interop');
const {parseProtocolUrl} = require('../parse-protocol-url');
const {p} = require('../get-path');
const setupCrashReporter = require('../setup-crash-reporter');

console.log = require('nslog');

let logger = null;
let successfullyLaunched = false;

function createSlackApplication(args) {
  global.reporter = new BugsnagReporter(args.resourcePath, args.devMode);

  console.log("Creating Slack Application");
  global.reporter.autoNotify(() => {
    let SlackApplication = null;
    
    setupCrashReporter(args);
    
    if (args.devMode) {
      SlackApplication = require(path.join(args.resourcePath, 'src', 'browser', 'slack-application'));
    } else {
      SlackApplication = require('./slack-application');
    }

    global.slackApplication = new SlackApplication(args);

    logger = require('./logger').init(__filename);
    global.devMode = args.devMode;

    successfullyLaunched = true;

    if (!args.testMode) {
      logger.info(`App load time: ${Date.now() - global.shellStartTime}ms`);
    }
  });
}

// Private: Parses command line options and returns a cleaned-up version to the
// caller.
//
// Returns an object with sanitized versions of the command-line parameters.
// Check the return value for supported options.
function parseCommandLine() {
  let version = app.getVersion();

  let re = /^slack:/i;
  let argList = _.clone(process.argv.slice(1));
  let protoUrl = _.find(argList, (x) => x.match(re));
  argList = _.filter(argList, (x) => !x.match(re));

  let options = optimist(argList);
  options.usage(`Slack Client v${version}`);

  options.alias('f', 'foreground').boolean('f').describe('f', 'Keep the browser process in the foreground.');
  options.alias('h', 'help').boolean('h').describe('h', 'Print this usage message.');
  options.alias('l', 'log-file').string('l').describe('l', 'Log all output to file.');
  options.alias('r', 'resource-path').string('r').describe('r', 'Set the path to the Atom source directory and enable dev-mode.');
  options.alias('t', 'tests').boolean('t').describe('t', 'Run the tests and exit.');
  options.alias('s', 'spec-path')
    .string('s')
    .describe('s', 'Set the directory from which to run package specs (default: Standard spec directory).');
  options.alias('e', 'livereload')
    .boolean('e')
    .describe('e', 'Automatically reload the app if the source files are changed in dev-mode.');
  options.alias('u', 'startup')
    .boolean('u')
    .describe('u', 'The app is being started via a Startup shortcut. Hide the window on Win32');
  options.alias('v', 'version').boolean('v').describe('v', 'Print the version.');
  let args = options.argv;

  if (args.help) {
    process.stdout.write(options.help());
    process.exit(0);
  }

  if (args.version) {
    process.stdout.write(`${version}\n`);
    process.exit(0);
  }

  let testMode = args.tests;
  let devMode = args.dev;
  let liveReload = args.livereload;
  let logFile = args['log-file'];
  let specPath = args['spec-path'];
  let invokedOnStartup = args.startup;

  let resourcePath = path.join(process.resourcesPath, 'app.asar');
  if (args['resource-path']) {
    devMode = true;
    resourcePath = args['resource-path'];
  }

  if (!fs.statSyncNoException(resourcePath)) {
    resourcePath = path.dirname(path.dirname(__dirname));
  }

  resourcePath = path.resolve(resourcePath);

  specPath = specPath || path.resolve(resourcePath, 'spec');

  return {resourcePath, version, devMode, testMode, logFile, liveReload, specPath, protoUrl, invokedOnStartup};
}

// Private: The main entry point for the application, in the case where we are
// not handling Squirrel events.
//
// Returns Nothing
function start(args) {
  // TODO: Linux it up
  //let flashName = process.platform === 'win32' ?
  //  'pepflashplayer.dll' :
  //  'PepperFlashPlayer.plugin';

  // Set up Pepper Flash
  //app.commandLine.appendSwitch('ppapi-flash-path', path.join(process.resourcesPath, 'app.asar.unpacked', 'static', 'plugins', process.platform, process.arch, flashName));
  //app.commandLine.appendSwitch('ppapi-flash-version', '18.0.0.129');

  app.commandLine.appendSwitch('flag-switches-begin');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('flag-switches-end');

  if (!args.devEnv && args.devMode) {
    app.commandLine.appendSwitch('remote-debugging-port', '8315');

    let appData = app.getPath('appData');
    app.setPath('userData', path.join(appData, 'SlackDevMode'));
  }

  if (!args.devEnv && !args.devMode) {
    let teamBasedSlackDevMenu = path.join(
      app.getPath('userData'),
      '.devmenu');

    if (fs.statSyncNoException(teamBasedSlackDevMenu)) {
      process.env.SLACK_DEVELOPER_MENU = 'true';
    }
  }

  // NB: Too many people mess with the system Temp directory and constantly are
  // breaking it on Windows. We're gonna use our own instead and dodge like 40
  // bullets.
  if (process.platform !== 'linux') {
    let newTemp = path.join(app.getPath('userData'), 'temp');

    mkdirp.sync(newTemp);
    app.setPath('temp', newTemp);
    process.env.TMPDIR = newTemp;
    process.env.TMP = newTemp;
  }

  app.on('open-url', (e, url) => {
    e.preventDefault();
    logger.info(`Got open-url with: ${url}`);

    // NB: If the user is supplying a dev environment using our protocol URL,
    // open-url comes in too late for us to be able to set the user data path.
    // So we need to relaunch ourselves with the URL appended as args.
    if (url.match(/devEnv=(dev\d+)/)) {
      let newArgs = _.clone(process.argv);
      newArgs.push(url);
      spawn(process.execPath, newArgs, {detached: true}).subscribe();

      // NB: If we were launched via the protocol handler, we want to kill ourselves;
      // if we were invoked via an already running Slack instance (i.e. they want to
      // run the real Slack as well as a dev instance) we want to live
      if (!successfullyLaunched) setTimeout((() => process.exit(0)), 1000);
    } else {
      global.slackApplication.handleDeepLink(url);
    }
  });

  app.on('ready', () => {
    // Filter out user's paths from require search list
    let re = /[\\\/]\.node_/i;
    let requirePaths = require('module').globalPaths;
    let newPaths = [];

    for (let requirePath of requirePaths) {
      if (!requirePath.match(re)) {
        newPaths.push(requirePath);
      }
    }

    // Set our AppUserModelId based on the Squirrel shortcut
    let appId = 'com.squirrel.slack.slack';
    if (args.devMode) appId += '-dev';
    app.setAppUserModelId(appId);

    require('module').globalPaths = newPaths;
    createSlackApplication(args);
  });
}

// Private: Forks to Squirrel in order to install or update our app shortcuts.
//
// finish - A callback to be invoked on completion
// locations - A comma-separated string of shortcut locations to install or update
async function createShortcuts(locations) {
  let target = path.basename(process.execPath);
  let updateDotExe = path.resolve(path.dirname(process.execPath), '..', 'update.exe');
  let shouldInstallStartup = false;

  // NB: 'Startup' is a special snowflake, because we need to add our hint to
  // the app that we're being started on startup
  if (locations.match(/Startup/)) {
    locations = _.filter(locations.split(','), (x) => x !== 'Startup').join(',');
    shouldInstallStartup = true;
  }

  let args = ['--createShortcut', target, '-l', locations];

  if (isWindows10OrHigher()) {
    args.push('--icon');
    args.push(require.resolve('../../static/app-win10.ico').replace('app.asar', 'app.asar.unpacked'));
  }

  await spawn(updateDotExe, args).toPromise();

  if (shouldInstallStartup) {
    args = ['--createShortcut', target, '-l', 'Startup', '-a', '--startup"'];
    await spawn(updateDotExe, args).toPromise();
  }

  let {register} = require('../csx/protocol-handler');
  register();
}

// Private: Forks to Squirrel in order to remove our app shortcuts.
// Called on app uninstall AND app update.
//
// finish - A callback to be invoked on completion
// locations - A comma-separated string of shortcut locations remove
async function removeShortcuts(locations) {
  let target = path.basename(process.execPath);
  let updateDotExe = path.resolve(path.dirname(process.execPath), '..', 'update.exe');
  let args = ['--removeShortcut', target, '-l', locations];

  await spawn(updateDotExe, args).toPromise();

  let {unregister} = require('../csx/protocol-handler');
  unregister();
}

// Private: Updates all app shortcuts by calling `createShortcuts`, then removes any
// inadvertently created shortcuts that didn't exist before.
//
// finish - A callback to be invoked on completion
// locations - A comma-separated string of shortcut locations to update
async function updateShortcuts(locations) {
  let startupShortcut = p`${'appData'}/Microsoft/Windows/Start Menu/Programs/Startup/Slack.lnk`;
  let hasStartupShortcut = fs.statSyncNoException(startupShortcut);

  let desktopShortcut = p`${'userDesktop'}/Slack.lnk`;
  let hasDesktopShortcut = fs.statSyncNoException(desktopShortcut);

  // NB: We need to keep track of which shortcuts don't exist, because
  // update.exe will add them all.
  let toRemove = [];
  if (!hasStartupShortcut) toRemove.push('Startup');
  if (!hasDesktopShortcut) toRemove.push('Desktop');

  await createShortcuts(locations);

  if (toRemove.length > 0) {
    await removeShortcuts(toRemove.join(','));

    let {register} = require('../csx/protocol-handler');
    register();
  }
}

// Private: When our app is installed, Squirrel (our app install/update framework)
// invokes our executable with specific parameters, usually of the form
// '--squirrel-$EVENT $VERSION' (i.e. '--squirrel-install 0.1.0'). This is our
// chance to do custom install / uninstall actions. Once these events are handled,
// we **must** exit imediately
//
// appStart - A callback to be invoked to start the application if there are no
//            Squirrel events to handle.
//
// Returns a {Promise} whose value is a Boolean - if 'true', start the app. If
// 'false', quit immediately.
async function handleSquirrelEvents() {
  let options = process.argv.slice(1);

  if (!(options && options.length >= 1)) return true;

  let m = options[0].match(/--squirrel-([a-z]+)/);
  if (!(m && m[1])) return true;

  if (m[1] === 'firstrun') return true;

  let defaultLocations = 'Desktop,StartMenu,Startup';

  // NB: Babel currently hates switch + await, /shrug
  if (m[1] === 'install') {
    await createShortcuts(defaultLocations);
  }

  if (m[1] === 'updated') {
    await updateShortcuts(defaultLocations);
  }

  if (m[1] === 'uninstall') {
    await removeShortcuts(defaultLocations);

    let taskKill = p`${'SYSTEMROOT'}/system32/taskkill.exe`;
    let args = ['/F', '/IM', 'slack.exe', '/T'];
    await spawn(taskKill, args);
  }

  return false;
}

// NB: This will be overwritten by SlackApplication once we start up for reals
global.secondaryParamsReceived = [];
global.secondaryParamsHandler = (cmd) => {
  global.secondaryParamsReceived.push(cmd);
};

// Go go go go go go go
handleSquirrelEvents()
  .then((shouldRun) => {
    if (!shouldRun || process.platform !== 'linux') return shouldRun;

    let LocalStorage = require('./local-storage');
    let localStorage = new LocalStorage();

    // NB: Linux handles Disable hardware acceleration differently; it requires a
    // command-line switch rather than a window option.
    let disableGpu = localStorage.getItem('useHwAcceleration') === false;
    if (!disableGpu) return shouldRun;

    console.log(`Disabling GPU: ready = ${app.isReady()}`);

    // NB: By the time we figure this out, it's too late, we have to re-exec
    // ourselves. How inconvenient!
    if (_.find(process.argv, (x) => x.match(/disable-gpu/))) {
      return shouldRun;
    }

    console.log("About to fork to disable GPU")
    process.argv.push('--disable-gpu');
    spawn(process.execPath, process.argv).subscribe();

    // We don't want to wait for completion of spawn (since it'll only exit once
    // the app exits), we're just waiting long enough for spawn to init a new
    // process
    return new Promise((resolve) => {
      setTimeout(() => resolve(false), 1000);
    });
  })
  .then((shouldRun) => {
    // NB: We have to flip the user directory _way_ early or else makeSingleInstance
    // will get confused
    let args = parseCommandLine();
    _.extend(args, parseProtocolUrl(args.protoUrl));

    if (args.devEnv) {
      let appData = app.getPath('appData');
      app.setPath('userData', path.join(appData, `SlackDev-${args.devEnv}`));
    }

    // NB: We don't want to mess about with single instance if we're in the
    // process of forking to disable GPU
    if (!shouldRun) {
      app.quit();
      process.exit(0);
    }

    let weAreSecondary = app.makeSingleInstance((cmd) => {
      global.secondaryParamsHandler(cmd);
    });

    if (!shouldRun || weAreSecondary) {
      app.quit();
      process.exit(0);
    }

    start(args);
  })
  .catch((e) => {
    console.log(`Inevitable Demise! ${e.message}`);
    console.log(e.stack);

    app.quit();
    process.exit(0);
  });
