const remote = require('remote');
const clipboard = require ('clipboard');
const shell = require ('shell');
const browser = require ('ipc');
const _ = require('lodash');

const DictionarySync = require('./dictionary-sync');

const Menu = remote.require('menu');
const MenuItem = remote.require('menu-item');
const NativeImage = require('native-image');

let logger = require('../browser/logger').init(__filename);

class ContextMenuBuilder {

  // Creates a new instance of {ContextMenuBuilder} and
  // begins listening for context menu events
  //
  // options - A hash containing the following fields:
  //           :webView - The {SlackWebViewContext} of this context menu
  //           :signal - An {Observable} that fires whenever a context
  //                     menu should be created
  //           :testMode - True if running from unit tests, in this case
  //                       we should prevent opening the menu
  //           :devMode - True if running as a developer, in this case
  //                      we should show the Inspect Element item
  constructor(options) {
    this.webView = options.webView;
    this.signal = options.signal;
    this.testMode = options.testMode;
    this.devMode = options.devMode;
    this.menu = null;

    this.spellCheckers = DictionarySync.createDictionariesForInstalledLanguages();

    this.disp = this.signal.subscribe((args) => {
      this.menu = this.buildMenuForElement(args);

      if (this.menu && !this.testMode)
        this.menu.popup(remote.getCurrentWindow());
    });
  }

  // Public: Disposes anything used by this instance
  //
  // Returns nothing
  dispose() {
    this.menu = null;
    this.disp.dispose();
  }

  // Private: Builds a context menu specific to the given info
  //
  // info - A hash containing a bunch of information about the context menu:
  //        :type - The type of menu to build
  //        :selection - The selected text string
  //        :id - The element ID
  //        :x - The x coordinate of the click location
  //        :y - The y coordinate of the click location
  //        :href - The href for `a` elements
  //        :src - The src for `img` elements
  //
  // Returns the newly created {Menu}
  buildMenuForElement(info) {
    this.info = info;

    logger.debug(`Got context menu event with args: ${JSON.stringify(info)}`);

    switch (info.type) {
    case 'textInput':
      return this.buildMenuForTextInput();
    case 'link':
      return this.buildMenuForLink();
    case 'text':
      return this.buildMenuForText();
    default:
      return this.buildDefaultMenu();
    }
  }

  // Private: Builds a menu applicable to a text input field
  //
  // Returns the {Menu}
  buildMenuForTextInput() {
    let menu = new Menu();

    this.addSpellingItems(menu);
    this.addSearchItems(menu);

    this.addCut(menu);
    this.addCopy(menu);
    this.addPaste(menu);
    this.addInspectElement(menu);

    return menu;
  }

  // Private: Builds a menu applicable to a link element
  //
  // Returns the {Menu}
  buildMenuForLink() {
    let menu = new Menu();

    let copyLink = new MenuItem({
      label: 'Copy Link',
      click: () => clipboard.writeText(this.info.href)
    });

    let openLink = new MenuItem({
      label: 'Open Link',
      click: () => {
        logger.info(`Navigating to: ${this.info.href}`);
        shell.openExternal(this.info.href);
      }
    });

    menu.append(copyLink);
    menu.append(openLink);

    this.addImageItems(menu);
    this.addInspectElement(menu);

    return menu;
  }

  // Private: Builds a menu applicable to a text field
  //
  // Returns the {Menu}
  buildMenuForText() {
    let menu = new Menu();

    this.addSearchItems(menu);
    this.addCopy(menu);
    this.addInspectElement(menu);

    return menu;
  }

  // Private: Builds an empty menu or one with the 'Inspect Element' item
  //
  // Returns the {Menu}
  buildDefaultMenu() {
    // NB: Mac handles empty menus properly, ignoring the event entirely.
    // Windows will render a dummy (empty) item.
    let emptyMenu = process.platform === 'darwin' ? new Menu() : null;
    return this.devMode ? this.addInspectElement(new Menu(), false) : emptyMenu;
  }

  // Private: Checks if the current text selection contains a single misspelled
  // word and if so, adds suggested spellings as individual menu items
  //
  // menu - The menu to add the items to
  //
  // Returns the {Menu}
  addSpellingItems(menu) {
    if (!(this.info.selection && this.info.currentLanguage))
      return menu;

    // Ensure that we have a spell-checker for this language
    let spellChecker = this.spellCheckers[this.info.currentLanguage];
    if (!spellChecker)
      return menu;

    // Ensure that the text selection is a single misspelled word
    let isSingleWord = !this.info.selection.match(/\s/);
    let isMisspelled = spellChecker.isMisspelled(this.info.selection);
    if (!isSingleWord || !isMisspelled)
      return menu;

    // Ensure that we have valid corrections for that word
    let corrections = spellChecker.getCorrectionsForMisspelling(this.info.selection);
    if (!corrections || !corrections.length)
      return menu;

    _.each(corrections, (correction) => {
      let item = new MenuItem({
        label: correction,
        click: () => {
          this.webView.replaceText(correction);
        }
      });
      menu.append(item);
    });
    this.addSeparator(menu);

    // Gate learning words based on OS support. At some point we can manage a
    // custom dictionary for Hunspell, but today is not that day
    if (!DictionarySync.shouldUseHunspell()) {
      let learnWord = new MenuItem({
        label: `Add to Dictionary`,
        click: () => {
          spellChecker.add(this.info.selection);

          // NB: This is a gross fix to invalidate the spelling underline,
          // refer to https://github.com/tinyspeck/slack-winssb/issues/354
          this.webView.replaceText(this.info.selection);
        }
      });
      menu.append(learnWord);
    }

    return menu;
  }

  // Private: Adds search-related menu items, such as "Search with Google"
  //
  // menu - The menu to add the items to
  //
  // Returns the {Menu}
  addSearchItems(menu) {
    if (!this.info.selection)
      return menu;

    let match = this.info.selection.match(/\w/);
    if (!match || match.length === 0)
      return menu;

    let search = new MenuItem({
      label: 'Search with Google',
      click: () => {
        let url = `https://www.google.com/#q=${encodeURIComponent(this.info.selection)}`;
        logger.info(`Searching Google using ${url}`);
        shell.openExternal(url);
      }
    });

    menu.append(search);
    this.addSeparator(menu);
    return menu;
  }

  // Private: Adds "Copy Image" and "Copy Image URL" items when `src` is valid
  //
  // menu - The menu to add the items to
  //
  // Returns the {Menu}
  addImageItems(menu) {
    if (!this.info.src || this.info.src.length === 0)
      return menu;

    this.addSeparator(menu);

    let copyImage = new MenuItem({
      label: 'Copy Image',
      click: () => this.convertImageToBase64(this.info.src,
        (dataURL) => clipboard.writeImage(NativeImage.createFromDataUrl(dataURL)))
    });
    menu.append(copyImage);

    let copyImageUrl = new MenuItem({
      label: 'Copy Image URL',
      click: () => clipboard.writeText(this.info.src)
    });

    menu.append(copyImageUrl);
    return menu;
  }

  // Private: Adds the Cut menu item
  //
  // Returns the {Menu}
  addCut(menu) {
    menu.append(new MenuItem({
      label: 'Cut',
      accelerator: 'CommandOrControl+X',
      click: () => browser.send('core:cut')
    }));

    return menu;
  }

  // Private: Adds the Copy menu item
  //
  // Returns the {Menu}
  addCopy(menu) {
    menu.append(new MenuItem({
      label: 'Copy',
      accelerator: 'CommandOrControl+C',
      click: () => browser.send('core:copy')
    }));

    return menu;
  }

  // Private: Adds the Paste menu item
  //
  // Returns the {Menu}
  addPaste(menu) {
    menu.append(new MenuItem({
      label: 'Paste',
      accelerator: 'CommandOrControl+V',
      click: () => browser.send('core:paste')
    }));

    return menu;
  }

  // Private: Adds a separator item
  //
  // Returns the {Menu}
  addSeparator(menu) {
    menu.append(new MenuItem({type: 'separator'}));
    return menu;
  }

  // Private: Adds the "Inspect Element" menu item
  //
  // Returns the {Menu}
  addInspectElement(menu, needsSeparator=true) {
    if (!this.devMode) return menu;
    if (needsSeparator) this.addSeparator(menu);

    let inspect = new MenuItem({
      label: 'Inspect Element',
      click: () => {
        if (this.webView.wv) {
          this.webView.wv.inspectElement(this.info.x, this.info.y);
        }
      }
    });

    menu.append(inspect);
    return menu;
  }

  // Private: Converts an image to a base-64 encoded string
  //
  // url - The image URL
  // callback - A callback that will be invoked with the result
  // outputFormat - The image format to use, defaults to 'image/png'
  //
  // Returns nothing; provide a callback
  convertImageToBase64(url, callback, outputFormat='image/png') {
    let canvas = document.createElement('CANVAS');
    let ctx = canvas.getContext('2d');
    let img = new Image();
    img.crossOrigin = 'Anonymous';

    img.onload = () => {
      canvas.height = img.height;
      canvas.width = img.width;
      ctx.drawImage(img, 0, 0);

      let dataURL = canvas.toDataURL(outputFormat);
      canvas = null;
      callback(dataURL);
    };

    img.src = url;
  }
}

module.exports = ContextMenuBuilder;
