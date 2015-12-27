const renderer = require('./ipc-rx');
const url = require('url');
const _ = require('lodash');
const rx = require('rx');

const {EventEmitter} = require('events');
const BrowserWindow = require('browser-window');

let logger = null;

// Public: SlackWindow is a class that manages / wraps an atom-shell Window
// object. It's managed by {SlackApplication}.
class SlackWindow extends EventEmitter {
  // Public: Constructs a new window.
  //
  // options: The object representing the sanitized command line parameters. In
  // particular:
  //   :resourcePath - The base path of our application
  //   :isSpec - If true, creates a test runner window
  //   :devMode - If not true, enables crash reporting
  //   :behaviors - A collection of {WindowBehavior} instances to apply
  //   :reporter - An instance of {MetricsReporter} used for reporting metrics;
  //               this should be null for secondary windows
  constructor(options) {
    super();
    this.resourcePath = options.resourcePath;
    this.isSpec = options.isSpec;
    this.devMode = options.devMode;
    this.behaviors = options.behaviors || [];
    this.reporter = options.reporter;
    this.loadSettings = _.extend({}, _.omit(options, 'behaviors', 'reporter'));

    this.positionObs = new rx.Subject();
    this.sizeObs = new rx.Subject();

    logger = require('./logger').init(__filename);
    logger.info(`SlackWindow created, bootstrapping: ${this.loadSettings.bootstrapScript}`);

    let windowOpts = {
      show: false,
      'auto-hide-menu-bar': options.autoHideMenuBar,
      title: this.isSpec ? 'Tests!' : 'Slack',
      'web-preferences': {
        'subpixel-font-scaling': true,
        'direct-write': options.useHwAcceleration !== false,
        'plugins': true
      }
    };

    windowOpts = _.extend(windowOpts, options);

    this.window = new BrowserWindow(windowOpts);
    this.disp = new rx.CompositeDisposable();

    // Wire up all of our behaviors to the window instance
    _.each(this.behaviors, (behavior) => {
      this.disp.add(behavior.setup(this));
    });

    this.handleWindowEvents();

    if (!(this.devMode || this.isSpec)) {
      this.handleRendererCrashes();
      this.reportWindowMetrics();
    }
  }

  // Public: Sets up the window to load a page, and optionally shows the window
  //
  // show - (Optional) Whether or not the window should be shown
  // pathname - (Optional) The path to the page to be loaded
  loadIndex(show=true, pathname=null) {
    pathname = pathname || `${this.resourcePath}/static/index.html`;
    let targetUrl = url.format({
      protocol: 'file',
      pathname: pathname,
      slashes: true,
      query: {loadSettings: JSON.stringify(this.loadSettings)}
    });

    this.window.loadUrl(targetUrl);
    if (show) this.show();
  }

  // Private: Sets up listeners to handle events from the underlying
  // {BrowserWindow} or forward them to the renderer
  handleWindowEvents() {
    this.disp.add(rx.Node.fromEvent(this.window, 'close').subscribe((e) => {
      this.emit('close', e);
    }));

    this.disp.add(rx.Node.fromEvent(this.window, 'closed').subscribe((e) => {
      this.emit('closed', e);
      if (this.disp) this.disp.dispose();
    }));

    this.disp.add(rx.Node.fromEvent(this.window, 'devtools-opened').subscribe(() => {
      this.send('window:toggle-dev-tools', true);
    }));

    this.disp.add(rx.Node.fromEvent(this.window, 'devtools-closed').subscribe(() => {
      this.send('window:toggle-dev-tools', false);
    }));

    this.disp.add(rx.Node.fromEvent(this.window, 'blur').subscribe(() => {
      this.send('windowBlur');
    }));

    this.disp.add(rx.Node.fromEvent(this.window, 'focus').subscribe(() => {
      this.send('windowFocus');
    }));

    this.disp.add(rx.Node.fromEvent(this.window.webContents, 'did-finish-load').subscribe((e) => {
      this.emit('did-finish-load', e);
    }));

    // NB: rx.Node.fromEvent doesn't capture all of the parameters
    this.window.webContents.on('will-navigate', (e, targetUrl) => {
      logger.info(`Preventing navigation to: ${targetUrl}`);
      e.preventDefault();
    });

    this.window.on('app-command', (e, cmd) => {
      if (cmd === 'browser-backward' && this.window.webContents.canGoBack()) {
        this.window.webContents.goBack();
      }
      if (cmd === 'browser-forward' && this.window.webContents.canGoForward()) {
        this.window.webContents.goForward();
      }
    });
  }

  // Private: Handle crashes from the renderer process
  handleRendererCrashes() {
    // The former event is when the renderer process itself dies a native death
    // and the latter is when we reach the unhandled JS exception catch in index.js
    let crashed = rx.Observable.merge(
      rx.Node.fromEvent(this.window.webContents, 'crashed'),
      renderer.listen('crashed'));

    this.disp.add(crashed.subscribe(() => {
      this.crashCount = this.crashCount || 0;
      this.crashCount++;

      // NB: Metrics in the browser are remoted to the main window and here, we
      // *know* it's currently hosed. Wait till it reloads, then send the metric
      rx.Scheduler.timeout.scheduleWithRelative(2000, () => {
        if (this.reporter) this.reporter.sendEvent('crash', 'renderer', null, this.crashCount);
      });

      logger.warn('Renderer process died, attempting to restart');
      this.reload();
    }));
  }

  // Private: Send window size and position to our metrics reporter
  reportWindowMetrics() {
    if (this.reporter) {
      this.positionObs.throttle(750).subscribe((position) => {
        this.reporter.sendEvent('window', 'x', null, position[0]);
        this.reporter.sendEvent('window', 'y', null, position[1]);
      });

      this.sizeObs.throttle(750).subscribe((size) => {
        this.reporter.sendEvent('window', 'width', null, size[0]);
        this.reporter.sendEvent('window', 'height', null, size[1]);
      });
    }
  }

  // Public: Shows the window
  show() {
    this.window.show();
  }

  // Public: Shows the window, without giving it focus
  showInactive() {
    this.window.showInactive();
  }

  // Public: Show or restore the window, if necessary, then focus it
  bringToForeground() {
    if (!this.window.isVisible())
      this.window.show();

    if (this.window.isMinimized())
      this.window.restore();

    this.window.focus();
  }

  // Public: Hides the window
  hide() {
    this.window.hide();
  }

  // Public: Minimizes the window
  minimize() {
    this.window.minimize();
  }

  // Public: Begins flashing the window
  //
  // Returns a {Disposable} that will stop flashing
  flash() {
    logger.info("Calling flashFrame(true)");
    this.window.flashFrame(true);

    return rx.Disposable.create(() => {
      logger.info("Calling flashFrame(false)");
      this.window.flashFrame(false);
    });
  }

  // Public: Returns an array that contains the window's current position
  getPosition() {
    return this.window.getPosition();
  }

  // Public: Returns an array that contains the window's width and height
  getSize() {
    return this.window.getSize();
  }

  // Public: Sets the position of the window
  setPosition(x, y) {
    this.positionObs.onNext([x, y]);
    this.window.setPosition(x, y);
  }

  // Public: Sets the size of the window
  setSize(width, height) {
    this.sizeObs.onNext([width, height]);
    this.window.setSize(width, height);
  }

  // Public: Reloads the window, Cmd-R style
  reload() {
    // Inform listeners that we are reloading so they can do some clean-up
    this.send('window:dispose');
    this.window.webContents.reload();
  }

  // Public: Toggles full-screen mode for the window
  toggleFullScreen() {
    this.window.setFullScreen(!this.window.isFullScreen());
  }

  // Public: Toggles Web Inspector to appear for the window
  toggleDevTools() {
    this.window.toggleDevTools();
  }

  // Public: Returns whether or not the window is visible
  isVisible() {
    return this.window.isVisible();
  }

  // Public: Returns whether or not the window is minimized
  isMinimized() {
    return this.window.isMinimized();
  }

  // Public: Sets the Window title
  setTitle(title) {
    this.window.setTitle(title);
  }

  // Public: Sets the top-level menu for this window
  setMenu(menu) {
    this.window.setMenu(menu);
  }

  // Public: Closes the window and destroys the associated data
  close() {
    this.disp.dispose();
    this.window.close();
    this.window = null;
  }

  // Public: Sends an IPC event to the Renderer process.
  //
  // event - The channel to send the event args on
  // args - the arguments to send along with the IPC message
  send(event, ...args) {
    if (this.window.webContents) {
      this.window.webContents.send(event, ...args);
    }
  }
}

module.exports = SlackWindow;
