const rx = require('rx');
const browser = require('./ipc-rx');
const webFrame = require('web-frame');

const AutoLaunch = require('../auto-launch');
const logger = require('../browser/logger').init(__filename);

export default class PreferencesHandler {
  // Public: Creates a new instance of {PreferencesHandler}
  //
  // options - A hash of options containining:
  //
  //           :teamsViewController - the view-controller that created this handler,
  //                                  and contains methods for executing JavaScript
  //
  //           :localStorage - (optional) used for persisting preferences
  constructor(options) {
    this.autoLaunch = new AutoLaunch();
    this.teamsViewController = options.teamsViewController;
    this.localStorage = options.localStorage || window.localStorage;

    this.allPrefs = [
      'runFromTray',
      'launchOnStartup',
      'windowFlashBehavior',
      'useHwAcceleration',
      'notifyPosition',
      'zoomLevel'
    ];

    // Tracks which preference changes we should pass up to the browser
    this.browserBasedPrefs = new Set(this.allPrefs);
    this.browserBasedPrefs.delete('launchOnStartup');
  }

  // Public: Sets up listeners for preferences changes from the SSB
  //
  // Returns a {Disposable} that will undo what this method did
  setup() {
    let disp = new rx.CompositeDisposable();
    
    disp.add(this.teamsViewController.ssbMessageNamed('preferenceChange')
      .flatMap(([pref]) => this.safeSyncPreference(pref))
      .subscribe());
    
    disp.add(browser.listen('preferenceBulkChange')
      .flatMap(([prefsString]) => {
        let prefs = JSON.parse(prefsString);
        let prefsArray = Object.keys(prefs).map((key) => {
          return {name: key, value: prefs[key]};
        });
        return rx.Observable.fromArray(prefsArray);
      })
      .flatMap((pref) => this.safeSyncPreference(pref))
      .subscribe());

    disp.add(this.handleZoomEvents());
    return disp;
  }
  
  // Private: Syncs a preference with error handling.
  async safeSyncPreference(pref) {
    await this.syncPreference(pref).catch((e) => {
      logger.error(`Unable to sync preference: ${e}`);
      return rx.Observable.return(null);
    });
  }

  // Private: Syncs a preference change across all teams and forwards it to the
  // browser process if applicable
  //
  // pref - An object containing the following keys:
  //        :name - The name of the preference that changed
  //        :value - Its new value
  //
  // Returns an awaitable {Promise} indicating completion
  async syncPreference(pref) {
    await this.onPreferenceChanging(pref);
    
    if (this.browserBasedPrefs.has(pref.name)) {
      browser.send(pref.name, pref.value);
    }
    
    this.localStorage.setItem(pref.name, JSON.stringify(pref.value));
    logger.info(`Setting ${pref.name} to ${JSON.stringify(pref.value)}`);
    
    // NB: Passing false as the second argument prevents the SSB from
    // propagating the change up via IPC (which would cause an infinite loop)
    let command = `winssb.app.setPreference(${JSON.stringify(pref)}, false)`;
    
    let syncAllTeams = this.teamsViewController.executeJavaScriptForAllTeams(command);
    await syncAllTeams.toPromise();
  }

  // Public: Returns an {Observable} that, when subscribed, will sync the given
  // team's preferences to match those currently held in `localStorage`
  //
  // team - The team that finished loading
  //
  // Returns an {Observable} indicating completion
  syncPreferencesForTeam(team) {
    return rx.Observable.fromArray(this.allPrefs)
      .where((key) => this.localStorage.getItem(key) !== null)
      .map((key) => {
        let value = JSON.parse(this.localStorage.getItem(key));
        return {name: key, value: value};
      })
      .concatMap((pref) => {
        if (this.browserBasedPrefs.has(pref.name)) {
          browser.send(pref.name, pref.value);
        }
        
        let command = `winssb.app.setPreference(${JSON.stringify(pref)}, false)`;
        return this.teamsViewController.executeJavaScript(command, team);
      })
      .catch((e) => {
        logger.error(`Unable to sync team preferences: ${e}`);
        return rx.Observable.return(null);
      });
  }
  
  // Private: Some preferences require additional handling before the value
  // should be sent to the SSB; do that here
  //
  // pref - An object containing the following keys:
  //        :name - The name of the preference that changed
  //        :value - Its new value
  //
  // Returns an awaitable {Promise}
  async onPreferenceChanging(pref) {
    switch (pref.name) {
    case 'launchOnStartup':
      if (pref.value) {
        await this.autoLaunch.enable();
      } else {
        await this.autoLaunch.disable();
      }
      break;
    case 'zoomLevel':
      webFrame.setZoomLevel(pref.value);
      break;
    }
  }

  // Private: Forward zoom events from the main window to the SSB
  //
  // Returns a {Disposable} that will undo what the method did
  handleZoomEvents() {
    let disp = new rx.CompositeDisposable();

    disp.add(browser.listen('window:actual-size')
      .flatMap(() => this.safeSyncPreference({name: 'zoomLevel', value: 0}))
      .subscribe());

    disp.add(browser.listen('window:zoom-in')
      .flatMap(() => {
        let level = Math.min(5, webFrame.getZoomLevel() + 1);
        return this.safeSyncPreference({name: 'zoomLevel', value: level});
      })
      .subscribe());

    disp.add(browser.listen('window:zoom-out')
      .flatMap(() => {
        let level = Math.max(-5, webFrame.getZoomLevel() - 1);
        return this.safeSyncPreference({name: 'zoomLevel', value: level});
      })
      .subscribe());
      
    disp.add(rx.DOM.fromEvent(document.body, 'keydown', null, true)
      .flatMap((e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.keyCode === 187) {
          e.preventDefault();

          let level = Math.min(5, webFrame.getZoomLevel() + 1);
          return this.safeSyncPreference({name: 'zoomLevel', value: level});
        }
        return rx.Observable.return(null);
      })
      .subscribe());

    return disp;
  }
}
