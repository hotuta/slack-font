const path = require('path');
const _ = require('lodash');
const browser = require('./ipc-rx');
const url = require('url');
const shell = require('remote').require('shell');
const uuid = require('node-uuid');
const rx = require('rx-dom');
const getUserAgent = require('../ssb-user-agent');

const ContextMenuBuilder = require('./context-menu-builder');
const DownloadManager = require('./download-manager');

let logger = require('../browser/logger').init(__filename);

let ssb_url = 'https://www.slack.com/ssb';
let webViewId = 0;

if (global.loadSettings.devEnv) {
  ssb_url = `https://${global.loadSettings.devEnv}.slack.com/ssb`;
}

// Public: Manages a single WebView tag and all of the associated things we want
// to do with it. This also manages the interaction with the SSB Interop context
// (i.e. the code that we've injected into the SSB itself)
class SlackWebViewContext {
  // Public: Create a new SlackWebViewContext
  //
  // options - (Optional) A hash used to inject things in a unit test runner, the
  //           most useful ones being:
  //
  //     :fakeCrash - An Observable which will simulate that the WebView has
  //                  crashed
  //     :docRoot - the DOM element to attach the WebView to
  //     :targetUrl - the URL to load. Defaults to the SSB URL
  //     :ssbOptions - option hash passed down to the SSB on initialization
  constructor(options={}) {
    this.sched = options.sched || rx.Scheduler.timeout;
    this.fakeCrash = options.fakeCrash || rx.Observable.empty();
    this.docRoot = options.docRoot || document.body;
    this.targetUrl = options.targetUrl || ssb_url;
    this.ssbOptions = options.ssbOptions || {};
    this.disableSlackClientFeatures = options.disableSlackClientFeatures;
    this.reporter = options.reporter;

    // Distinguish between waitForLoaded not present vs. waitForLoaded
    // *is* present but false
    this.waitForLoaded = true;
    if (options.waitForLoaded === false) this.waitForLoaded = false;

    this.webViewFactory = options.webViewFactory || (() => {
      logger.info("Creating actual WebView element");
      return document.createElement('webview');
    });

    this.webViewId = `webView${webViewId++}`;
    logger.info(`Creating new webView with ID: ${this.webViewId}`);

    this.wv = this.webViewFactory();
    this.wv.setAttribute('id', this.webViewId);

    this.webViewIpc = options.webViewIpc ||
      rx.DOM.fromEvent(this.wv, 'ipc-message');
      
    this.tsReadySubj = new rx.AsyncSubject();
    this.webViewIpc.where((x) => x.channel === 'didFinishLoading')
      .take(1)
      .multicast(this.tsReadySubj)
      .connect();

    this.currentAttach = new rx.SerialDisposable();

    let preloadUrl = url.format({
      protocol: 'file',
      pathname: path.resolve(__dirname, '..', '..', 'static', 'ssb-interop'),
      slashes: true
    });

    if (!options.disablePreload) {
      this.wv.setAttribute('preload', preloadUrl);
      this.wv.setAttribute('plugins', '');
    }

    this.crashed = this.setUpErrorHandling(options.fakeCrash);
    this.requestedClose = rx.Observable.merge(
      rx.DOM.fromEvent(this.wv, 'close'),
      rx.DOM.fromEvent(this.wv, 'closed')    // Work around bug in Electron 0.29.2
    );
    this.hide();
  }

  // Public: Overrides the URL of this WebView. Useful for debugging
  overrideSsbUrl(targetUrl) {
    this.targetUrl = targetUrl;
    this.reload();
  }

  // Public: Issues a reload to the WebView element
  //
  // Returns an Observable Promise that indicates that the SSB has finished
  // loading, or errors indicating that it failed to load
  reload() {
    let ret = rx.Observable.timer(10, this.sched)
      .do(() => {
        this.wv.setAttribute('src', 'about:blank');
        this.wv.setAttribute('src', this.targetUrl);
        this.wv.reload();
      })
      .flatMap(() => this.getSingleFinishedLoadObservable())
      .publishLast();

    ret.connect();
    return ret;
  }

  // Public: Hides the WebView
  hide() {
    logger.info(`${this.webViewId} hidden`);
    this.wv.style.visibility = 'hidden';
  }

  // Public: Shows the WebView
  show() {
    logger.info(`${this.webViewId} shown`);
    this.wv.style.visibility = 'visible';
    this.wv.focus();
  }

  // Public: Gives the WebView control focus
  focus() {
    this.wv.focus();
  }

  // Public: Attaches the views associated with this ViewController and kicks off
  // the actual site loading (i.e. navigating to the SSB URL)
  //
  // Returns an Observable Promise, a Disposable which will undo all of the work
  // that attachToDom did, or errors if the SSB fails to load
  attachToDom() {
    // Return an Observable signaling when we're ready
    let ret = this.getSingleFinishedLoadObservable().map(() => {
      rx.Disposable.create(() => {
        this.currentAttach.setDisposable(rx.Disposable.empty);
      });
    });

    // NB: Normally we wouldn't have to be so strict with unhooking our events,
    // but WebView is a bit of a Special Snowflake
    if (this.disableSlackClientFeatures) {
      this.currentAttach.setDisposable(new rx.CompositeDisposable(
        this.setUpLinkHandling(),
        this.setUpContextMenus(),
        this.setUpDomHost(),
        this.setUpLoadTimeout()
      ));
    } else {
      this.currentAttach.setDisposable(new rx.CompositeDisposable(
        this.setUpDevTools(),
        this.setUpLinkHandling(),
        this.setUpDownloadHandling(),
        this.setUpContextMenus(),
        this.setUpDomHost(),
        this.setUpLoadTimeout(),
        this.setUpCallRefreshTeamsOnSigninEvents(),
        this.setUpSsbJavaScriptContext()
      ));
    }

    ret = ret.publishLast();
    ret.connect();
    return ret;
  }
  
  // Private: Used to forward team-specific messages from the embedded page to
  // the controller, tacking on some information that identifies which WebView
  // they came from.
  //
  // target - A target {Observable} to multicast the messages onto
  //
  // Returns a {Disposable} that will undo what the method did
  forwardTeamMessages(target) {
    let messages = new Set(['update', 'signInTeam', 'displayTeam', 'setImage',
      'refreshTileColors', 'setBadgeCount', 'invalidateAuth',
      'setConnectionStatus', 'preferenceChange']);

    return this.webViewIpc
      .where((x) => messages.has(x.channel))
      .map((x) => _.extend({}, x, { webViewId: this.webViewId }))
      .multicast(target)
      .connect();
  }

  // Public: Returns the guest instance ID for the given WebView; in the
  // webview's context, this is process.guestInstanceId
  //
  // Returns the Id as a {Number}
  getGuestInstanceId() {
    if (this._guestInstanceId) {
      return this._guestInstanceId;
    }

    // XXX: This is an evil hack and I feel shame for it
    let webViewImpl = process.atomBinding('v8_util').getHiddenValue(this.wv, 'internal');
    return (this._guestInstanceId = webViewImpl.guestInstanceId);
  }

  // Public: Asks the SSB code to send us a new team list
  //
  // Returns an Observable Promise indicating when this code completes
  refreshTeams() {
    return this.executeJavaScript('TS.refreshTeams()');
  }

  // Public: Asks the SSB code to send us the colors for the current theme
  //
  // Returns an Observable Promise indicating when this code completes
  getThemeValues() {
    return this.getWebAppApiReadyObservable()
      .flatMap(() => this.executeJavaScript('TSSSB.getThemeValues()'));
  }

  // Public: Asks the WebView to replace text in the given input field
  //
  // correction - The text that will replace the selected misspelling
  //
  // Returns nothing
  replaceText(correction) {
    if (this.wv) {
      this.wv.replaceMisspelling(correction);
    }
  }

  // Public: Executes JavaScript in the context of the SSB and returns the
  // result, as long as it is JSON-serializable (unlike the built-in
  // executeJavaScript)
  //
  // Returns an Observable Promise which is either the return value of the
  // code that was invoked, or onErrors with the Error that was thrown.
  executeJavaScript(code) {
    let msg = { code: code, id: uuid.v4() };
    if (!this.wv) return rx.Observable.empty();

    let ret = this.webViewIpc
      .where((x) => {
        if (x.channel !== 'eval-async') return false;
        if (x.args.length !== 1) return false;
        if (!(x.args[0].result || x.args[0].error)) return false;
        return (x.args[0].id === msg.id);
      })
      .flatMap((x) => {
        let thisMsg = x.args[0];
        if (thisMsg.error) {
          return rx.Observable.throw(new Error(`${thisMsg.error.message}\n${thisMsg.error.stack}`));
        }
        
        if (thisMsg.result === null) {
          return rx.Observable.return(null);
        }
        
        return rx.Observable.return(JSON.parse(thisMsg.result));
      })
      .take(1)
      .timeout(10*1000).catch(() => {
        // TODO: Figure out why this is happening
        return rx.Observable.return(null);
      })
      .publishLast();

    ret.connect();

    // NB: This is a secret handshake with the embedded page
    this.wv.executeJavaScript(`window.rendererEvalAsync(\"${btoa(encodeURIComponent(JSON.stringify(msg)))}\")`);
    return ret;
  }

  // Public: Undoes everything that the class has currently done and cleans up
  // the WebView
  dispose() {
    this.currentAttach.dispose();
  }

  // Private: Sets up a `crashed` {Observable} that combines error and timeout
  // events from the WebView and publishes them for consumption
  //
  // fakeCrash - An {Observable} that simulates that the WebView has crashed,
  //             useful for unit testing
  //
  // Returns an {Observable} representing all crashes and load errors
  setUpErrorHandling(fakeCrash) {
    this.fireSsbLoadTimeout = new rx.Subject();
    let ssbLoadTimeout = this.disableSlackClientFeatures ? rx.Observable.empty() : this.fireSsbLoadTimeout;

    let crashed = rx.Observable.merge(
      rx.DOM.fromEvent(this.wv, 'crashed').map(() => 'Renderer'),
      rx.DOM.fromEvent(this.wv, 'gpu-crashed').map(() => 'GPU'),
      rx.DOM.fromEvent(this.wv, 'plugin-crashed').map((n, v) => `Plugin ${n} ${v}`),
      ssbLoadTimeout.map(() => 'Load timeout'),
      this.fakeCrash.map(() => 'Unit test')
    );

    // HACK: The unit tests currently crash the test runner because we're somehow
    // crashing the WebView context (surprise!), then we're attempting to resurrect
    // it reentrantly
    if (global.loadSettings.testMode && fakeCrash) {
      crashed = this.fakeCrash;
    }

    return crashed.publish().refCount();
  }

  // Private: Sets up the IPC events from the browser to handle the "Toggle Dev
  // Tools" menu item
  //
  // Returns a {Disposable} that will undo what the method did
  setUpDevTools() {
    return browser.listen('window:toggle-dev-tools').subscribe((args) => {
      let tvc = global.teamsViewController;
      if (!tvc.primaryTeam || !tvc.primaryTeam.webView) return;

      // Only open Dev Tools for the primary team
      let primaryId = tvc.primaryTeam.webView.webViewId;
      if (this.webViewId !== primaryId) return;

      let [hostDevToolsWillOpen] = args;

      this.sched.scheduleWithRelative(40, () => {
        if (hostDevToolsWillOpen) {
          this.wv.openDevTools();
        } else {
          this.wv.closeDevTools();
        }
      });
    });
  }

  // Private: Handles links by opening them in the default browser
  //
  // Returns a {Disposable} that will undo what the method did
  setUpLinkHandling() {
    return rx.DOM.fromEvent(this.wv, 'new-window').subscribe((e) => {
      try {
        let theUrl = url.parse(e.url);
        let validProtocols = ['http:', 'https:', 'mailto:', 'skype:',
          'callto:', 'tel:', 'im:', 'sip:', 'sips:'];

        if (!_.contains(validProtocols, theUrl.protocol)) {
          throw new Error("Invalid protocol");
        }

        logger.info(`Opening external window to ${e.url}`);
        shell.openExternal(e.url);
      } catch (error) {
        logger.warn(`Ignoring ${e.url} due to ${error.message}`);
      }
    });
  }

  // Private: Sets up a {DownloadManager} that will respond to download-related
  // messages from the SSB
  //
  // Returns a {Disposable} that will undo what the method did
  setUpDownloadHandling() {
    this.downloadManager = new DownloadManager({webView: this});

    return this.webViewIpc
      .where(({channel}) => channel.startsWith('downloads:'))
      .subscribe(({channel, args}) => {
        let data = args[0];

        switch (channel) {
        case 'downloads:start':
          this.downloadManager.startDownload(data.url, data.token);
          break;
        case 'downloads:cancel':
          this.downloadManager.cancelDownload(data.token);
          break;
        case 'downloads:retry':
          this.downloadManager.retryDownload(data.token);
          break;
        case 'downloads:prune':
          this.downloadManager.pruneDownloads(data.tokens);
          break;
        case 'downloads:reveal':
          this.downloadManager.revealDownload(data.token);
          break;
        }
      });
  }

  // Private: Sets up a {ContextMenuBuilder} with a hook that receives
  // context menu events from the SSB
  //
  // Returns a {Disposable} that will undo what the method did
  setUpContextMenus() {
    let signal = this.webViewIpc
      .where((x) => x.channel === 'context-menu')
      .map((x) => x.args[0]);

    let menuOpts = {
      webView: this,
      signal: signal,
      devMode: global.loadSettings.devMode || process.env.SLACK_DEVELOPER_MENU
    };
    let contextMenuBuilder = new ContextMenuBuilder(menuOpts);

    return rx.Disposable.create(() => {
      contextMenuBuilder.dispose();
    });
  }

  // Private: Actually adds us to the DOM and kicks off the loading of the SSB
  // site
  //
  // Returns a {Disposable} that will undo what the method did
  setUpDomHost() {
    let ret = rx.Disposable.create(() => {
      if (this.wv) this.docRoot.removeChild(this.wv);
    });

    this.wv.setAttribute('src', this.targetUrl);
    this.wv.useragent = getUserAgent();

    this.docRoot.appendChild(this.wv);
    return ret;
  }

  // Private: Injects the Web View ID into the SSB's global context. The SSB uses
  // this as a secret handshake with the renderer/browser processes so that they
  // can tell which WebView is sending us messages, as well as the load settings.
  //
  // Returns a {Disposable} that will undo what the method did
  setUpSsbJavaScriptContext() {
    return this.getSingleFinishedLoadObservable().subscribe(() => {
      if (this.wv) {
        let cmd = `window.webViewId = \"${this.webViewId}\"`;
        this.wv.executeJavaScript(cmd);
      }
    });
  }

  // Private: Listens for the SSB signaling us of changes to the signed-in teams
  // list and respond by asking for an updated team list
  //
  // Returns a {Disposable} which will stop listening for changes
  setUpCallRefreshTeamsOnSigninEvents() {
    let refreshEligibleEvents = ['didSignIn', 'didSignOut'];

    return this.webViewIpc
      .where((x) => refreshEligibleEvents.indexOf(x.channel) !== -1)
      .do(() => logger.info("Got didSignIn/out, attempting to refresh teams"))
      .subscribe(() => {
        if (this.wv) {
          this.wv.executeJavaScript("winssb.teams.refreshTeams()");
        }
      });
  }

  // Private: Waits for the loaded Observable to fire and if it doesn't in a certain
  // amount of time, we burn it all down and issue a page reload
  //
  // Returns a {Disposable} which will disconnect this event
  setUpLoadTimeout() {
    if (global.loadSettings.devMode) return rx.Disposable.empty;

    return this.getWebAppApiReadyObservable().map(() => true)
      .take(1)
      .timeout(32 * 1000)
      .catch(rx.Observable.return(false))
      .where((x) => x === false)
      .do(() => logger.warn("Took too long to load, going to issue a refresh"))
      .subscribe(() => this.fireSsbLoadTimeout.onNext(true));
  }

  // Private: Maps the events that WebView generates into an Observable that
  // represents a single load
  //
  // Returns an Observable that completes once when the page has finished
  // initially loading. Note that this is not the same as when the webapp
  // is fully loaded.
  getSingleFinishedLoadObservable() {
    // NB: Atom Shell appears to drop did-finish-load on the floor sometimes :(
    return rx.Observable.merge(
      rx.Observable.interval(3 * 1000),
      rx.DOM.fromEvent(this.wv, 'did-finish-load')
    ).take(1);
  }

  // Private: Returns an Observable for when the webapp is fully loaded
  // (i.e. when TSSSB is available and the message server is connected).
  //
  // Returns an Observable that completes once when the page has finished
  // fully loading.
  getWebAppApiReadyObservable() {
    return this.tsReadySubj;
  }
}

module.exports = SlackWebViewContext;
