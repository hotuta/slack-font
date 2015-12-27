const app = require('app');
const rx = require('rx');

const WindowBehavior = require('./window-behavior');

let logger = null;

class RunFromTrayWindowBehavior extends WindowBehavior {

  // Public: Creates a new instance of the behavior
  //
  // localStorage - Used to persist settings
  constructor(localStorage) {
    super();
    this.localStorage = localStorage;
    this.trayHandler = null;

    let isEnabled = localStorage.getItem('runFromTray');
    if (isEnabled === null || isEnabled === undefined) {
      this.isEnabled = true;
    } else {
      this.isEnabled = isEnabled;
    }
  }

  // Public: Causes the window to hide when closed, remaining active in the
  // dock or tray. Clicking the dock or tray icon restores the window.
  //
  // hostWindow - The {SlackWindow} to attach the behavior to
  //
  // Returns a {Disposable} which will undo whatever this behavior has set up
  setup(hostWindow) {
    logger = require('../logger').init(__filename);

    let disp = new rx.CompositeDisposable();

    disp.add(rx.Node.fromEvent(hostWindow.window, 'close').subscribe((e) => {
      this.onWindowClose(hostWindow, e);
    }));

    disp.add(rx.Node.fromEvent(app, 'before-quit').subscribe(() => {
      hostWindow.exitApp = true;
    }));

    disp.add(rx.Node.fromEvent(app, 'activate-with-no-open-windows').subscribe(() => {
      hostWindow.bringToForeground();
    }));

    return disp;
  }

  // Private: Handles the window `close` event and either prevents it (hiding
  // the window instead) or lets it through.
  //
  // hostWindow - The {BrowserWindow} that was closed
  // e - The `close` event
  //
  // Returns nothing
  onWindowClose(hostWindow, e) {
    // NB: User chose to quit from the app or tray menu, OR run from tray is
    // disabled via preferences
    let allowClose = hostWindow.exitApp || !this.isEnabled;

    if (allowClose) {
      let reason = hostWindow.exitApp ?
        "user chose to quit" :
        "run from tray is disabled";
      logger.info(`Allowing window close because ${reason}`);
      return;
    }

    logger.info("Attempted to close the window, hiding instead.");
    e.preventDefault();
    hostWindow.hide();

    this.showTrayBalloon();
  }

  // Private: The first time the user closes the main window, we want to show a
  // balloon from the tray hinting that we're still there. This only happens
  // once, and then we make note of it in `localStorage`.
  showTrayBalloon() {
    if (this.localStorage.getItem('hasRunFromTray')) return;
    this.localStorage.setItem('hasRunFromTray', 'MuchTrue');

    let args = {
      title: "Looking for Slack?",
      content: "Slack is still running, and you can restore the window by clicking this icon. If you'd like to quit, right-click this icon and choose 'Quit.'"
    };

    if (this.trayHandler) {
      this.trayHandler.showBalloon(args);
    }
  }

  // Public: Enables this behavior
  enable() {
    this.isEnabled = true;
    this.localStorage.setItem('runFromTray', true);
  }

  // Public: Disables this behavior, while leaving it attached to the window
  disable() {
    this.isEnabled = false;
    this.localStorage.setItem('runFromTray', false);
  }
}

module.exports = RunFromTrayWindowBehavior;
