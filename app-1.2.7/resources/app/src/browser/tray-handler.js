const ipc = require('./ipc-rx');
const path = require('path');
const rx = require('rx');
const Tray = require('tray');
const Menu = require('menu');
const MenuItem = require('menu-item');
const NativeImage = require('native-image');

import repairTrayRegistryKey from '../csx/tray-repair';

let logger = null;

// Public: Manages the tray icon - this class recieves messages from ssb/dock.coffee
// and translates them into calls to `app.dock`.
class TrayHandler {
  constructor(mainWindow, localStorage) {
    this.currentTray = null;
    this.disp = rx.Disposable.empty;
    this.state = 'hidden';
    this.tooltip = '';
    this.clicked = new rx.Subject();
    this.clickedSub = new rx.SerialDisposable();
    this.mainWindow = mainWindow;
    this.localStorage = localStorage;

    if (mainWindow.reporter) {
      this.clicked.throttle(250).subscribe(() =>
        mainWindow.reporter.sendEvent('tray', 'click'));
    }

    logger = logger || require('./logger').init(__filename);
  }

  // Public: Attaches the tray handler and starts listening on IPC for messages from
  // the SSB.
  //
  // Returns a Disposable that will clean up the event handlers as well as remove the
  // Tray icon if it exists
  attach(loadSettings) {
    this.loadSettings = loadSettings;
    let disp = new rx.CompositeDisposable();

    logger.debug("Attaching tray handler");

    disp.add(ipc.listen('tray:set-tool-tip').subscribe((args) =>
      this.setToolTip(args)));

    disp.add(ipc.listen('tray:set-state').subscribe((args) =>
      this.setState(args)));

    disp.add(ipc.listen('tray:show-balloon').subscribe((args) =>
      this.showBalloon(args)));

    disp.add(ipc.listen('tray:set-connection-status').subscribe((args) =>
      this.setConnectionStatus(args)));

    disp.add(rx.Disposable.create(() => {
      if (!this.tray) return;

      this.tray.destroy();
      this.clickedSub.setDisposable(rx.Disposable.empty);
      this.tray = null;
    }));

    this.setToolTip('Slack is starting up');
    this.setState('rest');
    this.welcomeBalloon();

    this.disp = disp;
    return disp;
  }

  // Public: Shows a balloon prompt using the given arguments. Make sure to
  // call this *after* setState or you won't have a tray icon to balloonify.
  //
  // args - An {Object} containing the following keys:
  //   :title - The title to use for the balloon
  //   :content - The message content to display
  //   :icon - (Optional) The icon to display; defaults to the app icon
  //
  // Returns nothing
  showBalloon(args) {
    if (!this.tray) {
      logger.warn(`Attempted to show a balloon before the tray icon exists.`);
      return;
    }

    logger.info(`Showing a tray balloon with title: ${args.title}`);

    // Set a default icon if left unspecified
    if (!args.icon) {
      args.icon = this.resolveImage(this.loadSettings, 'slack.png');
    }

    this.tray.displayBalloon(args);
  }

  // Private: Shows a one-time welcome balloon the first time the tray icon is
  // created, then notes it in `localStorage`.
  welcomeBalloon() {
    if (this.localStorage.getItem('hasShownWelcomeBalloon')) return;
    this.localStorage.setItem('hasShownWelcomeBalloon', 'VeryYes');

    this.showBalloon({
      title: 'Welcome to Slack!',
      content: "This icon will show a blue dot for unread messages, and a red one for notifications. If you'd like Slack to appear here all the time, drag the icon out of the overflow area."
    });
  }

  // Private: Sets the tooltip on an already existing tray
  //
  // tooltip - the {String} to use
  //
  // Returns nothing
  setToolTip(tooltip) {
    this.tooltip = tooltip;
    logger.debug(`Setting tooltip to ${this.tooltip}`);
    if (!this.tray) return;

    this.tray.setToolTip(this.tooltip);
  }

  // Private: Sets the state of the tray icon
  //
  // state - the {String} representing the state, one of:
  //   'rest' - Tray icon is the normal Slack logo
  //   'hidden' - Tray icon is removed from the tray completely
  //   'unread' - Tray icon shows blue dot for unread messages
  //   'highlight'  - Tray icon shows red dot for highlight messages
  //
  // Returns nothing
  async setState(state) {
    if (this.state === state) return;

    logger.debug(`Moving tray state from ${this.state} => ${state}`);
    this.state = state;

    if (this.state === 'hidden') {
      if (this.tray) {
        logger.debug("Destroying tray");
        this.tray.destroy();
        this.clickedSub.setDisposable(rx.Disposable.empty);
        this.tray = null;
      }
      return;
    }

    let img = this.resolveImage(this.loadSettings, `slack-taskbar-${this.state}.png`);
    if (!img) return;

    if (this.tray) {
      logger.debug("Tray exists, setting image");
      this.tray.setImage(img);
    } else {
      await this.createTrayIcon(img);
    }
  }

  // Private: Creates the tray icon
  //
  // image - The image to use for the icon
  //
  // Returns nothing
  createTrayIcon(image) {
    logger.debug(`Tray doesn't exist, making it with '${this.tooltip}'`);

    this.tray = new Tray(image);
    this.tray.setImage(image);

    if (this.tooltip) {
      this.tray.setToolTip(this.tooltip);
    }

    // We use the default dock menu for Mac.
    if (process.platform !== 'darwin') {
      this.createTrayMenu();
    }

    setTimeout(() => repairTrayRegistryKey(), 2*1000);    

    this.clickedSub.setDisposable(rx.Node.fromEvent(this.tray, 'clicked').subscribe(this.clicked));
  }

  setConnectionStatus(connectionStatus) {
    /* NB: We're gonna do this later
    if (connectionStatus === 'online') {
      this.mainWindow.window.setOverlayIcon(null, '');
      return;
    }

    if (connectionStatus === 'connecting') {
      this.mainWindow.window.setOverlayIcon(this.resolveImage(this.loadSettings, 'connection_trouble.png'), 'Slack is connecting');
      return;
    }

    if (connectionStatus === 'unread') {
      this.mainWindow.window.setOverlayIcon(this.resolveImage(this.loadSettings, 'connection_unread.png'), 'Unread messages');
      return;
    }

    if (connectionStatus === 'highlight') {
      this.mainWindow.window.setOverlayIcon(this.resolveImage(this.loadSettings, 'connection_unread.png'), 'Unread messages');
      return;
    }

    // Default to offline because oops
    this.mainWindow.window.setOverlayIcon(this.resolveImage(this.loadSettings, 'connection_offline.png'), 'Slack is offline');
    */
  }

  // Private: Sets up the context menu for the tray icon
  //
  // Returns nothing
  createTrayMenu() {
    let menu = new Menu();

    // NB: Tray icons on Linux always show the menu, so add a separate item for
    // them to activate the window
    if (process.platform === 'linux') {
      menu.append(new MenuItem({
        label: '&Open',
        click: () => this.mainWindow.bringToForeground()
      }));
    }

    menu.append(new MenuItem({
      label: '&Preferences',
      click: () => {
        this.mainWindow.bringToForeground();
        this.mainWindow.send('application:show-settings');
      }
    }));

    menu.append(new MenuItem({
      label: '&Check for Updates...',
      click: () => {
        this.mainWindow.bringToForeground();
        global.slackApplication.checkForUpdates();
      }
    }));

    menu.append(new MenuItem({ type: 'separator'} ));

    menu.append(new MenuItem({
      label: '&Quit',
      click: () => global.slackApplication.exit(0)
    }));

    this.tray.setContextMenu(menu);
  }

  // Public: Disposes the object
  //
  // Returns nothing
  dispose() {
    this.disp.dispose();
  }

  // Private: Looks up an image based on its name. Tray is currently ASAR-unfriendly
  // so we need to unpack the image before we use it
  //
  // Returns a fully qualified path
  resolveImage(loadSettings, imageName) {
    let source = path.resolve(__dirname, '..', '..', 'static', imageName).replace('app.asar', 'app.asar.unpacked');
    logger.info(`About to load image: ${source}`);
    return NativeImage.createFromPath(source);
  }
}

module.exports = TrayHandler;
