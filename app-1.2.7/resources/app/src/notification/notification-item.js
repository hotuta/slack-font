const Color = require('color');
const ipc = require('ipc');
const path = require('path');
const _ = require('lodash');
const rx = require('rx-dom');

const WebComponent = require('../renderer/web-component');
const themeHelpersMixin = require('../theme-helpers');

// Save the Aubergine theme in case we run into trouble.
var defaultTheme = {
  "active_item":"#4C9689",
  "active_item_text":"#FFFFFF",
  "active_presence":"#38978D",
  "badge":"#EB4D5C",
  "column_bg":"#4D394B",
  "hover_item":"#3E313C",
  "menu_bg":"#3E313C",
  "text_color":"#FFFFFF"
};

class NotificationItem extends WebComponent {

  // Public: Create a new NotificationItem.
  //
  // options: A hash of overridable options:
  //
  //     :host - The parent {NotificationHost} of this item
  //     :args - Notification arguments, e.g., title, content
  //     :timeoutMs - How long this notification should stick around
  //     :animationEnd - An Observable that can simulate animation end
  constructor(options={}) {
    super('notification-item.html', options);
    _.extend(this, themeHelpersMixin);

    this.host = options.host;
    this.args = options.args;
    this.timeoutMs = options.timeoutMs || 6000;
    this.animationEnd = options.animationEnd;

    this.themeInfo = this.args;
    this.removed = new rx.Subject();
  }

  // Public: Called once the content has been attached to the DOM.
  //
  // Returns nothing
  ready() {
    this.doEntryAnimation();

    // Don't remove anything from the DOM until it
    // has animated out (unless we're in unit tests).
    this.animationEnd = this.animationEnd ||
      rx.DOM.fromEvent(this.content, 'webkitAnimationEnd');

    this.setText(this.args.title, this.args.content);
    this.setTheme(this.args.theme);

    // Use the team icons if they were set, otherwise resort to the team initials.
    if (this.args.icons) {
      this.setIcons(this.args.icons);
    } else {
      this.setInitials(this.args.initials);
    }

    // Handle click events on the notification or its close button.
    rx.DOM.fromEvent(this.content, 'click').subscribe((evt) => {
      if (evt.target.className === 'notif-close-button') {
        ipc.send('notify:flash-end');
      } else {
        ipc.send('notify:click', this.args);
      }

      this.remove();
    });
    
    ipc.send('notify:flash-start');

    // Remove the notification after {timeoutMs},
    // unless the user is mousing over it.
    rx.Observable.merge(
      rx.Observable.return(true),
      rx.DOM.fromEvent(this.content, 'mouseover').map(() => true)
    ).throttle(this.timeoutMs).subscribe(() => this.remove());
  }

  // Public: Starts an exit animation for the notification,
  // and removes it from its parent when the animation completes.
  //
  // Returns an Observable Promise indicating the item has been removed
  remove() {
    if (this.isRemoving) return;

    this.isRemoving = true;
    this.doExitAnimation();

    let ret = this.animationEnd.take(1)
      .do(() => {
        this.dispose();
        this.removed.onNext();
      })
      .publishLast();
    ret.connect();
    return ret;
  }

  // Private: Populates the text fields of our DOM element.
  //
  // Returns nothing
  setText(title, message) {
    this.content.querySelector('.title').innerHTML = title;
    this.content.querySelector('.message').innerHTML = message;
  }

  // Private: Sets the background, border, and text color.
  // Currently the border and text color are inferred from the background.
  //
  // theme - A set of color values, with the following keys:
  // column_bg, menu_bg, active_item, active_item_text, hover_item, text_color, active_presence, badge
  //
  // Returns nothing
  setTheme(theme=defaultTheme) {
    let contentBackground = Color(theme.column_bg);
    let headerBackground = Color(theme.menu_bg);
    let isDarkColor = contentBackground.dark();

    let contentDiv = this.content.querySelector('.notification-content');
    contentDiv.style.backgroundColor = contentBackground.hexString();
    contentDiv.style.borderColor = contentBackground.lighten(0.33).hexString();

    let headerDiv = this.content.querySelector('.header-content');
    headerDiv.style.backgroundColor = headerBackground.hexString();

    // Set the text color and hash image for maximum contrast with the background.
    let textColor = isDarkColor ? '#ffffff' : '#000000';
    let hashColor = isDarkColor ? 'white' : 'black';

    this.content.querySelector('.text-content').style.color = textColor;
    this.content.querySelector('.notif-close-button').style.color = textColor;
    this.content.querySelector('.initials').style.color = Color(textColor).alpha(0.7).rgbaString();

    let hashImage = this.content.querySelector('.hash');
    let hashImagePath = path.resolve(__dirname, '..', '..', 'static', `logo_${hashColor}.png`);

    hashImage.src = hashImagePath;
    hashImage.srcset = `logo_${hashColor}.png 1x,logo_${hashColor}_@2x.png 2x,logo_${hashColor}_@3x.png 3x`;
  }

  // Private: Animates the notification into the list.
  //
  // Returns nothing
  doEntryAnimation() {
    this.content.classList.add('animated', 'pageInRight');
  }

  // Private: Animates the notification out of the list. Note that we don't
  // actually remove it from the DOM until the {animationEnd} event occurs.
  //
  // Returns nothing
  doExitAnimation() {
    this.content.classList.add('animated', 'collapseHeight');
  }
}

module.exports = NotificationItem;
