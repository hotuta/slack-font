const ipc = require('ipc');
const _ = require('lodash');
const rx = require('rx-dom');

const logger = require('../browser/logger').init(__filename);

module.exports =
class ContextMenuIntegration {
  // Creates a new instance of {ContextMenuIntegration} and begins
  // listening for context menu events on the window
  //
  // currentLanguage - an Observable that signals when the current language changes
  constructor(currentLanguage) {
    currentLanguage = currentLanguage || rx.Observable.empty();
    this.disp = new rx.CompositeDisposable();

    this.disp.add(rx.DOM.fromEvent(window, 'contextmenu').subscribe((e) => {
      e.preventDefault();
      this.processEvent(e);
    }));

    this.disp.add(currentLanguage.subscribe((lang) => this.currentLanguage = lang));
  }

  // Public: Cleans up anything used by this class
  dispose() {
    this.disp.dispose();
  }

  // Private: Creates a structure holding all of the information necessary
  // to build a context menu and forwards it to the renderer
  //
  // e - The `contextmenu` event args
  //
  // Returns nothing
  processEvent(e) {
    let tagName = e.target.tagName.toLowerCase();
    let className = e.target.className;
    let type = e.target.type;

    let selection = window.getSelection().toString();
    let hasSelectedText = (e.target.textContent && e.target.textContent.length && selection.length > 0);
    let parentLink = this.findParent(e.target, 'a');

    logger.debug(`Show context menu at ${tagName}, with class ${className}, with selected text ${selection} (${this.currentLanguage})`);

    let menuInfo = {
      id: e.target.id,
      x: e.clientX,
      y: e.clientY,
      selection: selection,
      currentLanguage: this.currentLanguage
    };

    // Are we in a `textarea` or `input` field?
    if (tagName === 'textarea' || (tagName === 'input' && type === 'text')) {
      menuInfo.type = 'textInput';
      menuInfo.startIndex = e.target.selectionStart;
      menuInfo.endIndex = e.target.selectionEnd;
    } else if (tagName === 'a' || parentLink) {
      // Is this element or any of its parents an `a`?
      let href = e.target.href || parentLink.href;

      // Beware of empty links
      if (href && href.length) {
        menuInfo.type = 'link';
        menuInfo.href = href;
      }

      // `img` tags are often embedded within links, so set the source here
      let childImg = e.target.getElementsByTagName('img');
      if (childImg.length > 0) {
        menuInfo.src = childImg[0].src;
      }
    } else if (hasSelectedText) {
      // Was this a text element and do we have text selected?
      menuInfo.type = 'text';
    }

    // Check for standalone `img` tags
    if (tagName === 'img') {
      menuInfo.src = e.target.src;
    }

    ipc.sendToHost('context-menu', menuInfo);
  }

  // Private: Searches up the DOM hierarchy or a {parentNode}
  // that matches the given tag
  //
  // el - The starting element
  // tagName - The tag to search for
  // classNames - (Optional) An array of class names to match on
  //
  // Returns the element, if found, or null
  findParent(element, tagName, classNames=[]) {
    tagName = tagName.toLowerCase();

    let predicate = (el) => {
      if (!el.tagName || el.tagName.toLowerCase() !== tagName) {
        return null;
      }

      if (!(classNames && classNames.length)) {
        return el;
      }

      if (_.some(classNames, (className) => className === el.className)) {
        return el;
      }

      return null;
    };

    if (predicate(element)) return element;

    while (element && element.parentNode) {
      element = element.parentNode;
      if (predicate(element)) return element;
    }

    return null;
  }
};
