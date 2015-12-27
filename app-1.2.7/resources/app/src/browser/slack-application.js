const app = require('app');
const fs = require('fs');
const pfs = require('../promisify')(require('fs'));
const ipc = require('./ipc-rx');
const path = require('path');
const rx = require('rx');
const mkdirp = require('mkdirp');
const protocol = require('protocol');
const shell = require('shell');
const dialog = require('dialog');
const _ = require('lodash');
const spawn = require('child_process').spawn;
const temp = require ('temp');
const {p} = require('../get-path');

const SlackWindow = require ('./slack-window');
const SlackAppMenu = require ('./slack-appmenu');
const Reporter = require ('./metrics-reporter');
const NotificationController = require ('./notification-controller');
const PersistSettingsWindowBehavior = require ('./behaviors/persist-settings-window-behavior');
const RepositionWindowBehavior = require ('./behaviors/reposition-window-behavior');
const EditingCommandsWindowBehavior = require ('./behaviors/editing-commands-window-behavior');
const RunFromTrayWindowBehavior = require ('./behaviors/run-from-tray-window-behavior');
const TrayHandler = require ('./tray-handler');
const TaskbarHandler = require ('./taskbar-handler');
const LocalStorage = require ('./local-storage');
const BrowserWindow = require ('browser-window');
const {isWindows10OrHigher, getOSVersion} = require('../native-interop');
const {parseProtocolUrl} = require('../parse-protocol-url');

import repairTrayRegistryKey from '../csx/tray-repair';

let logger = null;

// Public: The main entry point for state in the application. Lives in the
// browser context and is always accessible via `global.slackApplication`
class SlackApplication {
  // Public: Exits the application
  //
  // status - the exit code to return to the calling process
  exit(status) {
    _.each(Object.keys(this.childWindowsToClose), (x) => {
      BrowserWindow.fromId(parseInt(x)).close();
      var browser_window = BrowserWindow.fromId(parseInt(x));
      if (browser_window) browser_window.destroy();
    });

    if (this.testMode) app.quit(status);

    this.trayDisp.dispose();
    this.localStorage.save();

    this.metricsReporter.dispose().subscribe(
      (() => app.quit(status)),
      (() => app.quit(status))
    );
  }

  // Public: Creates a new instance
  //
  // options - Options parsed from command line arguments
  //           :resourcePath - The path that the application source code is being
  //                           loaded from
  //           :version - The application version
  //           :devMode - Indicates a custom resourcePath was passed and CoffeeScript
  //                      should be dynamically parsed. Also suppresses metrics and
  //                      crash reporting
  //           :testMode - Indicates the app should run specs then exit
  //           :liveReload - Enables file watches on app source that will restart the
  //                         app on changes
  //           :specPath - Path to the specs to run against this code
  //           :logFile - Log file to be used when writing spec results. Unused during
  //                      normal app execution
  constructor(options) {
    this.resourcePath = options.resourcePath;
    this.devMode = options.devMode;
    this.testMode = options.testMode;
    this.liveReload = options.liveReload;
    this.specPath = options.specPath;
    this.logFile = options.logFile;
    this.socketPath = options.socketPath;
    this.openDevToolsOnStart = options.openDevToolsOnStart;
    this.invokedOnStartup = options.invokedOnStartup;

    temp.track();

    repairTrayRegistryKey();

    logger = require('./logger').init(__filename, this);
    this.setupSingleInstance();

    global.slackApplication = this;
    this.loadSettings = _.extend({}, options);

    let packageJson = require('../../package.json');
    this.version = options.version || packageJson.version;
    this.versionName = packageJson.versionName;
    this.loadSettings.version = this.version;

    global.loadSettings = this.loadSettings;

    logger.info(`Welcome to Slack ${this.version} ${process.arch}`);

    this.localStorage = new LocalStorage();
    this.useHwAcceleration = this.localStorage.getItem('useHwAcceleration') !== false;
    let autoHideMenuBar = this.localStorage.getItem('autoHideMenuBar') === true;
    logger.info(`Hardware acceleration: ${this.useHwAcceleration}`);
    logger.info(`Auto-hide menu bar: ${autoHideMenuBar}`);

    let repositionWindow = new RepositionWindowBehavior();
    let editingCommands = new EditingCommandsWindowBehavior();
    this.runFromTray = new RunFromTrayWindowBehavior(this.localStorage);
    this.persistSettings = new PersistSettingsWindowBehavior(this.localStorage);

    this.addSettingsFromProtoUrl(options, [
      'releaseChannel',
      'pretendNotReallyWindows10'
    ]);

    app.allowNTLMCredentialsForAllDomains(true);

    if (process.platform === 'darwin') {
      let osVer = getOSVersion();

      if (osVer.major * 100 + osVer.minor >= (10*100 + 10) /* >= 10.10.0 */) {
        options['title-bar-style'] = 'hidden';
      }
    } else {
      this.loadSettings.fallbackDictionary = this.unpackEnglishDictionary();
    }

    // NB: No idea why, but passing the protoUrl as an argument to
    // BrowserWindow on start-up prevents it from loading.
    let windowOpts = _.extend(_.omit(options, 'protoUrl'), {
      resourcePath: this.resourcePath,
      bootstrapScript: require.resolve('../renderer/main'),
      useHwAcceleration: this.useHwAcceleration,
      autoHideMenuBar: autoHideMenuBar,
      'accept-first-mouse': true,
      behaviors: [repositionWindow, editingCommands, this.runFromTray, this.persistSettings]
    });

    if (this.testMode) {
      this.runSpecs();
      return;
    }

    let fixupIconPostLoad = () => {};

    if (isWindows10OrHigher(true) && !this.loadSettings.devMode) {
      // NB: Windows 10 applications don't have window icons
      windowOpts.icon = require.resolve('../../static/spaceball.png').replace('app.asar', 'app.asar.unpacked');

      fixupIconPostLoad = () => {
        let iconPath = require.resolve('../../static/app-win10.ico').replace('app.asar', 'app.asar.unpacked');
        require('../csx/set-window-icon')(iconPath);
      };
    }

    this.window = new SlackWindow(windowOpts);
    this.metricsReporter = new Reporter(this.window);
    if (!this.devMode) this.window.reporter = this.metricsReporter;

    let menuOpts = {
      devMode: this.devMode || process.env.SLACK_DEVELOPER_MENU || this.openDevToolsOnStart,
      autoHideMenuBar: autoHideMenuBar,
      reporter: this.metricsReporter
    };
    this.menu = new SlackAppMenu(menuOpts);

    logger.info(`Arguments passed to SlackApplication,
      resourcePath: ${this.resourcePath}, version: ${this.version}`);

    this.window.on('close', () => this.persistSettings.saveSettings());
    this.window.on('closed', () => this.exit(0));

    this.window.loadIndex(false);
    this.window.on('did-finish-load', () => {
      this.window.didFinishLoad = true;

      // If we're invoked on startup *and* we can run in the tray, don't show
      // the window on startup
      logger.info(`invokedOnStartup: ${this.invokedOnStartup}, runFromTray.isEnabled: ${this.runFromTray.isEnabled}`);

      setTimeout(fixupIconPostLoad, 5*1000);

      this.window.show();
      this.migratePreferences();

      if (options.protoUrl) {
        logger.info(`protoUrl: ${options.protoUrl}`);
        this.handleDeepLink(options.protoUrl);
      }

      // NB: If we let the window stay hidden like we want to, the app
      // doesn't fully load and people don't get notifications
      if (this.invokedOnStartup) {
        this.window.minimize();
      }

      if (this.openDevToolsOnStart) {
        this.window.toggleDevTools();
      }
    });

    this.menu.attachToWindow(this.window);
    this.handleMenuItems(this.menu);
    this.handleSlackResourcesProtoUrl();

    this.notifier = new NotificationController({
      mainWindow: this.window,
      loadSettings: this.loadSettings,
      useHwAcceleration: this.useHwAcceleration
    });

    this.trayDisp = process.platform !== 'darwin' ?
      this.setupWindowsListeners() :
      rx.Disposable.empty;

    ipc.listen('teams:team-changed').subscribe((args) => {
      // NB: During initial sign-in, our team will be the dummy sentinel team, so
      // we can't use the team name
      let title = 'Slack';
      if (args && args.teamName && args.teamName.length > 2) {
        title = `${args.teamName} - Slack`;
      }
      this.window.setTitle(title);
    });

    ipc.listen('runFromTray').subscribe((args) => {
      if (args) {
        this.runFromTray.enable();
      } else {
        this.runFromTray.disable();
      }
    });

    if (process.platform === 'win32') {
      ipc.listen('windowFlashBehavior').subscribe((args) => {
        this.localStorage.setItem('windowFlashBehavior', args);
        this.taskbarHandler.attach(args, this.runFromTray.isEnabled);
      });
    }

    ipc.listen('useHwAcceleration').subscribe((args) => {
      this.useHwAcceleration = args;
      this.localStorage.setItem('useHwAcceleration', args);
    });

    ipc.listen('teams:update-menu').subscribe((args) => {
      this.menu.updateTeamItems(args);
    });

    ipc.listen('window:reload').subscribe(() => {
      this.reload();
    });

    ipc.listen('window:progress').subscribe((args) => {
      let browserWindow = this.window.window;
      browserWindow.setProgressBar(args);
    });

    // See ssb/main.js and ssb/window-api.js for what this is about, forward
    // JS evals to the window it belongs to
    ipc.listen('eval-async').subscribe((data) => {
      require('nslog')(`Browser Args! ${JSON.stringify(data)}`);

      let wnd = null;
      if (!data.browserWindowId || !(wnd = BrowserWindow.fromId(data.browserWindowId))) {
        logger.error(`Sent eval message with bad window ID: ${JSON.stringify(data)}`);
        return;
      }

      wnd.webContents.send('eval-async', data);
    });

    // See ssb/window-api.js for the other side of this secret handshake
    this.childWindowsToClose = {};

    ipc.listen('child-window-created').subscribe((args) => {
      this.childWindowsToClose[args] = true;
    });

    ipc.listen('child-window-removed').subscribe((args) => {
      if (this.childWindowsToClose[args]) {
        delete this.childWindowsToClose[args];
      }
    });

    let tracing = null;
    let tracingSession = new rx.SerialDisposable();

    ipc.listen('tracing:start').subscribe(() => {
      tracing = tracing || require('content-tracing');

      tracing.startRecording('*', 'enable-sampling,enable-systrace', () => {});
      tracingSession.setDisposable(rx.Disposable.create(() => {
        tracing.stopRecording('', (tracingPath) => {
          logger.info(`Content logging written to ${tracingPath}`);
        });
      }));
    });

    ipc.listen('tracing:stop').subscribe(() =>
      tracingSession.setDisposable(rx.Disposable.empty));

    this.autoUpdateDisp = new rx.SerialDisposable();
    this.autoUpdateDisp.setDisposable(this.setupAutomaticUpdates());
    
    ipc.listen('set-release-channel').subscribe((channel) => {
      this.setReleaseChannel(channel);
    });
  }
  
  // Private: Occurs when the user changes release changes, either via a webapp
  // message or a protocol link. We stash the channel in localStorage and reset
  // our auto-updater with the new URL.
  //
  // channel - The new channel, either 'prod' or 'beta'
  setReleaseChannel(channel) {
    logger.info(`Moving to the ${channel} release channel`);

    let previousChannel = this.localStorage.getItem('releaseChannel');
    this.localStorage.setItem('releaseChannel', channel);
    
    // NB: This will cancel our existing update timer and start a new one
    this.autoUpdateDisp.setDisposable(this.setupAutomaticUpdates());
    
    if (process.platform === 'win32' && previousChannel !== channel) {
      let message = channel === 'beta' ?
        "You have been added to the Beta Release Channel! Contact Slack Support at https://my.slack.com/help if you encounter any issues or if you'd prefer to opt out." :
        'You have been removed from the Beta Release Channel. Back to your regularly scheduled program…';
  
      this.trayHandler.showBalloon({
        title: "Slack for Windows Beta",
        content: message
      });
    }
  }
  
  // Public: Creates a spec window and runs the tests
  runSpecs() {
    let windowOpts = _.extend({
      resourcePath: this.resourcePath,
      devMode: this.devMode,
      liveReload: this.liveReload,
      specPath: this.specPath,
      testMode: this.testMode,
      logFile: this.logFile
    }, {
      bootstrapScript: path.resolve(this.specPath, 'spec-bootstrap'),
      isSpec: true
    });

    windowOpts.version = this.loadSettings.version;

    if (this.specWindow) {
      this.specWindow.close();
    }

    this.specWindow = new SlackWindow(windowOpts);
    this.specWindow.loadIndex(true, `${this.resourcePath}/static/spec-host.html`);
  }

  // Public: Reloads the currently focused window, or the main window if
  // nothing is in focus
  reload() {
    let window = BrowserWindow.getFocusedWindow();
    if (!window) {
      window = this.window;
    }

    logger.info(`Reloading window with ID: ${window.id}`);

    if (window.id === this.window.window.id) {
      window.setTitle('Slack');
    }

    // On reload, we blow away all of the Spaces / Dropboxy windows / other stuff
    _.each(Object.keys(this.childWindowsToClose), (x) => {
      BrowserWindow.fromId(parseInt(x)).close();
      var browser_window = BrowserWindow.fromId(parseInt(x));
      if (browser_window) browser_window.destroy();
    });
    this.childWindowsToClose = {};

    window.reload();
  }

  // Private: Sets up event handlers for our menu items. Try not to do too much
  // work in this method
  handleMenuItems(menu) {
    menu.on('application:quit', () => {
      logger.info('Quitting from menu handler');
      this.exit(0);
    });

    menu.on('application:about', () => this.showAbout());

    menu.on('window:reload', () => this.reload());

    menu.on('window:toggle-full-screen', () => this.window.toggleFullScreen());

    menu.on('window:auto-hide-menu-bar', (menuItem) => {
      let mainWindow = this.window.window;
      mainWindow.setAutoHideMenuBar(!menuItem.checked);
      mainWindow.setMenuBarVisibility(menuItem.checked);

      let prevVisibility = this.localStorage.getItem('autoHideMenuBar');
      if (!prevVisibility && prevVisibility !== false && this.trayHandler) {
        this.trayHandler.showBalloon({
          title: "Farewell, Menu Bar!",
          content: "The menu bar is now hidden when not in use. Press the Alt key to show it."
        });
      }

      this.localStorage.setItem('autoHideMenuBar', !menuItem.checked);
    });

    menu.on('window:toggle-dev-tools', () => {
      this.window.toggleDevTools();
      if (this.specWindow) this.specWindow.toggleDevTools();
    });

    menu.on('application:run-specs', () => this.runSpecs());

    menu.on('application:check-for-update', () => this.checkForUpdates());

    menu.on('window:actual-size', () => {
      if (this.window) {
        this.window.send('window:actual-size');
      }
    });

    menu.on('window:zoom-in', () => {
      if (this.window) {
        this.window.send('window:zoom-in');
      }
    });

    menu.on('window:zoom-out', () => {
      if (this.window) {
        this.window.send('window:zoom-out');
      }
    });

    menu.on('application:show-settings', () => {
      if (this.window) {
        this.window.send('application:show-settings');
      }
    });

    menu.on('window:select-next-team', () => {
      if (this.window) {
        this.window.send('window:select-next-team');
      }
    });

    menu.on('window:select-previous-team', () => {
      if (this.window) {
        this.window.send('window:select-previous-team');
      }
    });

    menu.on('window:signin', () => {
      if (this.window) {
        this.window.send('window:signin');
      }
    });

    this.setUpEditingCommands(menu);
  }

  // Private: Populates localStorage and our loadSettings structure with values
  // taken from a protocol URL; refer to {parseProtocolUrl} in main.js
  //
  // options - A structure created from command-line options
  // protoUrlKeys - An array of names identifying protocol URL parameters
  addSettingsFromProtoUrl(options, protoUrlKeys) {
    for (let key of protoUrlKeys) {
      let value = options[key] || this.localStorage.getItem(key);
      this.localStorage.setItem(key, value);
      this.loadSettings[key] = value;
    }
  }

  // Private: Sets up event handlers for the core editing commands, which are
  // handled by the web contents of the main `BrowserWindow`
  setUpEditingCommands(menu) {
    let webContents = this.window.window.webContents;

    menu.on('core:undo', () => webContents.undo());
    menu.on('core:redo', () => webContents.redo());
    menu.on('core:cut', () => webContents.cut());
    menu.on('core:copy', () => webContents.copy());
    menu.on('core:paste', () => webContents.paste());
    menu.on('core:select-all', () => webContents.selectAll());
  }

  // Public: Starts a timer that will check for updates every 6 hours
  //
  // Returns a {Disposable} that cancels the timer
  setupAutomaticUpdates() {
    return rx.Observable.timer(0, 6*60*60*1000).subscribe(() => {
      if (this.devMode || this.testMode) return;
      if (process.env.SLACK_NO_AUTO_UPDATES) return;

      let tmpDir = process.env.TMPDIR || process.env.TEMP || '/tmp';
      if (process.execPath.indexOf(tmpDir) >= 0) {
        logger.warn("Would've updated, but appears that we are running from temp dir, skipping!");
        return;
      }

      let updater = this.getSquirrelUpdater();
      if (!updater) return;

      // NB: There are some differences between the platform-specific updater
      // implementations. On Windows, `checkForUpdates` is just the check, it
      // doesn't actually spawn an update process. On Mac, `checkForUpdates`
      // does everything we need.
      switch (process.platform) {
      case 'win32':
        updater.doBackgroundUpdate().subscribe(
          (x) => logger.info(`Background update returned ${x}`),
          (ex) => logger.error(`Failed to check for updates: ${JSON.stringify(ex)}`)
        );
        break;

      case 'darwin':
        updater.checkForUpdates().subscribe(
          (x) => logger.info(`Squirrel update returned ${x}`),
          (ex) => logger.error(`Failed to check for updates: ${JSON.stringify(ex)}`)
        );
        break;
      }
    });
  }

  // Public: Forwards deep-link URLs to the web-app for processing
  //
  // url - The URL, which uses our custom 'slack:' protocol
  //
  // Returns nothing
  handleDeepLink(url) {
    // NB: If we get called before we're fully set up, defer until later
    if (!this.window || !this.window.didFinishLoad) {
      setTimeout(() => this.handleDeepLink(url), 50);
      return;
    }
    
    let args = parseProtocolUrl(url);
    if (args.releaseChannel) {
      this.setReleaseChannel(args.releaseChannel);
    }

    let webContents = this.window.window.webContents;
    logger.info(`Forwarding deep-link URL to SSB: ${url}`);
    webContents.send('application:deep-link', url);
  }

  // Public: Sets up a protocol handler for 'slack-resources', which is used by
  // the SSB to load precached images. We effectively just treat requests as special
  // file:// URLs that must be files in our app directory.
  //
  // Returns a {Disposable} that will unregister the handler.
  handleSlackResourcesProtoUrl() {
    let theResourcePath = this.resourcePath;

    protocol.registerBufferProtocol('slack-resources', async function(rq, completion) {
      let relativeFilePath = decodeURIComponent(rq.url).replace(/^slack-resources:/i, '');
      logger.info(`Want to load: ${relativeFilePath}`);

      let mimeType = 'application/octet-stream';
      if (relativeFilePath.match(/.png$/i)) mimeType = 'image/png';
      if (relativeFilePath.match(/.jpe?g$/i)) mimeType = 'image/jpeg';
      if (relativeFilePath.match(/.mp3$/i)) mimeType = 'audio/mpeg3';

      let absPath = null;
      try {
        absPath = path.resolve(theResourcePath, 'static', relativeFilePath);

        if (absPath.indexOf(theResourcePath) !== 0) {
          throw new Error(`Attempted to use slack-resources to access data outside static: ${absPath}`);
        }
      } catch (e) {
        logger.error(`Failed to load resource ${rq.url}: ${e.message}\n${e.stack}`);
        completion({ error: -6 /*net::ERR_FILE_NOT_FOUND*/});
        return;
      }

      try {
        let buf = await pfs.readFile(absPath);
        completion({data: buf, mimeType: mimeType});
      } catch (e) {
        logger.error(`Failed to read file ${absPath}: ${e.message}\n${e.stack}`);
        completion({ error: -2 /*net::FAILED*/});
        return;
      }
    });

    return rx.Disposable.create(() => protocol.unregisterProtocol('slack-resources'));
  }

  // Public: Sets up the notification tray handler and window flash, both features
  // specific to Windows
  //
  // Returns a {Disposable} that will unsubscribe all listeners and remove the
  // tray icon
  setupWindowsListeners() {
    this.trayHandler = new TrayHandler(this.window, this.localStorage);
    let trayDisp = this.trayHandler.attach(this.loadSettings);
    this.runFromTray.trayHandler = this.trayHandler;

    let clickDisp = this.trayHandler.clicked.subscribe(() => {
      this.window.bringToForeground();
    });

    this.windowFlashBehavior = this.localStorage.getItem('windowFlashBehavior') || 'idle';
    this.taskbarHandler = new TaskbarHandler(this.window);
    this.taskbarHandler.attach(this.windowFlashBehavior, this.runFromTray.isEnabled);
    let flashDisp = rx.Disposable.create(() => this.taskbarHandler.dispose());

    return new rx.CompositeDisposable(trayDisp, clickDisp, flashDisp);
  }

  // Public: Creates server to listen for additional application launches.
  //
  // You can run the slack command multiple times, but after the first launch
  // the other launches will just pass their information to this server and then
  // close immediately.
  //
  // Returns nothing
  setupSingleInstance() {
    let bringToForeground = () => {
      if (this.window && this.window.didFinishLoad) {
        this.window.bringToForeground();
      } else {
        setTimeout(bringToForeground, 500);
      }
    };

    var otherAppSignaledUs = new rx.Subject();
    global.secondaryParamsHandler = (cmd) => otherAppSignaledUs.onNext(cmd);

    otherAppSignaledUs.startWith(...global.secondaryParamsReceived)
      .subscribe((cmd) => {
        bringToForeground();

        let re = /^slack:/i;
        let protoUrl = _.find(cmd, (x) => x.match(re));

        if (protoUrl) this.handleDeepLink(protoUrl);
      });
  }

  // Private: Remove the socket file that we're creating in {setupSingleInstance}
  // once we're done.
  //
  // Returns nothing
  deleteSocketFile() {
    if (process.platform === 'win32') return;

    if (fs.existsSync(this.socketPath)) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch (error) {
        // Ignore ENOENT errors in case the file was deleted between the exists
        // check and the call to unlink sync. This occurred occasionally on CI
        // which is why this check is here.
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  // Public: Hunspell can't deal with ASAR, so we need to blit these files out to
  // a separate directory. We'll choose our root install directory + '\dictionaries'.
  //
  // Returns the target dir where we put the dictionaries as a {String}.
  unpackEnglishDictionary() {
    let sourceDir = path.resolve(this.resourcePath, 'node_modules',
      'spellchecker', 'vendor', 'hunspell_dictionaries');

    let targetDir = process.platform === 'win32' ?
      path.join(path.dirname(process.execPath), '..', 'dictionaries') :
      path.join(app.getPath('userData'), 'dictionaries');

    mkdirp.sync(targetDir);

    let toUnpack = [
      'en_US.dic',
      'en_US.aff'
    ];

    for (let filename of toUnpack) {
      let source = path.join(sourceDir, filename);
      let target = path.join(targetDir, filename);
      if (fs.statSyncNoException(target)) continue;

      let buf = fs.readFileSync(source);
      fs.writeFileSync(target, buf);
    }

    return targetDir;
  }

  // Public: Checks for available updates using Squirrel and displays a message
  // box based on the result. If an update is available the user is given the
  // option to upgrade immediately.
  //
  // Returns Nothing
  checkForUpdates() {
    let updater = this.getSquirrelUpdater();
    let updateInformation = 'https://www.slack.com/apps/windows/release-notes';
    if (!updater) return;

    let hasAnUpdate = () => {
      let options = {
        title: 'An update is available',
        buttons: ['Close', "What's New", "Update Now"],
        message: 'A new version of Slack is available!'
      };

      dialog.showMessageBox(this.window.window, options, (response) => {
        if (response === 1) {
          shell.openItem(updateInformation);
        }

        if (response === 2) {
          updater.forceUpdateAndRestart(() => this.exit(0));
        }
      });
    };

    let alreadyUpToDate = () => {
      let options = {
        title: "You're all good",
        buttons: ['Ok'],
        message: "You've got the latest version of Slack, thanks for staying on the ball."
      };

      dialog.showMessageBox(this.window.window, options);
    };

    let somethingBadHappened = () => {
      let options = {
        title: "We couldn't check for updates",
        buttons: ['Ok'],
        message: "Check your Internet connection, and contact support if this issue persists."
      };

      dialog.showMessageBox(this.window.window, options);
    };

    updater.checkForUpdates().subscribe(
      (update) => {
        if (update) hasAnUpdate();
        else alreadyUpToDate();
      },
      (e) => {
        logger.error(`Failed to check for updates: ${e.message}\n${e.stack}`);
        somethingBadHappened();
      });
  }

  // Private: Shows an about box with version and license information
  //
  // Returns Nothing
  showAbout() {
    let options = {
      title: 'About Slack',
      buttons: ['Close', 'Acknowledgements'],
      message: 'Installed Version:',
      detail: `${this.versionName} (${this.version.split('-')[0]} ${process.arch === 'x64' ? '64-bit' : '32-bit'})`
    };

    dialog.showMessageBox(this.window.window, options, (response) => {
      // Check if user clicked Acknowledgements
      if (response !== 1) return;

      if (process.platform === 'win32') {
        let licensePath = path.resolve(process.resourcesPath, '..', 'LICENSE');
        let notepad = p`${'SYSTEMROOT'}/system32/notepad.exe`;

        if (fs.existsSync(notepad)) {
          spawn(notepad, [licensePath]);
        }
      } else {
        let licensePath = path.resolve(process.resourcesPath, 'LICENSE');
        shell.openItem(licensePath);
      }
    });
  }

  // Private: Returns a platform-specific implementation of `SquirrelUpdater`,
  // or null if updates are unsupported
  getSquirrelUpdater() {
    let SquirrelUpdater = null;
    switch (process.platform) {
    case 'linux':
      logger.warn('No updater exists for this platform');
      return null;
    case 'win32':
      SquirrelUpdater = require('./windows-updater');
      break;
    case 'darwin':
      SquirrelUpdater = require('./mac-updater');
      break;
    }

    return new SquirrelUpdater({
      version: this.version,
      useBetaChannel: this.localStorage.getItem('releaseChannel') === 'beta'
    });
  }

  // Private: Performs one-time migration of preferences to ensure that the
  // values persisted in browser localStorage make it to the SSB localStorage
  migratePreferences() {
    if (!this.localStorage.getItem('hasMigratedPreferences')) {
      let webContents = this.window.window.webContents;
      let preferences = JSON.stringify({
        runFromTray: this.runFromTray.isEnabled,
        useHwAcceleration: this.useHwAcceleration,
        windowFlashBehavior: this.windowFlashBehavior
      });

      logger.info(`Migrating preferences: ${preferences}`);
      webContents.send('preferenceBulkChange', preferences);
      this.localStorage.setItem('hasMigratedPreferences', 'sureDid');
    }
  }
}

module.exports = SlackApplication;
