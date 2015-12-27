const url = require('url');
const path = require('path');
const browser = require('./ipc-rx');
const _ = require('lodash');
const remote = require('remote');
const nativeInterop = require('../native-interop');
const fs = require('fs');

const PreferencesHandler = require('./preferences-handler');
const LoadingScreen = require('./loading-screen');
const LoginDialog = require('./login-dialog');
const NetworkStatus = require('../network-status');
const SlackWebViewContext = require('./web-view-ctx');
const TeamsView = require('./teams-view');
const ThemeCache = require('./theme-cache');
const BadgeManager = require('./badge-manager');

const rx = require('rx-dom');

const logger = require('../browser/logger').init(__filename);

let NativeNotification = null;
const sortableConnectionStatus = {
  'online': 0,
  'connecting': 1,
  'offline': 2
};

const sortableConnectionStatusToName = _.invert(sortableConnectionStatus);

// Public: Manages the top-level interaction of the application. This class will
// also end up managing the multiple-team support.
class TeamsViewController {
  // Public: Creates a new instance of TeamsViewController
  //
  // options - a hash that allows dependencies to be injected in a test runner.
  //           The most useful ones being:
  //
  //     :loadingScreen - an instance of {LoadingScreen}
  //     :loginDialog - an instance of {LoginDialog}
  //     :networkStatus - an instance of {NetworkStatus} that can be overridden
  //                      to simulate network conditions
  //     :docRoot - The DOM node to attach to
  //     :reporter - The Metrics Reporter to use
  constructor(options={}) {
    const {loadingScreen, loginDialog, networkStatus, prefsHandler, docRoot,
      windowResize, ssbMessages, localStorage, reporter, sendToBrowser,
      badgeManager} = options;

    this.options = options;
    this.loadingScreen = loadingScreen || new LoadingScreen();
    this.loginDialog = loginDialog || new LoginDialog({ reporter: this.reporter });
    this.networkStatus = networkStatus || new NetworkStatus({ checkNow: this.loadingScreen.tryAgainObservable });
    this.prefsHandler = prefsHandler || new PreferencesHandler({ teamsViewController: this });
    this.teamsView = new TeamsView();
    this.docRoot = docRoot || document.body;
    this.windowResize = windowResize || rx.DOM.resize(global.window).startWith(null);
    this.ssbMessages = ssbMessages || new rx.Subject();
    this.localStorage = localStorage || window.localStorage;
    this.loadDisposable = rx.Disposable.empty;
    this.sendToBrowser = sendToBrowser || function(channel, ...args) { browser.send(channel, ...args); };
    this.reporter = reporter;

    this.themeCache = new ThemeCache({localStorage: this.localStorage});
    this.badgeManager = badgeManager || new BadgeManager();

    let teamList = JSON.parse(this.localStorage.getItem("teamList") || "42");
    if (teamList && teamList.length && _.all(teamList, (x) => x.team_id)) {
      this.teamList = teamList;
    }

    this.teamList = this.teamList || [];

    for (var team of this.teamList) {
      _.extend(team, this.themeCache.fetchThemeInfoAndIconsForTeam(team));
    }

    this.attachDisp = new rx.SerialDisposable();

    this.primaryTeamDisp = new rx.SerialDisposable();
    this.primaryTeam = null;

    if (this.reporter) {
      this.loadDisposable = this.reporter.sendTimingDisposable('performance', 'appFullLoad');
    }
  }

  // Public: Attaches the views associated with this ViewController and kicks off
  // the actual Loading => Visible state machine
  //
  // Returns an Observable Promise, a Disposable which will undo all of the work
  // that attachToDom did
  attachToDom(options={})  {
    let stuffToLoad = [ this.loadingScreen, this.loginDialog, this.teamsView ];
    if (options.docRoot) this.docRoot = options.docRoot;

    let loadAll = rx.Observable.fromArray(stuffToLoad)
      .concatMap((x) => rx.Observable.defer(() => x.attachToDom({ docRoot: this.docRoot })))
      .reduce((acc, x) => { acc.add(x); return acc; }, new rx.CompositeDisposable());

    return loadAll.map((loadingDisp) => {
      let disp = new rx.CompositeDisposable(loadingDisp);

      this.loadingScreen.showTrying();

      disp.add(rx.Disposable.create(() => {
        this.makeTeamPrimary(null);
        this.trashAllTeamWebviews();
      }));

      disp.add(browser.listen('application:show-settings').subscribe(() => {
        this.openPreferences();
      }));

      disp.add(browser.listen('application:deep-link').subscribe(([deepUrl]) => {
        this.handleDeepLink(deepUrl);
      }));

      let shouldUpdate = rx.Observable.merge(
        this.ssbMessageNamed('update'),
        this.loginDialog.signinRequestedClose
          .map(() => [[{ id: '__signin__', team_id: '__signin__', reason: 'didSignIn'}]])
      );

      disp.add(shouldUpdate.subscribe((args) => {
        logger.info(`Updating! ${JSON.stringify(args[0] || 'none')}`);

        this.loginDialog.close();
        this.presentAvailableTeams(args[0]);
      }));

      let signin = rx.Observable.merge(
        this.ssbMessageNamed('signInTeam'),
        browser.listen('window:signin'),
        this.teamsView.teamSelector.teamAddClicked
      );

      let loginDialog = this.loginDialog;
      disp.add(signin.subscribe(() => {
        logger.info("Signing in a new team");

        loginDialog.setCancelable(true);
        loginDialog.show();
      }));

      disp.add(this.ssbMessageNamed('invalidateAuth').subscribe(() => {
        this.isAuthInvalidated = true;
      }));

      disp.add(this.ssbMessageNamed('displayTeam').subscribe((args) => {
        let team = _.find(this.teamList, (x) => x.id === args[0]);

        if (!team) {
          if (this.reporter) this.reporter.sendEvent('window', 'teamStateIsBroken');
          logger.warn(`Tried to switch to nonexistent team: ${args[0]}`);
          return;
        }

        this.makeTeamPrimary(team);
      }));

      disp.add(this.ssbMessageNamed('setImage', true).subscribe((result) => {
        this.updateTeamIcons({ webViewId: result.webViewId, icons: result.args[0] });
      }));

      // Just update the notifications that are active.
      disp.add(this.ssbMessageNamed('refreshTileColors').subscribe(() => {
        logger.debug("Updating the themes!");

        if (this.primaryTeam) {
          this.updateTeamThemes([this.primaryTeam]);
        }
      }));

      disp.add(this.ssbMessageNamed('setConnectionStatus', true).subscribe((x) => {
        let {webViewId, args} = x;
        let team = this.teamFromWebViewId(webViewId);

        if (!team) return;
        team.badgeInfo = team.badgeInfo || {};
        team.badgeInfo.connectionStatus = sortableConnectionStatus[args[0]] || 0;

        this.updateBadgeInfoForTeam(team, team.badgeInfo);
      }));

      disp.add(browser.listen('window:dispose').subscribe(() => {
        this.reloadCount = this.reloadCount ? this.reloadCount + 1 : 1;
        if (this.reporter) this.reporter.sendEvent('window', 'reload', null, this.reloadCount);

        this.dispose();
      }));

      disp.add(browser.listen('window:select-team')
        .subscribe((index) => this.makeTeamPrimary(this.teamList[index])));

      disp.add(browser.listen('window:select-next-team')
        .subscribe(() => this.moveTeamByOffset(1)));

      disp.add(browser.listen('window:select-previous-team')
        .subscribe(() => this.moveTeamByOffset(-1)));

      disp.add(browser.listen('notify:show')
        .subscribe((args) => this.showNativeNotification(args[0])));

      disp.add(browser.listen('notify:click')
        .subscribe((args) => this.handleNotificationClick(args[0])));

      disp.add(this.setupNetworkStatusStateMachine());

      disp.add(this.prefsHandler.setup());

      disp.add(rx.DOM.fromEvent(window, 'onbeforeunload')
        .subscribe(() => this.reporter.dispose()));

      let themeOrIconsChanged = rx.Observable.merge(
        this.themeCache.iconsChanged,
        this.themeCache.themeChanged);

      disp.add(themeOrIconsChanged.subscribe((team_id) => {
        let team = _.find(this.teamList, (x) => x.team_id === team_id);
        if (!team) return;

        this.teamsView.teamSelector.updateExistingTeamInList(team);
        this.teamsView.teamSelector.setSelectionStatus(team, this.primaryTeam.team_id === team.team_id);
      }));

      disp.add(this.teamsView.teamSelector.clicked.subscribe((team_id) => {
        logger.debug(`About to switch teams because click, ${team_id}`);

        let team = _.find(this.teamList, (x) => x.team_id === team_id);
        if (team) this.makeTeamPrimary(team);
      }));

      disp.add(this.teamsView.teamSelector.sorted.subscribe((sortedIds) => {
        logger.debug(`Teams list was rearranged, ${JSON.stringify(sortedIds)}`);
        if (this.reporter) this.reporter.sendEvent('team-selector', 'rearrange');

        let sortedTeamList = [];

        for (var index = 0; index < sortedIds.length; index++) {
          let team_id = sortedIds[index];
          let team = _.find(this.teamList, (x) => x.team_id === team_id);
          if (!team) continue;

          sortedTeamList.push(team);
          this.teamsView.teamSelector.updateExistingTeamInList(team, index + 1);
        }

        this.teamList = sortedTeamList;
        this.sendToBrowser('teams:update-menu', this.getTrimmedTeamList());
        this.serializeTeamList();
      }));

      disp.add(this.ssbMessageNamed('setBadgeCount', true).subscribe((x) => {
        logger.debug(`Setting the badge count! ${JSON.stringify(x)}`);

        let {webViewId, args} = x;
        let team = this.teamFromWebViewId(webViewId);

        if (!team) {
          logger.warn("Calling setBadgeCount with a removed or null webViewId, ignoring");
          if (this.reporter) this.reporter.sendEvent('team-selector', 'settingBadgeOnBorkedWebView');
          return;
        }

        this.updateBadgeInfoForTeam(team, args[0]);
      }));

      disp.add(this.setupIdleTickle());

      disp.add(browser.listen('eval-async').subscribe((args) => {
        let data = args[0];

        if (!data.guestInstanceId) {
          logger.error(`Sent eval to main app without guest ID! ${JSON.stringify(data)}`);
          return;
        }

        let team = _.find(this.teamList, (x) => x.webView && x.webView.getGuestInstanceId() === data.guestInstanceId);
        if (!team) {
          // If we get here, we didn't match anything, this shouldn't happen
          logger.error(`Sent eval to main app without guest ID! ${JSON.stringify(data)}`);
          return;
        }

        team.webView.wv.send('eval-async', data);
      }));

      this.attachDisp.setDisposable(disp);
      return rx.Disposable.create(() => this.attachDisp.setDisposable(rx.Disposable.empty));
    });
  }

  // Public: Sets the given team (probably returned from {fetchTeam}) as the
  // currently visible team (i.e. the one being shown in the main Window). Calling
  // {makeTeamPrimary} with `null` will hide all of the teams and most likely
  // result in the "Connecting" spinner being shown
  //
  // team - the team object to load or null
  //
  // Returns the team that was passed into makeTeamPrimary
  makeTeamPrimary(team) {
    if (!team) {
      logger.info("Clearing primary team");

      this.primaryTeam = null;
      this.primaryTeamDisp.setDisposable(rx.Disposable.empty);

      this.loadingScreen.showTrying();
      this.sendToBrowser('teams:team-changed');

      return null;
    }

    this.loadingScreen.hideAll();

    if (this.primaryTeam && team.team_id === this.primaryTeam.team_id) {
      return team;
    }

    let changed = {
      teamName: team.team_name,
      webViewId: team.webView ? team.webView.webViewId : null
    };
    this.sendToBrowser('teams:team-changed', changed);

    let lastTeamId = this.primaryTeam ? this.primaryTeam.team_id : 'null';
    logger.info(`Going to change team to ${team.team_id}, original team was ${lastTeamId}`);

    let ret = new rx.CompositeDisposable();

    ret.add(rx.Disposable.create(() => {
      if (team.webView) team.webView.hide();
    }));

    // Ensure that when you Alt-tab back to the Window, the active WebView
    // has control focus so that keyboard shortcuts work
    ret.add(browser.listen('windowFocus')
      .subscribe(() => team.webView.focus()));

    ret.add(team.webView.crashed
      .subscribe((type) => this.handleWebViewCrash(type, team.team_url)));

    if (global.Bugsnag) {
      global.Bugsnag.user = {
        team: team.team_id,
        user: team.id
      };
    }

    this.primaryTeam = team;
    this.primaryTeamDisp.setDisposable(ret);
    team.webView.show();

    this.updateBadgeInfoForTeam(this.primaryTeam, null, true);

    this.loadDisposable.dispose();
    logger.info(`Primary team set to ${team.team_id}`);
    return ret;
  }

  // Public: Loads the team from the given team ID and initializes a WebView for
  // it. It sets up a `webView` object which is a {SlackWebViewContext}, as well
  // as a `webViewLoaded` Observable Promise that fires once the site associated
  // with this browser is fully loaded (i.e. the SSB has called didFinishLoading)
  //
  // teamId - The team ID from the Slack API to load.
  // forceCreate - (Optional) Create a new WebView even if we've got an existing
  //               one, used if we detect that the old WebView has crashed.
  //
  // Returns a Hash with the Team info provided by the SSB. The current parameters
  // provided by the SSB are:
  //
  //       :id - the User ID for the signed-in user *on that team*
  //       :name - the User name for the signed-in user
  //       :team_id - the API ID of the team
  //       :team_name - the friendly name of the team
  //       :team_url - the base URL for the team
  //
  //       :webView - the {SlackWebViewContext} associated with this team
  //       :webViewLoaded - an Observable Promise that will fire once the
  //                        associated WebView has fully loaded.
  fetchTeam(teamId, forceCreate=false) {
    let team = _.find(this.teamList, (x) => x.team_id === teamId);
    if (!team) return null;

    if (team.webView && !forceCreate) return team;

    if (team.webView) team.webView.dispose();

    let opts = _.extend(this.options, {
      targetUrl: team.team_url,
      docRoot: this.teamsView.teamContent,
      reporter: this.reporter
    });

    team.initials = this.getInitialsOfName(team.team_name);

    team.webView = new SlackWebViewContext(opts);
    team.webView.forwardTeamMessages(this.ssbMessages);

    team.webViewLoaded = team.webView.attachToDom()
      .flatMap(() => this.prefsHandler.syncPreferencesForTeam(team))
      .do(() => this.onTeamLoaded(team))
      .publishLast();

    team.webViewLoaded.connect();

    // NB: We're not getting 'didSignOut' anymore, so we need to interpret window.close
    // as what we *used* to do before
    let signinFakeTeamInfo = [{ id: '__signin__', team_id: '__signin__', reason: 'didSignOut' }];

    team.webView.requestedClose.subscribe(() => {
      if (this.isAuthInvalidated) {
        // NB: When the user's auth is invalidated for some reason (e.g., 2FA
        // enabled or the team 'kill switch'), we'll be auto-signed out and
        // beyond recovery due to losing our preload globals. In this case, we
        // should bypass our standard teams flow and just refresh the app.
        this.isAuthInvalidated = false;
        global.slackApplication.reload();
      } else {
        this.presentAvailableTeams(signinFakeTeamInfo);
      }
    });

    logger.info(`Created new webView context for ${teamId}`);
    return team;
  }

  // Private: Occurs when the webView associated with a given team has loaded
  //
  // team - The team whose webView finished loading
  //
  // Returns nothing
  onTeamLoaded(team) {
    if (!team.webView) {
      logger.error(`onTeamLoaded called for ${team.team_name}, which has no webView`);
      return;
    }
    
    let args = { webViewId: team.webView.webViewId, initials: team.initials };
    this.sendToBrowser('teams:update-header', args);
  }

  // Public: Opens preferences for the specified team, or if null,
  // the currently visible team
  //
  // Returns nothing
  openPreferences(team=null) {
    team = team || this.primaryTeam;

    this.executeJavaScript('TSSSB.openDialog(\"prefs\")', team);
  }

  // Public: Forwards Slack protocol URLs to the SSB for further handling
  //
  // urlString - The URL, which uses our custom 'slack:' protocol
  //
  // Returns an {Observable} indicating completion
  handleDeepLink(urlString) {
    if (!_.isString(urlString)) return rx.Observable.return(null);

    let theUrl = url.parse(urlString, true);
    if (theUrl.protocol !== 'slack:') {
      logger.warn(`Unable to handle ${urlString} because no slack: protocol.`);
      return rx.Observable.return(null);
    }

    if (this.teamList.length === 0) {
      logger.warn(`Unable to handle ${urlString} because no teams are signed in.`);
      return rx.Observable.return(null);
    }

    let args = theUrl.query;
    args.cmd = theUrl.host;

    // NB: If a team was provided that matches one of our existing teams,
    // switch to it and execute JavaScript in that context. Otherwise, use the
    // currently selected team.
    let team = null;
    if (args.team) {
      team = _.find(this.teamList, (x) => x.team_id === args.team) || this.primaryTeam;
      if (team.team_id !== this.primaryTeam.team_id) {
        this.makeTeamPrimary(team);
      }
    }

    let command = `TSSSB.handleDeepLinkWithArgs('${JSON.stringify(args)}')`;
    logger.info(`handleDeepLinkWithArgs: ${urlString}`);
    return this.executeJavaScript(command, team);
  }

  // Private: For OS X / Linux, this uses the HTML5 Notification API.
  // On Windows, this uses our standalone SlackNotifier.
  //
  // Returns nothing
  showNativeNotification(args) {
    let team = this.teamFromWebViewId(args.webViewId);

    let options = {
      body: args.content,
      theme: team ? team.theme : args.theme,
      initials: team ? team.initials : args.initials,
      screenPosition: args.screenPosition,
      launchUri: args.launchUri
    };

    let icons = team ? team.icons : args.icons;
    if (icons) {
      options.icon = icons.image_132 ||
        icons.image_102 ||
        icons.image_68;
    }

    // NB: We delay-initialize notifications here because if we attempt to
    // load edge.js and SlackNotifier during startup it hangs Electron.
    if (!NativeNotification) {
      if (process.platform === 'win32') {
        NativeNotification = require('../csx/native-notifications');
      } else {
        NativeNotification = window.Notification;
      }
    }

    let notification = new NativeNotification(args.title, options);
    this.sendToBrowser('notify:flash-start');

    // Pass clicks back up to the {NotificationController} for handling.
    rx.DOM.fromEvent(notification, 'click').take(1)
      .subscribe(() => this.sendToBrowser('notify:click', args));

    rx.DOM.fromEvent(notification, 'close').take(1)
      .subscribe(() => this.sendToBrowser('notify:flash-end'));
  }

  // Private: When the user clicks a notification, find the appropriate webView
  // and activate it. Also switches to the appropriate channel / DM using an
  // SSB call.
  //
  // Returns nothing
  handleNotificationClick(args) {
    for (var team of this.teamList) {
      if (!team.webView || team.webView.webViewId !== args.webViewId) continue;

      let command = `TSSSB.focusTabAndSwitchToChannel('${args.channel}')`;
      team.webView.executeJavaScript(command).subscribe();

      this.makeTeamPrimary(team);
      return;
    }
  }

  // Public: Called to indicate that the badge information for a team has changed.
  // We then roll through all of the teams to calculate the *global* badge
  // information (i.e. what to display on the dock badge / tray icon), as well as
  // signaling the team selector on the left to reflect the new status
  //
  // teamToUpdate - the team from teamList to update
  // badgeInfo - (Optional) an Object from the webapp, sent by ssb/team.coffee
  //
  // Returns nothing
  updateBadgeInfoForTeam(teamToUpdate, badgeInfo, updateAll=false) {
    if (!teamToUpdate || !teamToUpdate.team_id) {
      logger.error("teamToUpdate is null!");
      return;
    }

    teamToUpdate = _.find(this.teamList, (x) => x && x.team_id === teamToUpdate.team_id);
    if (!teamToUpdate) return;

    // NB: Only update badgeInfo if it was sent from the SSB, otherwise trust
    // the state stored on the team
    if (badgeInfo) teamToUpdate.badgeInfo = badgeInfo;

    logger.debug(`Updating badge info: ${teamToUpdate.team_id} => ${JSON.stringify(teamToUpdate.badgeInfo)}`);

    let unread = 0;
    let unreadHighlights = 0;
    let connectionStatus = -1;

    for (var team of this.teamList) {
      if (team.badgeInfo) {
        unread += team.badgeInfo.unread;
        unreadHighlights += team.badgeInfo.unreadHighlights;
      }

      let thisStatus = (!team.badgeInfo || !team.badgeInfo.connectionStatus) ? -1 : team.badgeInfo.connectionStatus;
      connectionStatus = Math.max(connectionStatus, thisStatus);

      if (updateAll) {
        this.teamsView.teamSelector.setSelectionStatus(team, team.team_id === this.primaryTeam.team_id);
      }
    }

    if (!updateAll) {
      this.teamsView.teamSelector.setSelectionStatus(teamToUpdate, teamToUpdate.team_id === this.primaryTeam.team_id);
    }

    let realConnectionStatus = sortableConnectionStatusToName[connectionStatus] || 'online';
    this.badgeManager.setGlobalBadgeCount(unreadHighlights, unread, realConnectionStatus);
  }

  // Public: Executes JavaScript in the context of each team's webView
  //
  // Returns an Observable that indicates completion
  executeJavaScriptForAllTeams(command) {
    let ret = rx.Observable.fromArray(this.teamList)
      .map((team) => this.executeJavaScript(command, team))
      .mergeAll()
      .publishLast();

    ret.connect();
    return ret;
  }

  // Public: Executes a chunk of JavaScript on the webView of the specified
  // team, or if null, the currently visible team
  //
  // Returns an Observable Promise which is either the return value of the
  // code that was invoked, or onErrors with the Error that was thrown.
  executeJavaScript(command, team=null) {
    team = team || this.primaryTeam;
    if (team && team.webView) {
      let ret = team.webView.getWebAppApiReadyObservable()
        .flatMap(() => team.webView.executeJavaScript(command))
        .publish();
      ret.connect();
      return ret;
    } else {
      logger.warn(`No team or webView, ${command} dropped on the floor`);
      return rx.Observable.return(null);
    }
  }

  // Private: Watch the network status for changes and push the view to the
  // appropriate scene
  //
  // Returns a {Disposable} that will cancel the listener
  setupNetworkStatusStateMachine() {
    this.loadingScreen.showTrying();

    return this.networkStatus.statusObservable().subscribe((online) => {
      logger.info(`Transitioning to ${online ? "online" : "offline"} state`);

      if (online) {
        this.presentAvailableTeams();
        return;
      }

      // Some variety of Offline
      this.makeTeamPrimary(null);

      if (this.networkStatus.browserIsOnline() && this.networkStatus.reason === 'slackDown') {
        if (this.reporter) this.reporter.sendEvent('session', 'slackIsDown');
        this.loadingScreen.showSlackDown();
      } else {
        this.loadingScreen.showOffline();
      }
    });
  }

  // Private: Set up a timer to ping the message server at a fixed interval so
  // that the idle timer for the webapp is based on the user's machine, not whether
  // they've looked at a particular team
  //
  // Returns a {Disposable} that will kill the timer
  setupIdleTickle() {
    const time = 1 * 60 * 1000;

    return rx.Observable.timer(time, time).subscribe(() => {
      let idleTime = nativeInterop.getIdleTimeInMs();
      if (idleTime >= 10 * 1000) return;

      for (var team of this.teamList) {
        if (!team.webView) continue;

        team.webView.executeJavaScript('if (window.TSSSB) TSSSB.maybeTickleMS();')
          .catch(rx.Observable.empty())
          .subscribe();
      }
    });
  }

  // Private: Handles the process of updating the team list from the result
  // returned from the SSB. Once we have a list of teams that should have a
  // "Tab" in the SSB, we kick off loading the SSB contents, then determine
  // if the currently visible team (if any) should still be shown. For example,
  // if the user logs out of the currently visible team, we need to pick a new
  // team to show. This method handles that decision, as well as the handling of
  // showing the login dialog when all of the teams have been removed.
  //
  // Returns nothing
  presentAvailableTeams(updatedTeamList) {
    logger.info("Presenting teams");

    let toDispose = rx.Disposable.empty;
    let newTeams = [];
    let didMergeTeamList = false;
    this.teamList = this.teamList || [];

    let loggedOffTheLastUser =
      updatedTeamList && updatedTeamList.length === 1 &&
      updatedTeamList[0].reason === 'didSignOut' &&
      updatedTeamList[0].id === "__signin__" &&
      this.teamList.length === 1;

    if (loggedOffTheLastUser) updatedTeamList = [];

    // NB: On signin/signout, we're going to get a bogus team list from the webapp. If
    // it is at all possible, ignore it.
    if (_.find(updatedTeamList || [], (x) => x.id === '__signin__') && this.teamList.length > 0) {
      updatedTeamList = null;

      let anyOtherTeam = _.find(this.teamList, (x) => x.id !== '__signin__' && x.webView);
      if (anyOtherTeam && anyOtherTeam.webView) {
        anyOtherTeam.webView.refreshTeams();
      }

      if (!loggedOffTheLastUser) return;
    }

    if (this.shouldMergeTeamList(updatedTeamList)) {
      let tl = this.mergeTeamList(updatedTeamList);
      toDispose = tl.toDispose;
      newTeams = tl.newTeams;

      didMergeTeamList = true;
    }

    this.serializeTeamList();

    if (this.teamList.length === 0 || loggedOffTheLastUser) {
      logger.info("No Teams to Present! Showing login dialog");

      this.makeTeamPrimary(null);
      this.loginDialog.setCancelable(false);
      this.loginDialog.show();
      return;
    }

    // Kick off loading of all the teams' Webviews
    for (var team of this.teamList) {
      this.fetchTeam(team.team_id);
    }

    if (newTeams.length > 0) {
      this.makeTeamPrimary(newTeams[0]);
    } else {
      // If the team that is currently visible just got kicked out, we need
      // to pick a new team
      if (!this.primaryTeam || !_.find(this.teamList, (x) => x.team_id === this.primaryTeam.team_id)) {
        this.makeTeamPrimary(this.teamList[0]);
      }
    }

    if (this.teamList.length === 1 && this.teamList[0].id === '__signin__') {
      this.teamList[0].webViewLoaded.subscribe(() => {
        this.teamList[0].webView.refreshTeams();
      });
    }

    if (didMergeTeamList) {
      this.teamsView.teamSelector.updateTeamList(this.teamList, this.primaryTeam);
      this.updateTeamThemes();
      this.updateTeamMenu();

      if (this.reporter) {
        this.reporter.sendEvent('session', 'teamCount', null, this.teamList.length);
      }
    }

    // Clean up the WebViews that we removed as a result of mergeTeamList finding
    // stale teams in our list
    toDispose.dispose();
  }

  // Private: Attempts to determine if the updated team list from the webapp is
  // a dupe, so that we should ignore it. However, there are some tricks, in that
  // if our local storage version is the same as the updated one, we still should
  // run the merge *once* to update the sidebar etc etc.
  //
  // updatedTeamList - the updated team list that the webapp just gave us
  //
  // Returns 'true' if we should run {mergeTeamList}
  shouldMergeTeamList(updatedTeamList) {
    if (this.teamList.length === 0) return true;

    if (!this.haveMergedTeamListOnce) {
      this.haveMergedTeamListOnce = true;
      return true;
    }

    let ourTeams = _.map(this.teamList, (x) => x.team_id).sort();
    let theirTeams = _.map(updatedTeamList, (x) => x.team_id).sort();

    return !(_.isEqual(ourTeams, theirTeams));
  }

  // Private: Handles merging the incoming team list from the SSB with the
  // currently active team list in the renderer. We take the SSB list as the
  // canonical list, but the renderer team list manages the WebViews, so we
  // need to take care to preserve them when merging.
  //
  // This method also handles a special 'secret handshake' from the SSB. When we
  // are logging in from our initial startup context (i.e. from initial install),
  // we get dropped on an empty-content page which solely calls 'didSignIn'. Which
  // means, we can't actually call 'refreshTeams' to get the new info. So, we have
  // to blindly navigate to slack.com, then as soon as it loads, we call 'refreshTeams'
  // in order to get a sane team list. The SSB extension code (team.coffee) is
  // rigged to detect when it's in this scenario and instead send a dummy team list
  // which we recognize here.
  //
  // So, the sequence is:
  // 1. Empty team list, empty updatedTeamList (show signin page)
  // 2. Empty team list, __signin__ dummy (We've been dropped on the empty page,
  //    create a dummy team list which will blindly go to slack.com/ssb)
  // 3. Signin dummy team list, real updatedTeamList (switch to the real list,
  //    migrating over the WebView and WebViewLoaded)
  //
  // Returns a hash:
  //     :toDispose - a {Disposable} which should be disposed after displaying
  //                  the new team
  //     :newTeams - a list of teams newly added. If this isn't empty, we'll
  //                 immediately switch to that new team
  mergeTeamList(updatedTeamList) {
    if (!updatedTeamList) {
      return {newTeams: [], toDispose: rx.Disposable.empty};
    }

    if (this.teamList.length === 0) {
      logger.info("teamList empty, blindly using updatedTeamList");

      this.teamList = updatedTeamList || [];
      return {newTeams: [], toDispose: rx.Disposable.empty};
    }

    // 0. Special-case the sign-out case
    if (this.teamList.length > 0 && _.find(updatedTeamList, (x) => x.team_id === '__signin__')) {
      this.teamList[0].webView.refreshTeams();

      return {newTeams: [], toDispose: rx.Disposable.empty};
    }

    // 1. Fixup any team called '__signin__'
    let signinTeam = _.find(this.teamList, (x) => x.team_id === '__signin__');
    if (signinTeam && updatedTeamList.length > 0) {
      // NB: We need to preserve the already-loaded WebView from the signin stub,
      // so we're going to take the new version, but copy over the webview
      this.teamList = [
        _.extend(updatedTeamList[0], _.pick(signinTeam, 'webView', 'webViewLoaded', 'icons', 'initials'))
      ];
    }

    // 2. Add teams not in the list
    let newTeams = [];
    for (let team of updatedTeamList) {
      if (_.find(this.teamList, (x) => x.team_id === team.team_id)) continue;

      _.extend(team, this.themeCache.fetchThemeInfoAndIconsForTeam(team));

      this.teamList.push(team);
      newTeams.push(team);
    }

    // 3. Update teams that are in the list that have an outstanding Webview
    for (var i = 0; i < this.teamList.length; i++) {
      let item = this.teamList[i];
      let newTeam = _.find(updatedTeamList, (x) => x.team_id === item.team_id);

      if (newTeam) {
        this.teamList[i] = _.extend(newTeam, _.pick(item, 'webView', 'webViewLoaded', 'icons', 'initials'));
        _.extend(this.teamList[i], this.themeCache.fetchThemeInfoAndIconsForTeam(this.teamList[i]));
      } else {
        this.teamList[i].shouldDelete = true;
      }
    }

    let newList = [];
    let toDispose = new rx.CompositeDisposable();

    // 4. Remove items no longer in the list
    for (let team of this.teamList) {
      if (team.shouldDelete) {
        if (team.webView) toDispose.add(team.webView);
      } else {
        newList.push(team);
      }
    }

    this.teamList = newList;
    return {toDispose: toDispose, newTeams: newTeams};
  }

  // Private: Update the icons for a team and notify listeners.
  //
  // args - A hash containing the following keys:
  //        :webViewId - Identifies the webView of the team we want to update
  //        :icons - A hash containing all available team icons along with their sizes
  updateTeamIcons(args) {
    let team = this.teamFromWebViewId(args.webViewId);

    if (!team) {
      logger.warn(`No team found or webView loaded for ${args.webViewId}`);
      return;
    }

    team.icons = args.icons;
    if (!team.icons) {
      args.initials = team.initials;
    }

    this.themeCache.updateIconsAndInitials(team, args.icons, team.initials);
    this.sendToBrowser('teams:update-header', args);

    logger.debug(`Updated icons for team ${team.team_id}`);
  }

  // Private: Update the theme values for the given teams and notify listeners.
  //
  // teams - The teams to update; if null, updates all available teams
  //
  // Returns an Observable Promise indicating completion
  updateTeamThemes(teams=null) {
    teams = teams || this.teamList;

    return rx.Observable.fromArray(teams)
      .flatMap((team) =>
        this.getTheme(team).map((theme) => ({ team, theme })).catch(rx.Observable.empty()))
      .subscribe((themeAndTeam) => {
        logger.debug(`About to update theme for team: ${themeAndTeam.team.team_id}`);

        this.themeCache.updateTheme(themeAndTeam.team, themeAndTeam.theme);
        this.sendToBrowser('teams:update-theme', themeAndTeam.theme);
      });
  }

  // Private: Waits for the given team's webView to load, then retrieves
  // its theme from the SSB and saves it
  //
  // Returns an {Observable} containing the theme and the webViewId it applies to
  getTheme(team) {
    if (!team.webViewLoaded) {
      logger.error(`Team ${team.team_name} missing webViewLoaded`);
      return rx.Observable.empty();
    }
    
    return team.webViewLoaded.flatMap(() =>
      team.webView.getThemeValues()
        .do((theme) => team.theme = theme)
        .map((theme) => ({webViewId: team.webView.webViewId, theme: theme}))
    );
  }

  // Private: Waits for all teams to load, then sends a message to the browser
  // to update the application menu
  //
  // Returns nothing
  updateTeamMenu() {
    return rx.Observable.fromArray(this.teamList)
      .map((team) => team.webViewLoaded)
      .concatAll()
      .take(1)
      .subscribe(() => this.sendToBrowser('teams:update-menu', this.getTrimmedTeamList()));
  }

  // Private: Returns the first n teams, where n = {maxItems}
  getTrimmedTeamList(maxItems=9) {
    let teamList = _.map(this.teamList, (team) => this.prepareTeamForSerialization(team));

    return _.take(teamList, maxItems);
  }

  // Private: Removes properties from the team that should not be serialized
  prepareTeamForSerialization(team) {
    return _.omit(team, 'webView', 'webViewLoaded', 'badgeInfo', 'icons', 'initials');
  }

  // Private: Writes the current team list to local storage
  serializeTeamList() {
    let toSave = _.map(this.teamList, (team) => this.prepareTeamForSerialization(team));

    this.localStorage.setItem("teamList", JSON.stringify(toSave));

    if (_.find(this.teamList, (team) => team.team_id === 'T024BE7LD') && !this.savedTsDevMenu) {
      let userData = remote.require('app').getPath('userData');

      fs.writeFileSync(path.join(userData, '.devmenu'), 'yep');
      this.savedTsDevMenu = true;
    }
  }

  // Private: Filters our stream of IPC messages from embedded webViews into
  // only those with a specific name
  //
  // name - The name of the message we're looking for
  // includeId - (Optional) True to include the webViewId identifying the origin
  //             of this message, false to leave the message argument as is
  //
  // Returns an {Observable} of messages from the SSB matching the name
  ssbMessageNamed(name, includeId=false) {
    return this.ssbMessages
      .where((x) => x.channel === name)
      .map((x) => includeId ? { args: x.args, webViewId: x.webViewId } : x.args);
  }

  // Private: Handle a webView crash by reloading the application windows.
  // Shows a dialog to Tiny Speck users to aid in diagnosis.
  //
  // type - A string describing the type of crash (e.g., 'Renderer', 'GPU')
  // teamUrl - The URL of the team where the crash occurred
  //
  // Returns nothing
  handleWebViewCrash(type, teamUrl) {
    logger.error(`${type} crash occurred in webView for team: ${teamUrl}`);

    // NB: Going to let plugins die rather than trigger a reload.
    if (type.startsWith('Plugin')) return;

    if (teamUrl !== 'https://tinyspeck.slack.com/') {
      this.sendToBrowser('window:reload');
      return;
    }

    const shell = require('shell');
    const app = remote.require('app');
    const dialog = remote.require('dialog');

    let options = {
      title: 'Slack',
      buttons: ['Reload', 'View Logs'],
      message: 'Tiny Speck Only',
      detail: `${type} crashed! What were you doing, anyway?\n\nTell the devs in #ssb-team and bring the log file.`
    };

    dialog.showMessageBox(options, (response) => {
      if (response === 1) {
        let logFile = path.resolve(app.getDataPath(), 'logs');
        shell.openItem(logFile);
      }

      this.sendToBrowser('window:reload');
    });
  }

  // Public: Lets a user override the webView URL for development purposes,
  // e.g., 'https://tinyspeck.dev.slack.com' to point to dev.
  //
  // Returns nothing
  overrideSsbUrl(ssbUrl) {
    for (var v of this.teamList) {
      if (!v || !v.webView) continue;

      v.webView.overrideSsbUrl(ssbUrl);
    }
  }

  // Private: Moves forward or backward 'n' teams in the list
  //
  // offset - the {Number} (positive or negative) of teams to move by
  //
  // Returns nothing
  moveTeamByOffset(offset) {
    if (!this.primaryTeam || this.teamList.length < 2) return;

    let idx = this.indexOfTeamInList(this.primaryTeam);
    idx = (idx + this.teamList.length + offset) % this.teamList.length;

    this.makeTeamPrimary(this.teamList[idx]);
  }

  // Private: Finds the index of a team in the team list, comparing via team_id
  //
  // Returns an index, or null if the team isn't found
  indexOfTeamInList(team) {
    team = team || this.primaryTeam;

    for (var i = 0; i < this.teamList.length; i++) {
      if (this.teamList[i].team_id === team.team_id) return i;
    }

    return null;
  }

  // Private: Returns the initial characters of the first
  // n words of {name}, where n = {maxLength}
  //
  // name - The name to abbreviate
  // maxLength - The maximum number of characters to allow in the result
  //
  // Returns the abbreviated name
  getInitialsOfName(name, maxLength=2) {
    if (!name) return '';

    let initials = '';
    let words = name.split(' ');

    for (var word of words) {
      if (word.length < 1) continue;
      initials += word.substring(0, 1);
    }

    return initials.substring(0, maxLength);
  }

  // Private: Finds the team from the given WebView ID (i.e. from a SSB context)
  //
  // Returns the team whose WebView ID matches, or null
  teamFromWebViewId(webViewId) {
    return _.find(this.teamList, (x) =>
      x.webView && x.webView.webViewId === webViewId);
  }

  // Public: Undoes everything that the class has currently done and cleans up
  // all WebViews
  dispose() {
    logger.info('Disposing TeamsViewController');
    this.attachDisp.dispose();
    this.trashAllTeamWebviews();
  }

  // Private: Burns all of the loaded WebViews
  trashAllTeamWebviews() {
    for (var team of this.teamList) {
      if (team.webView) team.webView.dispose();

      team.webView = null;
      team.webViewLoaded = null;
    }
  }
}

module.exports = TeamsViewController;
