const rx = require('rx-dom');
const _ = require('lodash');
const browser = require('../renderer/ipc-rx');
const webFrame = require('web-frame');

const WebComponent = require('../renderer/web-component');
const NotificationItem = require('./notification-item');
const ObservableStorage = require('../renderer/observable-storage');

// Public: Hosts notification items in a list element.
// Utilizes {WebComponent} for loading its HTML.
class NotificationHost extends WebComponent {

  // Public: Create a new NotificationHost.
  //
  // options: A hash of overridable options:
  //
  //     :maxCount - The maximum number of notifications to add before we start
  //                 removing them
  //
  //     :idleTimeoutMs - How long the window should remain visible when there
  //                      are no notifications to display
  //
  //     :screenPosition - Specifies where on-screen notifications will appear,
  //                       contains keys `corner` and `display`
  constructor(options={}) {
    super('notification-host.html', options);
    this.maxCount = options.maxCount;
    this.idleTimeoutMs = options.idleTimeoutMs || 1000;
    this.screenPosition = options.screenPosition ||
      {corner: 'bottom_right', display: 'same_as_app'};
    this.storage = new ObservableStorage('notification-themes');

    this.active = [];
    this.themes = {};
    this.icons = {};
    this.initials = {};

    if (this.storage.data.themes) {
      _.extend(this, this.storage.data);
    }
  }

  // Public: Called once the content has been attached to the DOM.
  ready() {
    this.countObservable = new rx.Subject();
    this.setStackDirection();

    // Send a message if our window has been empty for the idle duration.
    this.isIdle = this.countObservable
      .throttle(this.idleTimeoutMs)
      .where((x) => x === 0);

    this.isIdle.subscribe(() => browser.send('notify:idle'));

    browser.listen('notify:show').subscribe(([item]) => {
      this.tryAddItem(item);
    });

    browser.listen('zoomLevel').subscribe(([zoomLevel]) => {
      webFrame.setZoomLevel(zoomLevel);
    });

    browser.listen('notifyPosition').subscribe(([screenPosition]) => {
      this.screenPosition = screenPosition;
      this.setStackDirection();
    });

    // Occurs when the user changes their sidebar theme.
    browser.listen('teams:update-theme').subscribe(([{webViewId, theme}]) => {
      this.updateTheme(webViewId, theme);
    });

    // Occurs when the user changes their team icon, or when a team finishes loading.
    browser.listen('teams:update-header').subscribe(([{webViewId, icons, initials}]) => {
      this.updateIcons(webViewId, icons);
      this.updateInitials(webViewId, initials);
    });

    // Signal to the {NotificationController} that we're ready.
    browser.send('notify:ready');
  }

  // Public: Only allow `maxCount` notifications at a time.
  // If we're at max count, defer a while.
  //
  // args - Contains data about the notification.
  tryAddItem(args) {
    if (this.active.length < this.maxCount) {
      this.addItem(args);
    } else {
      rx.Scheduler.timeout.scheduleWithRelative(250, () => this.tryAddItem(args));
    }
  }

  // Public: Saves the team information
  save() {
    this.storage.data = { themes: this.themes, icons: this.icons, initials: this.initials };
    this.storage.save();
  }

  // Public: Creates a new notification item and adds it to our list.
  // We specify the host content as the parent element.
  //
  // args - Contains data about the notification,
  //        e.g., channel, title, content, etc.
  //
  // Returns an Observable Promise that indicates the item has loaded.
  addItem(args) {
    var options = {
      host: this,
      docRoot: this.content,
      args: _.extend(args, {
        theme: this.themes[args.webViewId],
        icons: this.icons[args.webViewId],
        initials: this.initials[args.webViewId]
      })
    };

    var item = new NotificationItem(options);

    // Track active items in case any of their display properties change.
    this.active.push(item);
    this.countObservable.onNext(this.active.length);

    item.removed.subscribe(() => {
      var index = this.active.indexOf(item);
      this.active.splice(index, 1);
      this.countObservable.onNext(this.active.length);
    });

    var ret = item.attachToDom().publishLast();
    ret.connect();
    return ret;
  }

  // Private: Updates the flex-direction for this host, which determines how
  // notifications will stack.
  setStackDirection() {
    let stackFromTop = this.screenPosition.corner &&
      this.screenPosition.corner.indexOf('top') !== -1;

    this.content.style.flexDirection = stackFromTop ?
      'column' :
      'column-reverse';
  }

  // Private: Save the new theme and update any active notifications.
  //
  // webViewId - Identifies the webView being changed
  // theme - The new theme to apply
  updateTheme(webViewId, theme) {
    if (!theme || !theme.column_bg) return;

    this.themes[webViewId] = theme;
    this.forEachByWebView(webViewId, (item) => item.setTheme(theme));
  }

  // Private: Save the new icons and update any active notifications.
  //
  // webViewId - Identifies the webView being changed
  // icons - A hash containing all available team icons along with their sizes
  updateIcons(webViewId, icons) {
    if (!icons) return;

    this.icons[webViewId] = icons;
    this.forEachByWebView(webViewId, (item) => item.setIcons(icons));
  }

  // Private: Save the new initials and update any active notifications.
  //
  // webViewId - Identifies the webView being changed
  // initials - The team initials, shown only when the icon is empty
  updateInitials(webViewId, initials) {
    if (!initials) return;

    this.initials[webViewId] = initials;
    this.forEachByWebView(webViewId, (item) => item.setInitials(initials));
  }

  // Private: Takes some action on the notifications created by the given webView.
  //
  // Returns nothing
  forEachByWebView(webViewId, action) {
    for (var item of this.active) {
      if (item.args.webViewId === webViewId) {
        action(item);
      }
    }
  }
}

module.exports = NotificationHost;
