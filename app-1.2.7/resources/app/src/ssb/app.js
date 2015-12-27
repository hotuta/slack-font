const ipc = require('ipc');
const keyboardLayout = require('keyboard-layout');
const AutoLaunch = require('../auto-launch');
const nativeInterop = require('../native-interop');

const globalProcess = window.process;
const logger = require('../browser/logger').init(__filename);
const slackApplication = require('remote').getGlobal('slackApplication');

const betaChannelFeatureFlag = 'feature_winssb_beta_channel';

module.exports =
class AppIntegration {
  // Public: Creates a new instance of {AppIntegration}
  constructor() {
    this.autoLaunch = new AutoLaunch();

    if (this.canAccessLocalStorage()) {
      this.initializePreferences();
    }

    this.listenForModifierKeys();
  }

  // Public: Occurs when the SSB starts loading
  //
  // Returns nothing
  didStartLoading() {
    ipc.sendToHost('didStartLoading');
  }

  // Public: Occurs when the SSB finishes loading
  //
  // Returns nothing
  didFinishLoading() {
    ipc.sendToHost('didFinishLoading');

    this.fixJapaneseFontFallbacks();
    this.checkForBetaReleaseChannel();

    try {
      // NB: Unfortunately, Electron's setImmediate assumes that global.process
      // still exists in Chrome 43, so we have to patch it back in, which is a
      // real drag
      window.process = globalProcess;
      window.winssb.spellCheckingHelper.setupInputEventListener();
    } catch (error) {
      logger.error(`Spellchecking is busted, continuing: ${error.message}\n${error.stack}`);
    }
  }

  // Private: Sets up default values for preferences that do not exist in
  // localStorage.
  //
  // Returns nothing
  initializePreferences() {
    let defaultValues = {
      runFromTray: true,
      launchOnStartup: this.autoLaunch.isEnabled(),
      windowFlashBehavior: 'idle',
      useHwAcceleration: true,
      notifyPosition: {corner: 'bottom_right', display: 'same_as_app'},
      zoomLevel: 0
    };

    for (let key in defaultValues) {
      if (!defaultValues.hasOwnProperty(key) ||
        localStorage.getItem(key) !== null)
        continue;

      this.setPreference({name: key, value: defaultValues[key]}, false);
    }
  }

  // Public: Checks if a preference with the given name is supported
  //
  // name - The name of the preference
  //
  // Returns true if the preference is supported
  hasPreference(name) {
    switch (name) {
    case 'useHwAcceleration':
      return globalProcess.platform === 'linux' ||
        (globalProcess.platform === 'win32' &&
        !nativeInterop.isWindows10OrHigher());
    case 'notifyPosition':
      return globalProcess.platform === 'win32' &&
        !nativeInterop.isWindows10OrHigher();
    case 'windowFlashBehavior':
      return globalProcess.platform === 'win32';
    default:
      return localStorage.getItem(name) !== null;
    }
  }

  // Public: Gets the value of a preference
  //
  // name - The name of the preference
  //
  // Returns the value
  getPreference(name) {
    // NB: For launch on startup, we check the state of the Startup shortcut
    if (name === 'launchOnStartup') {
      return this.autoLaunch.isEnabled();
    } else {
      let value = JSON.parse(localStorage.getItem(name));
      if (value === 'true' || value === 'false') return value === 'true';
      return value;
    }
  }

  // Public: Sets the value of a preference
  //
  // pref - An object containing the name of the preference and its new value
  // signalChange - (Optional) True to propagate this change to the renderer
  //
  // Returns nothing
  setPreference(pref, signalChange=true) {
    // NB: Persist it in this context, otherwise `getPreference` won't work
    localStorage.setItem(pref.name, JSON.stringify(pref.value));

    if (pref.name === 'zoomLevel') {
      window.webFrame.setZoomLevel(pref.value);
    }

    // Forward the change to {PreferencesHandler}, in the renderer context
    if (signalChange) {
      ipc.sendToHost('preferenceChange', pref);
    }
  }

  // Private: Checks for a feature flag indicating if this team is on the beta
  // release channel. If found, cache the value and forward it to the browser
  //
  // Returns nothing
  checkForBetaReleaseChannel() {
    if (!window.TS || !window.TS.boot_data[betaChannelFeatureFlag]) return;

    let useBetaChannel = window.TS.boot_data[betaChannelFeatureFlag];
    let isOnBetaChannel = JSON.parse(localStorage.getItem(betaChannelFeatureFlag));

    // NB: If we're already set up, avoid the ipc traffic
    if (useBetaChannel === isOnBetaChannel) return;

    localStorage.setItem(betaChannelFeatureFlag, useBetaChannel);
    ipc.send('set-release-channel', useBetaChannel ? 'beta' : 'prod');
  }

  // Public: Will reload the entire window. Used as a temporary replacement
  // for `TS.reload` (see https://bugs.tinyspeck.com/9998)
  //
  // Returns nothing
  reload() {
    ipc.send('window:reload');
  }

  // Private: Even touching localStorage in a data URI will throw errors
  canAccessLocalStorage() {
    return window.location.protocol !== 'data:';
  }

  // Public: Called by the webapp to determine whether or not HTML should be
  // rendered in notifications.
  //
  // Returns the state of our `NotificationController` object from the browser
  // process
  canShowHtmlNotifications() {
    // NB: This shouldn't be reaching into objects, but remote.getGlobal isn't
    // returning methods because /shrug
    return slackApplication.notifier.showHtmlNotifications;
  }

  // Public: Modifier keys aren't being propagated to the webapp for some
  // events, so we give them a workaround here.
  //
  // Returns a hash representing the pressed state of any modifier keys, e.g.,
  // `ctrl`, `shift`, `alt`
  getModifierKeys() {
    return this.modifiers;
  }

  listenForModifierKeys() {
    this.modifiers = {
      ctrl: false,
      shift: false,
      alt: false,
      meta: false
    };

    let keyListener = (e) => {
      this.modifiers.ctrl = e.ctrlKey;
      this.modifiers.shift = e.shiftKey;
      this.modifiers.alt = e.altKey;
      this.modifiers.meta = e.metaKey;
    };

    window.addEventListener('keydown', keyListener);
    window.addEventListener('keyup', keyListener);
  }

  // Public: Work around Japanese font fallbacks on Win32
  //
  // Using the default font set on Windows, Slack will render Kanji characters
  // using SimSun and Hiragana/Katakana characters using MS PGothic, despite
  // the latter font having the characters available to render the sentence.
  //
  // This is super distracting since these fonts have different weights, so we
  // rig the default message class to have the immediate fallback of Lato to be
  // MS PGothic, which causes the entire sentence to render in MS PGothic.
  //
  // Returns nothing
  fixJapaneseFontFallbacks() {
    if (globalProcess.platform !== 'win32') return;

    let layouts = keyboardLayout.getInstalledKeyboardLanguages();
    if (layouts.indexOf('ja-JP') < 0) return;

    // Replace the Font styles for these selectors with one that adds Meiryo
    // as a fallback. We don't do this in the webapp because if we did, it would
    // fuck up people reading Chinese text.
    this.fixStyleMatchingAttribute('span', 'class', 'message', ".message");
    this.fixStyleMatchingAttribute('textarea', 'id', 'message-input', "#message-input");
    this.fixStyleMatchingAttribute('span', 'class', 'file_name', ".file_name");
    this.fixStyleMatchingAttribute('span', 'class', 'comment', ".comment");
    this.fixStyleMatchingAttribute('span', 'class', 'modal', ".modal");
    this.fixStyleMatchingAttribute('span', 'id', 'details_tab', "#details_tab");
    this.fixStyleMatchingAttribute('textarea', null, null, "input[type=url], input[type=text], input[type=tel], input[type=number], input[type=email], input[type=password], select, textarea");
    this.fixStyleMatchingAttribute('h4', null, null, "h1, h2, h3, h4");
    this.fixStyleMatchingAttribute('span', 'id', 'end_display_meta', "#msgs_scroller_div #end_display_div #end_display_meta");
    this.fixStyleMatchingAttribute('span', 'id', 'loading_welcome_msg', "#loading_welcome_msg");
    this.fixStyleMatchingAttributeMonospace('span', 'class', 'monospace', '.monospace');
    this.fixStyleMatchingAttributeMonospace('pre', null, null, 'code, pre');
    this.fixStyleMatchingAttributeMonospace('span', "class", "CodeMirror", '.CodeMirror');
  }

  fixStyleMatchingAttribute(tagName, attributeName, attributeValue, selector) {
    let span = document.createElement(tagName);
    if(attributeName)
      span.setAttribute(attributeName, attributeValue);
    document.body.appendChild(span);
    let cssom = window.getComputedStyle(span);
    let fontFamily = "Meiryo, 'MS PGothic', " + cssom.fontFamily;
    document.body.removeChild(span);

    let style = document.createElement('style');
    style.innerText = `${selector} { font-family: ${fontFamily} !important }`;
    document.head.appendChild(style);
  }

  fixStyleMatchingAttributeMonospace(tagName, attributeName, attributeValue, selector) {
    let span = document.createElement(tagName);
    if(attributeName)
      span.setAttribute(attributeName, attributeValue);
    document.body.appendChild(span);
    let cssom = window.getComputedStyle(span);
    let fontFamily = "'MS Gothic', " + cssom.fontFamily;
    document.body.removeChild(span);

    let style = document.createElement('style');
    style.innerText = `${selector} { font-family: ${fontFamily} !important }`;
    document.head.appendChild(style);
  }
};
