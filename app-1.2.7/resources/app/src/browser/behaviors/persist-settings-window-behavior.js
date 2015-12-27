const rx = require('rx');
const atomScreen = require('screen');

const WindowBehavior = require('./window-behavior');
const RepositionWindowBehavior = require('./reposition-window-behavior');

let logger = null;

class PersistSettingsWindowBehavior extends WindowBehavior {

  // Public: Creates a new instance of the behavior
  constructor(localStorage) {
    super();
    this.localStorage = localStorage;
  }

  // Public: Causes the window to persist its position and size,
  // and restores any values from a local file if they exist.
  //
  // hostWindow - The {SlackWindow} to attach the behavior to
  //
  // Returns a {Disposable} which will undo whatever this behavior has set up
  setup(hostWindow) {
    logger = require('../logger').init(__filename);

    let settings = this.loadSettings();

    this.window = hostWindow.window;
    this.window.setPosition(settings.position[0], settings.position[1]);
    this.window.setSize(settings.size[0], settings.size[1]);

    // Maximizing the window immediately has no effect; delay it a bit
    // ¯\_(ツ)_/¯ Atom Shell
    if (settings.isMaximized) {
      rx.Scheduler.timeout.scheduleWithRelative(200, () => this.window.maximize());
    }

    rx.Node.fromEvent(this.window, 'close').subscribe(() => {
      this.saveSettings();
    });
  }

  // Private: Loads serialized window geometry from a local file, or returns
  // canned values if this fails.
  //
  // Returns an object with the following keys:
  //     :size - the window dimensions [W,H]
  //     :position - the window position on-screen (X,Y)
  loadSettings() {
    let settings = null;

    try {
      settings = JSON.parse(this.localStorage.getItem("windowMetrics"));

      if (!settings.size || !settings.size.length ||
        !settings.position || !settings.position.length) {
        throw new Error("Settings were found but invalid");
      }

      if (!RepositionWindowBehavior.windowPositionInBounds(atomScreen, settings)) {
        throw new Error("Settings are off-screen");
      }
    } catch (error) {
      logger.warn(`${error}, resetting ${JSON.stringify(settings)} to default position`);
      settings = RepositionWindowBehavior.calculateDefaultPosition(atomScreen);
      logger.debug(`New position is: ${JSON.stringify(settings)}`);
    }

    return settings;
  }

  // Private: Persists serialized window geometry to a local file.
  //
  // Returns Nothing
  saveSettings() {
    let settings = {
      size: this.window.getSize(),
      position: this.window.getPosition()
    };

    // If maximized, we don't actually want the size {BrowserWindow} gives us.
    // We'll just remember that we're maximized, and keep the restored size
    // as something reasonable (the default position).
    if (this.window.isMaximized()) {
      settings = RepositionWindowBehavior.calculateDefaultPosition(atomScreen, settings);
      settings.isMaximized = true;
    }

    if (settings.size[0] < 25 || settings.size[1] < 25) return;

    let serializedMetrics = JSON.stringify(settings);

    logger.info(`Saving windowMetrics: ${serializedMetrics}`);
    this.localStorage.setItem('windowMetrics', serializedMetrics);
  }
}

module.exports = PersistSettingsWindowBehavior;
