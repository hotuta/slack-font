const remote = require('remote');
const BrowserWindow = remote.require('browser-window');
const RepositionWindowBehavior = require('../browser/behaviors/reposition-window-behavior');
const ipc = require('../renderer/ipc-rx');
const rx = require('rx-dom');
const uuid = require('node-uuid');
const getUserAgent = require('../ssb-user-agent');

// Public: Implements the SSB Window API that allows the web app to open popup
// windows and push them around
class WindowApi {
  constructor(browserWindowId, guestInstanceId) {
    this.browserWindowId = browserWindowId;
    this.guestInstanceId = guestInstanceId;

    this.windowList = {};
    this.windowMetadata = {};
    this.nextWindowToken = 1;
  }
  
  // Public: Opens a new popup window.
  //
  // options - an {Object} with the following keys:
  //
  //    :title - the window title
  //    :url - the URL to navigate to
  //    :x - the x coordinate of the window
  //    :y - the y coordinate of the window
  //    :width - the width of the window, default 500
  //    :height - the height of the window, default 500
  //    :hideMenuBar - whether to hide the menubar in the window, Windows only
  //
  // Returns a unique value that you can proceed to pass to other methods
  // in this class.
  open(options={}) {
    let token = this.nextWindowToken++;

    let newWindow = new BrowserWindow({
      show: options.show === undefined ? true : options.show,
      center: true,
      title: options.title || "",
      x: options.x || "",
      y: options.y || "",
      width: options.width || 500,
      height: options.height || 500,
      resizable: options.resizable,
      frame: options.frame,
      transparent: options.transparent,
      'use-content-size': options.useContentSize,
      'always-on-top': options.alwaysOnTop,
      'min-width': options.minWidth || 200,
      'min-height': options.minHeight || 80,
      'node-integration': false,
      'preload': require.resolve('../../static/ssb-interop'),
      // Keep the menu-bar from appearing then disappearing when `setMenuBarVisibility` is called
      'auto-hide-menu-bar': options.hideMenuBar || false
    });

    // NB: When display settings change, re-center this window
    let behavior = new RepositionWindowBehavior({
      recalculateWindowPositionFunc: () => this.center({window_token: token})
    });

    behavior.setup({window: newWindow});

    if (options.hideMenuBar) {
      newWindow.setMenuBarVisibility(!options.hideMenuBar);
      newWindow.setAutoHideMenuBar(false);
    }

    newWindow.webContents.setUserAgent(getUserAgent());

    this.windowList[token] = newWindow;
    this.windowMetadata[token] = options;

    let disp = new rx.CompositeDisposable();

    disp.add(rx.DOM.fromEvent(window, 'unload').subscribe(() => {
      this.executeJavaScriptInWindow({window_token: token, code: "window.dispatchEvent(new Event('parentunload', {bubbles: false}))"})
        .subscribe(() => this.close({window_token: token}));
    }));

    disp.add(rx.DOM.fromEvent(window, 'resize').throttle(250).subscribe(() => {
      this.executeJavaScriptInWindow({window_token: token, code: "window.dispatchEvent(new Event('parentresize', {bubbles: false}))"});
    }));

    // NB: We don't fill this out immediately because we want to wait until
    // the window is loaded before we try to call newWindow.id
    let windowId = null;

    newWindow.on('crashed', () => {
      newWindow.destroy();
      global.TSSSB.windowWithTokenCrashed(token);
    });
    
    newWindow.on('focus', () => global.TSSSB.windowWithTokenBecameKey(token));
    newWindow.on('blur', () => global.TSSSB.windowWithTokenResignedKey(token));
    newWindow.on('closed', () => {
      // NB: Some integrations (read: Box) hold a reference to the window and
      // check for a `closed` flag before opening further windows. Make it so.
      newWindow.closed = true;

      ipc.send('child-window-removed', windowId);

      disp.dispose();
      window.TSSSB.windowWithTokenWillClose(token);
      this.removeWindow(token);
    });

    newWindow.webContents.on('did-start-loading', () => {
      let code = null;
      if (this.guestInstanceId) {
        code = `window.parentBrowserWindowId = ${this.browserWindowId}; window.parentGuestInstanceId = ${this.guestInstanceId}`;
      } else {
        code = `window.parentBrowserWindowId = ${this.browserWindowId}`;
      }

      this.executeJavaScriptInWindow({window_token: token, code: code});

      // NB: must be on a timeout so it is called after we return the token, else
      // webapp will not yet have a record of the window/token!
      if (window.TSSSB) setTimeout((() => window.TSSSB.windowWithTokenBeganLoading(token)), 0);
    });

    newWindow.webContents.on('did-finish-load', () => {
      let code = null;
      if (this.guestInstanceId) {
        code = `window.parentBrowserWindowId = ${this.browserWindowId}; window.parentGuestInstanceId = ${this.guestInstanceId}`;
      } else {
        code = `window.parentBrowserWindowId = ${this.browserWindowId}`;
      }

      this.executeJavaScriptInWindow({window_token: token, code: code});
      
      // NB: must be on a timeout so it is called after we return the token, else
      // webapp will not yet have a record of the window/token!
      if (global.TSSSB) setTimeout((() => global.TSSSB.windowWithTokenBeganLoading(token)), 0);

      window.TSSSB.windowWithTokenFinishedLoading(token);

      windowId = newWindow.id;
      ipc.send('child-window-created', windowId);
    });

    let resizedOrMoved = rx.Observable.merge(
      rx.Node.fromEvent(newWindow, 'resize'),
      rx.Node.fromEvent(newWindow, 'move')
    );

    resizedOrMoved.throttle(250).subscribe(() => {
      let [x,y] = newWindow.getPosition();
      let [width, height] = newWindow.getSize();

      window.TSSSB.windowWithTokenDidChangeGeometry(token, { x, y, width, height });
    });

    if (options.url) {
      newWindow.loadUrl(options.url);
    }

    return token;
  }

  // Public: Hides a popup window created with {open}
  //
  // options - an {Object} with the following keys:
  //
  //    :window_token - the value you got in {open}.
  //
  // Returns nothing
  hide(options) {
    this.windowList[options.window_token].hide();
  }

  // Public: Shows a popup window created with {open} and hidden with {hide}
  //
  // options - an {Object} with the following keys:
  //
  //    :window_token - the value you got in {open}.
  //
  // Returns nothing
  show(options) {
    this.windowList[options.window_token].show();
  }

  // Public: Shows a popup window but does not focus on it
  //
  // options - an {Object} with the following keys:
  //
  //    :window_token - the value you got in {open}.
  //
  // Returns nothing
  showInactive(options) {
    this.windowList[options.window_token].showInactive();
  }

  // Public: Closes a popup window created with {open}
  //
  // options - an {Object} with the following keys:
  //
  //    :window_token - the value you got in {open}.
  //
  // Returns nothing
  close(options) {
    if (this.windowMetadata[options.window_token].hides_on_close) { 
      //Mostly for calls windows. This assumes that the window.onbeforeunload is being overriden but would trigger a 
      //true close if should_close = true. 
      this.executeJavaScriptInWindow({window_token: options.window_token, code: "window.should_close = true;"})
        .subscribe(() => this.doClose(options));
    } 
    else { 
      //Normal window close operation
      this.doClose(options);
    }
  }

  doClose(options) {
    this.windowList[options.window_token].close();
    this.removeWindow(options.window_token);
  }

  // Public: Moves a popup window created with {open}
  //
  // options - an {Object} with the following keys:
  //
  //    :window_token - the value you got in {open}.
  //    :x - the new horizontal position of the top-left corner of the window
  //    :y - the new vertical position of the top-left corner of the window
  //
  // Returns nothing
  move(options) {
    let wnd = this.windowList[options.window_token];
    wnd.setPosition(parseInt(options.x), parseInt(options.y));
  }

  // Public: Resizes a popup window created with {open}
  //
  // options - an {Object} with the following keys:
  //
  //    :window_token - the value you got in {open}.
  //    :width - the new horizontal size of the window
  //    :height - the new vertical size of the window
  //
  // Returns nothing
  resize(options) {
    let wnd = this.windowList[options.window_token];
    wnd.setSize(parseInt(options.width), parseInt(options.height));
  }

  // Public: Brings a popup window to the foreground
  //
  // options - an {Object} with the following keys:
  //
  //    :window_token - the value you got in {open}.
  //
  // Returns nothing
  focus(options) {
    let wnd = this.windowList[options.window_token];
    wnd.focus();
  }

  // Public: Returns a list of all windows previously created with {open}
  //
  // Returns A stringified JSON dictionary whose keys are window tokens, and
  // whose values are the original metadata values passed to {open}
  list() {
    return JSON.stringify(this.windowMetadata);
  }

  // Public: Moves a popup window to the center of the screen
  //
  // options - an {Object} with the following keys:
  //
  //    :window_token - the value you got in {open}.
  //
  // Returns nothing
  center(options) {
    let wnd = this.windowList[options.window_token];
    wnd.center();
  }

  // Public: Toggles developer tools on a popup window
  //
  // options - an {Object} with the following keys:
  //
  //    :window_token - the value you got in {open}.
  //
  // Returns nothing
  toggleDevTools(options) {
    let wnd = this.windowList[options.window_token];
    wnd.toggleDevTools();
  }

  // Public: Returns an {Object} describing the primary display
  //
  // Returns an {Object} with the following keys:
  //
  //    :bounds - describes the size and position of the display
  //    :workArea - describes the available size (e.g., minus the taskbar)
  //    :scaleFactor - describes the scaling of the display
  getPrimaryDisplay() {
    let atomScreen = require('screen');
    return atomScreen.getPrimaryDisplay();
  }

  // Public: Returns an array of displays that are currently active
  //
  // Returns an array of display objects
  getAllDisplays() {
    let atomScreen = require('screen');
    return atomScreen.getAllDisplays();
  }

  // Public: Returns the display where the app window is located
  //
  // Returns a display {Object}
  getAppDisplay() {
    let position = [window.screenX, window.screenY];
    let size = [window.outerWidth, window.outerHeight];
    return this.getDisplayForCoordinates(position, size);
  }

  // Public: Returns the display where the given popup window is located
  //
  // options - an {Object} with the following keys:
  //
  //    :window_token - the value you got in {open}.
  //
  // Returns a display {Object}
  getDisplayForWindow(options) {
    let wnd = this.windowList[options.window_token];
    return this.getDisplayForCoordinates(wnd.getPosition(), wnd.getSize());
  }

  // Public: Returns the window metrics for a given window
  //
  // options - an {Object} with the following keys:
  //
  //    :window_token - the value you got in {open}.
  //
  // Returns a {Object} with the following keys:
  //
  //    :x, :y - the coordinates for the top-left corner of the window
  //    :width, :height - the size of the window
  getGeometryForWindow(options) {
    if (!options) {
      throw new Error("Missing options");
    }

    if (!options.window_token) {
      throw new Error("Missing parameters, needs window_token");
    }

    let wnd = this.windowList[options.window_token];

    if (!wnd) {
      throw new Error("Invalid window token");
    }

    let pos = wnd.getPosition();
    let size = wnd.getSize();

    return {
      x: pos[0], y: pos[1],
      width: size[0], height: size[1]
    };
  }

  // Public: Dispatches an event from the parent window to the popup's context,
  // using the `executeJavaScript` method
  //
  // data - The data that will attached to the {Event}
  // window_token - The WindowToken to send the {Event} to
  //
  // Returns nothing
  postMessage(data, window_token) {
    if (!window_token || !data) {
      throw new Error("Missing parameters, needs window_token and data");
    }

    let opts = {
      code: `var evt = new Event('message'); evt.data = ${JSON.stringify(data)}; window.dispatchEvent(evt);`,
      window_token: window_token
    };

    console.log(`Signaling child from postMessage: ${opts.code}, ${window_token}`);
    this.executeJavaScriptInWindow(opts);
  }

  // Public: Executes JavaScript code in the context of the opened popup
  // window.
  //
  // options - an {Object} with the following keys:
  //
  //    :window_token - the value you got in {open}.
  //    :code - the code to execute.
  //    :callback - a callback method that will be called with two parameters:
  //
  //        err - an {Error} object if the call fails
  //        data - the return value of the code you executed. The return value
  //               must be JSON-serializable
  executeJavaScriptInWindow(options) {
    // Here's how this works, via 103403434x ipc messages:
    //
    // 1. Similar to what web-view-ctx.js does, we call into main.js's
    //    "rendererEvalAsync". However, since we can't rely on sendToHost, we
    //    instead get our window and WebView IDs and pass them along
    //
    // 2. rendererEvalAsync evals our code and sends the result to the browser
    //    process
    //
    // 3. The browser process looks up the window for the given ID and forwards
    //    the message blindly.
    //
    // 4. If this has been a window-to-window message, we'll end up hitting the
    //    message listener here and we're done, call the callback
    //
    // 5. If this has been a WebView-to-Window message, the target window ID will
    //    be the main app's Window, and TeamsViewController will look up the WebView
    //    associated with the WebView ID and forward the message (again).
    //
    // 6. We end up getting the message from the WebView in this method, then
    //    we're basically back at #4

    let webContents = null;

    // browserWindowId is a secret handshake that allows us to implement
    // window.opener.executeJavaScript, it's not intended to be called from
    // the webapp
    if (!options.browserWindowId) {
      if (!options.window_token || !options.code) {
        throw new Error("Missing parameters, needs window_token and code");
      }

      if (!this.windowList[options.window_token]) {
        throw new Error("Invalid window token");
      }

      webContents = this.windowList[options.window_token].webContents;
    } else {
      if (options.guestInstanceId) {
        webContents = remote.getGuestWebContents(options.guestInstanceId);
      } else {
        webContents = BrowserWindow.fromId(options.browserWindowId).webContents;
      }
    }

    let ourBrowserWindowId = this.browserWindowId;
    let ourGuestInstanceId = this.guestInstanceId;

    let msg = { code: options.code, id: uuid.v4(), browserWindowId: this.browserWindowId };

    let ret = ipc.listen('eval-async')
      .map((x) => x[0])
      .where((x) => x.browserWindowId === ourBrowserWindowId)
      .where((x) => x.guestInstanceId ? ourGuestInstanceId === x.guestInstanceId : true)
      .where((x) => x.id === msg.id)
      .take(1)
      .flatMap((x) => {
        if (x.error) return rx.Observable.throw(new Error(`${x.message}\n${x.error}`));
                
        if (x.result === null) {
          return rx.Observable.return(null);
        }

        try {
          return rx.Observable.return(JSON.parse(x.result));
        } catch (e) {
          return rx.Observable.throw(e);
        }
      })
      .publishLast();

    if (options.callback) {
      ret.subscribe(
        (x) => options.callback(null, x),
        (e) => options.callback(e));
    }

    if (this.guestInstanceId) msg.guestInstanceId = this.guestInstanceId;

    ret.connect();
    webContents.executeJavaScript(`window.rendererEvalAsync(\"${btoa(encodeURIComponent(JSON.stringify(msg)))}\")`);
    return ret;
  }

  // Private: Stops tracking the window with the given token
  //
  // token - the value you got in {open}.
  removeWindow(token) {
    delete this.windowList[token];
    delete this.windowMetadata[token];
  }

  // Private: Returns the display nearest to the given coordinates
  //
  // position - an array with values specifying x and y
  // size - an array with values specifying width and height
  //
  // Returns a display {Object}
  getDisplayForCoordinates(position, size) {
    let atomScreen = require('screen');

    let centerPoint = {
      x: Math.round(position[0] + size[0] / 2.0),
      y: Math.round(position[1] + size[1] / 2.0)
    };

    return atomScreen.getDisplayNearestPoint(centerPoint);
  }
}

module.exports = WindowApi;
