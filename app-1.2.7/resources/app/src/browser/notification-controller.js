const rx = require('rx');
const _ = require('lodash');
const ipc = require('./ipc-rx');

const Screen = require('screen');
const SlackWindow = require('./slack-window');
const RepositionWindowBehavior = require('./behaviors/reposition-window-behavior');
const NotificationHelpers = require('./notification-helpers');

const nativeInterop = require('../native-interop');

let logger = null;

// Public: Point of entry for desktop notifications.
// This class is created by {SlackApplication}
class NotificationController {
  // Public: Create a new NotificationController.
  //
  // options - An options hash with the following parameters:
  //
  //     mainWindow - The main {SlackWindow}, which we may need to send messages
  //                  to in response to notification actions (e.g., clicked).
  //
  //     loadSettings - Options passed to the application, that we in turn need
  //                    to pass to any child windows we create.
  //
  //     screenPosition - Options that specify where notifications will appear
  //                      on screen, contains keys `corner` and `display`.
  //
  //     maxCount - The maximum number of notifications to display at one time.
  //
  //     useHwAcceleration - True to render HTML notifications, false to use the
  //                         native SlackNotifier executable.
  constructor(options) {
    logger = require('./logger').init(__filename);

    this.mainWindow = options.mainWindow;
    this.loadSettings = _.extend({}, _.omit(options.loadSettings, 'behaviors', 'reporter'));
    this.screenPosition = options.screenPosition || {corner: 'bottom_right', display: 'same_as_app'};
    this.maxCount = options.maxCount || 3;
    this.useHwAcceleration = options.useHwAcceleration;

    this.zoomLevel = 0;
    this.showHtmlNotifications = process.platform === 'win32';

    this.setupNotificationTarget();
    this.handleNotifications();

    this.handleClickMessages();
    this.handlePreferenceChanges();
    this.handleTransparencySupported();
  }

  // Private: Determines which window will be in charge of notifications.
  // If the user is on a Windows machine and all of the following are true:
  //
  // 1. Hardware acceleration is enabled
  // 2. DWM composition is enabled (this is `supportsTransparentWindows`)
  // 3. Our OS is < Windows 10 (Windows 10 has native notifications)
  //
  // Then we'll show HTML5 notifications within the host window. Otherwise
  // we'll call into the SlackNotifier.dll.
  setupNotificationTarget() {
    this.showHtmlNotifications = process.platform === 'win32' &&
      this.useHwAcceleration &&
      nativeInterop.supportsTransparentWindows() &&
      !nativeInterop.isWindows10OrHigher();

    // NB: HTML notifications require our host window to be created. If we're
    // delegating to the main window we were born ready.
    this.isReady = !this.showHtmlNotifications;

    this.disp = new rx.CompositeDisposable();

    if (this.showHtmlNotifications) {
      let currentWindowDisp = new rx.SerialDisposable();

      currentWindowDisp.setDisposable(this.setupHostWindow());
      this.disp.add(currentWindowDisp);

      let anyDisplayChanged = rx.Observable.merge(
        rx.Node.fromEvent(Screen, 'display-added'),
        rx.Node.fromEvent(Screen, 'display-removed'),
        rx.Node.fromEvent(Screen, 'display-metrics-changed')
      );

      anyDisplayChanged
        .throttle(500)
        .do(() => logger.info('Display changed! Recreating notifications window'))
        .subscribe(() => {
          currentWindowDisp.setDisposable(rx.Disposable.empty);
          currentWindowDisp.setDisposable(this.setupHostWindow());
        });
    }
  }

  // Private: Creates a transparent window that will host
  //          notification elements.
  //
  // Returns a {Disposable} that will clean up anything used by this method.
  setupHostWindow() {
    // NB: RepositionWindowBehavior guarantees this callback will only be called
    // when the window is already visible, so this will only affect size and position
    let repositionWindow = new RepositionWindowBehavior({
      recalculateWindowPositionFunc: () => this.showHostWindow()
    });

    // Pass in a script which will be the entry point of this window's renderer process.
    let windowOpts = _.extend(this.loadSettings, {
      bootstrapScript: require.resolve('../notification/main'),
      screenPosition: this.screenPosition,
      maxCount: this.maxCount,
      behaviors: [repositionWindow],
      frame: false,
      resizable: false,
      show: false,
      title: "Slack",
      "accept-first-mouse": true,
      "always-on-top": true,
      "skip-taskbar": true,
      "transparent": true,
      "web-preferences": {
        "subpixel-font-scaling": true,
        "direct-write": true
      }
    });

    logger.debug(`Creating notification host: ${JSON.stringify(windowOpts)}`);
    this.hostWindow = new SlackWindow(windowOpts);
    this.hostWindow.loadIndex(false);

    let disp = new rx.CompositeDisposable();

    disp.add(this.setupIpcListeners());

    disp.add(rx.Disposable.create(() => {
      if (this.hostWindow) {
        this.hostWindow.close();
        this.hostWindow = null;
      }
    }));

    return disp;
  }

  // Private: Sets up IPC listeners for all notification-related messages.
  //
  // Returns a Disposable that will unsubscribe all listeners.
  setupIpcListeners() {
    let disp = new rx.CompositeDisposable();

    disp.add(ipc.listen('notify:ready').subscribe(() => {
      this.isReady = true;
    }));

    disp.add(ipc.listen('notify:idle').subscribe(() => {
      this.hostWindow.hide();
    }));

    disp.add(ipc.listen('zoomLevel').subscribe((args) => {
      this.zoomLevel = args;
      this.hostWindow.send('zoomLevel', args);

      if (this.hostWindow && this.hostWindow.isVisible()) {
        this.showHostWindow();
      }
    }));

    // The host window keeps track of themes and icons; just forward it on.
    disp.add(ipc.listen('teams:update-theme').subscribe((args) => {
      if (this.hostWindow) {
        this.hostWindow.send('teams:update-theme', args);
      }
    }));

    disp.add(ipc.listen('teams:update-header').subscribe((args) => {
      if (this.hostWindow) {
        this.hostWindow.send('teams:update-header', args);
      }
    }));

    disp.add(ipc.listen('teams:team-changed').subscribe((args) => {
      if (this.hostWindow) {
        this.hostWindow.send('teams:team-changed', args);
      }
    }));

    return disp;
  }

  // Private: Starts listening for notifications from the SSB, and forwards them
  // either to the host window or the main window, depending on our platform.
  //
  // Returns a {Disposable} that will unsubscribe the listener
  handleNotifications() {
    return ipc.listen('notice:notify').subscribe((args) => {
      if (!nativeInterop.shouldDisplayNotifications()) {
        logger.warn('Suppressing notification due to Presentation Mode');
        return;
      }

      if (this.mainWindow.reporter) {
        this.mainWindow.reporter.sendEvent('notification', 'notify');
      }

      if (this.hostWindow && !this.hostWindow.isVisible()) {
        this.showHostWindow();
      }

      let showIt = () => {
        if (!this.isReady) {
          logger.info("Host window not ready, waiting!");
          rx.Scheduler.timeout.scheduleWithRelative(40, showIt);
          return;
        }

        let target = this.hostWindow;
        if (!this.showHtmlNotifications) {
          target = this.mainWindow;
          args = this.addNativeArguments(args);
        }

        target.send('notify:show', args);
      };

      showIt();
    });
  }

  // Private: Sets up a handler for notification
  // clicked messages, coming from the host window.
  //
  // Returns a {Disposable} that will unsubscribe the listener
  handleClickMessages() {
    ipc.listen('notify:click').subscribe((args) => {
      logger.debug(`Notification clicked: ${JSON.stringify(args)}`);

      if (this.mainWindow.reporter) {
        this.mainWindow.reporter.sendEvent('notification', 'click');
      }

      this.mainWindow.bringToForeground();

      if (!args.channel) {
        logger.debug("No channel! Bailing");
        return;
      }

      this.mainWindow.send('notify:click', args);
    });
  }

  // Private: Sets up handlers for notification preferences and updates local
  // values accordingly.
  //
  // Returns a {Disposable} that will unsubscribe the listener
  handlePreferenceChanges() {
    return ipc.listen('notifyPosition').subscribe((args) => {
      this.screenPosition = args;

      if (this.hostWindow) {
        if (this.hostWindow.isVisible()) {
          this.showHostWindow();
        }
        this.hostWindow.send('notifyPosition', args);
      }
    });
  }

  // Private: Poll the interop API as it can change whenever the user changes
  // their theme (on Windows 7). Once we can listen to generic window messages
  // we can swap this out with WM_DWMCOMPOSITIONCHANGED.
  //
  // When this changes we need to update the host window so that it can modify
  // its rendering of individual notifications.
  //
  // Returns a {Disposable} that will unsubscribe the listener.
  handleTransparencySupported() {
    let os = nativeInterop.getOSVersion();

    // Only start this polling on Windows 7.
    if (process.platform !== 'win32') return rx.Disposable.empty;
    if (os.major > 6) return rx.Disposable.empty;
    if (os.major === 6 && os.minor >= 2) return rx.Disposable.empty;

    return rx.Observable.timer(10*1000, 10*1000)
      .map(() => nativeInterop.supportsTransparentWindows())
      .distinctUntilChanged()
      .subscribe((isSupported) => {
        this.dispose();
        this.setupNotificationTarget();
        logger.info(`Notification window supports transparency: ${isSupported}`);
      });
  }

  // Private: Calculates the size and position for the host window and shows it.
  //
  // Returns nothing
  showHostWindow() {
    // NB: Each zoom level represents a 20% size increase
    let scaleFactor = 1 + (this.zoomLevel * 0.2);

    let options = {
      // Determines the size of a single notification
      size: {
        width: Math.round(375 * scaleFactor),
        height: Math.round(88 * scaleFactor) // 72 px + 8 px top and bottom margins
      },
      parent: this.mainWindow,
      screenPosition: this.screenPosition,
      maxCount: this.maxCount,
      screenApi: Screen
    };

    let coords = NotificationHelpers.calculateHostCoordinates(options);

    logger.info(`Positioning host window using: ${JSON.stringify(coords)}`);

    this.hostWindow.setPosition(coords.x, coords.y);
    this.hostWindow.setSize(coords.width, coords.height);
    this.hostWindow.showInactive();
  }

  // Private: Bundle up arguments that our client already knows of, but
  // SlackNotifier doesn't.
  //
  // args - The original arguments from the SSB
  addNativeArguments(args) {
    return _.extend(args, {
      screenPosition: this.screenPosition,
      maxCount: this.maxCount
    });
  }

  // Public: Opens the devTools for this window, for debugging purposes.
  toggleDevTools() {
    this.hostWindow.toggleDevTools();
  }

  // Public: Performs clean-up work for this instance.
  dispose() {
    this.disp.dispose();
  }
}

module.exports = NotificationController;
