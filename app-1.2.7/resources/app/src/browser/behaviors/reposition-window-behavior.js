const rx = require('rx');
const _ = require('lodash');
const WindowBehavior = require('./window-behavior');

let logger = null;

class RepositionWindowBehavior extends WindowBehavior {

  // Public: Creates a new instance of the behavior.
  //
  // options - A hash of overridable options:
  //
  //           recalcWindowPos - A {Function} which returns a X/Y pair as an
  //                             {Array}, called when screen geometry is
  //                             incompatible with thecurrent window position
  //
  //           shouldRecheckWindowPos - An {Observable} that represents when
  //                                    the window position should be checked
  //
  //           screenApi - Used to override Atom Screen for unit-testing
  constructor(options={}) {
    super();
    logger = require('../logger').init(__filename);

    this.recalculateWindowPositionFunc = options.recalculateWindowPositionFunc ||
      RepositionWindowBehavior.recalculateWindowPositionFunc;
    this.shouldRecheckWindowPos = options.shouldRecheckWindowPos;
    this.screenApi = options.screenApi;
  }

  // Public: Causes the window to reposition once screen geometry changes. When
  //         the window's position / size are garbage, we'll ask the window to
  //         pick a new size and position.
  //
  // hostWindow - The {SlackWindow} to attach the behavior to
  //
  // Returns a {Disposable} which will undo whatever this behavior has set up
  setup(hostWindow) {
    if (!this.shouldRecheckWindowPos) {
      // Require these as late as possible, so that the unit tests (that can't
      // use browser modules) still function.
      let atomScreen = require('screen');

      // `power-monitor` can only be used from the browser process.
      let resumeFromSleepEvent = process.type === 'browser' ?
        rx.Node.fromEvent(require('power-monitor'), 'resume') :
        rx.Observable.empty();

      this.shouldRecheckWindowPos =
        rx.Observable.merge(
          rx.Node.fromEvent(atomScreen, 'display-removed'),
          rx.Node.fromEvent(atomScreen, 'display-metrics-changed'),
          resumeFromSleepEvent)
        .where(() => hostWindow.window.isVisible())
        .throttle(1000);

      this.screenApi = atomScreen;
    }

    return this.shouldRecheckWindowPos
      .do(() => logger.info('About to recheck window bounds against screen'))
      .where(() => !RepositionWindowBehavior.windowInBounds(this.screenApi, hostWindow))
      .do(() => logger.info('Window geometry is invalid, calling out to host to fix it'))
      .subscribe(() => this.recalculateWindowPositionFunc(this.screenApi, hostWindow));
  }

  // Public: Determines whether a window is fully positioned on a monitor.
  //
  // screenApi - used to determine display coordinates
  // hostWindow - the window to check against the current set of monitors
  //
  // Returns True if the window is fully contained on a single monitor, or False
  // if the monitor is partially off-screen
  static windowInBounds(screenApi, hostWindow) {
    return RepositionWindowBehavior.windowPositionInBounds(screenApi, {
      position: hostWindow.window.getPosition(),
      size: hostWindow.window.getSize()
    });
  }

  // Public: Determines whether a proposed window geometry is fully positioned on
  // a monitor.
  //
  // screenApi - used to determine display coordinates
  //
  // settings - an {Object} with the following keys:
  //   :position - an X/Y coordinate pair
  //   :size - a Width/Height coordinate pair
  //   :isMaximized - (optional) true if the window is maximized
  //
  // Returns True if the window is fully contained on a single monitor, or False
  // if the monitor is partially off-screen
  static windowPositionInBounds(screenApi, settings) {
    let p = settings.position;
    let s = settings.size;

    let windowRect = [p[0], p[1], p[0]+s[0], p[1]+s[1]];

    // NB: Check for bizarro sizes and fail them
    if (s[0] < 10 || s[1] < 10) return false;

    // NB: Maximized windows will fail the bounds check due to a negative
    // position but are still valid, so we let them through here
    if (settings.isMaximized) return true;

    return _.any(screenApi.getAllDisplays(), (display) => {
      let displayRect = [
        display.bounds.x,
        display.bounds.y,
        display.bounds.x + display.bounds.width,
        display.bounds.y + display.bounds.height
      ];

      let result = RepositionWindowBehavior.rectIsFullyContainedIn(windowRect, displayRect);
      logger.info(`Window ${JSON.stringify(windowRect)} fits in display ${JSON.stringify(displayRect)}? ${result}`);
      return result;
    });
  }

  // Public: The default function used to calculate a valid window position /
  // size when screen geometry changes.
  //
  // screenApi - used to determine display coordinates
  //
  // hostWindow - The {SlackWindow} that will be repositioned
  static recalculateWindowPositionFunc(screenApi, hostWindow) {
    let newPos = RepositionWindowBehavior.calculateDefaultPosition(screenApi);

    hostWindow.setPosition(newPos.position[0], newPos.position[1]);
    hostWindow.setSize(newPos.size[0], newPos.size[1]);
  }

  // Public: Calculates a reasonable window position / size based on the
  // geometry of the primary window.
  //
  // screenApi - used to determine display coordinates
  //
  // settings - (Optional) contains the current size and position of the window
  //
  // percentSize - (Optional) determines the percentage of the display the
  //               window should be resized to fill
  //
  // Returns an {Object} with the following keys:
  //   :position - an X/Y coordinate pair
  //   :size - a Width/Height coordinate pair
  static calculateDefaultPosition(screenApi, settings, percentSize={x: 0.6, y: 0.8}) {
    let activeDisplay = screenApi.getPrimaryDisplay();

    // If we were given existing window metrics, try to return a position
    // within the same display.
    if (settings) {
      let centerPoint = {
        x: Math.round(settings.position[0] + settings.size[0] / 2.0),
        y: Math.round(settings.position[1] + settings.size[1] / 2.0)
      };
      activeDisplay = screenApi.getDisplayNearestPoint(centerPoint);
    }

    let bounds = activeDisplay.workArea;

    let windowWidth = Math.round(bounds.width * percentSize.x);
    let windowHeight = Math.round(bounds.height * percentSize.y);

    let centerX = bounds.x + bounds.width / 2.0;
    let centerY = bounds.y + bounds.height / 2.0;

    let pos = [Math.round(centerX - (windowWidth / 2.0)), Math.round(centerY - (windowHeight / 2.0))];

    return { position: pos, size: [windowWidth, windowHeight] };
  }

  // Private: Checks two rectangles to determine whether one is fully inside
  // another. Rectangles are a 4-element array consisting of
  // [Left, Top, Right, Bottom].
  //
  // targetRect - the Rect which should be contained in hostRect
  // hostRect - the Rect which should completely contain targetRect
  static rectIsFullyContainedIn(targetRect, hostRect) {
    // Rounding the window size can throw the result off by a pixel,
    // particularly when the window is snapped or maximized.
    let fudgeFactor = 1;

    if (targetRect[0] < hostRect[0] - fudgeFactor) return false;
    if (targetRect[1] < hostRect[1] - fudgeFactor) return false;

    if (targetRect[2] > hostRect[2] + fudgeFactor) return false;
    if (targetRect[3] > hostRect[3] + fudgeFactor) return false;

    return true;
  }
}

module.exports = RepositionWindowBehavior;
