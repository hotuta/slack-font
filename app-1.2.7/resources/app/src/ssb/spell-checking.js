const _ = require('lodash');
const rx = require('rx-dom');
const cld = require('@paulcbetts/cld');

const logger = require('../browser/logger').init(__filename);

const DictionarySync = require('../renderer/dictionary-sync');

// NB: This is to work around tinyspeck/slack-winssb#267, where contractions
// are incorrectly marked as spelling errors. This lets people get away with
// incorrectly spelled contracted words, but it's the best we can do for now.
const contractions = [
  "ain't", "aren't", "can't", "could've", "couldn't", "couldn't've", "didn't", "doesn't", "don't", "hadn't",
  "hadn't've", "hasn't", "haven't", "he'd", "he'd've", "he'll", "he's", "how'd", "how'll", "how's", "I'd",
  "I'd've", "I'll", "I'm", "I've", "isn't", "it'd", "it'd've", "it'll", "it's", "let's", "ma'am", "mightn't",
  "mightn't've", "might've", "mustn't", "must've", "needn't", "not've", "o'clock", "shan't", "she'd", "she'd've",
  "she'll", "she's", "should've", "shouldn't", "shouldn't've", "that'll", "that's", "there'd", "there'd've",
  "there're", "there's", "they'd", "they'd've", "they'll", "they're", "they've", "wasn't", "we'd", "we'd've",
  "we'll", "we're", "we've", "weren't", "what'll", "what're", "what's", "what've", "when's", "where'd",
  "where's", "where've", "who'd", "who'll", "who're", "who's", "who've", "why'll", "why're", "why's", "won't",
  "would've", "wouldn't", "wouldn't've", "y'all", "y'all'd've", "you'd", "you'd've", "you'll", "you're", "you've"
];

const contractionMap = _.reduce(contractions, (acc, word) => {
  acc[word.replace(/'.*/, '')] = true;
  return acc;
}, {});

const fromEventCapture = (element, name) => {
  return rx.Observable.create((subj) => {
    const handler = function(...args) {
      if (args.length > 1) {
        subj.onNext(args);
      } else {
        subj.onNext(args[0] || true);
      }
    };

    element.addEventListener(name, handler, true);
    return rx.Disposable.create(() => element.removeEventListener(name, handler, true));
  });
};

const globalProcess = window.process;

class SpellCheckingHelper {
  constructor() {
    this.currentKeyboardLanguage = new rx.Subject();
    this.overrideKeyboardLanguage = new rx.Subject();
    this.spellCheckResult = new rx.Subject();
    this.disp = rx.Disposable.empty;

    // Here, we want a rolling average of the percentage of correct words in
    // that we are seeing over time. If the user is spelling every word wrong,
    // it's likely that they're not really bad at spelling, but in fact, we are
    // checking in the wrong language.
    let correctlySpelledWordPercentage = this.spellCheckResult
      .bufferWithCount(5, 1)
      .map((xs) => {
        // Figure out the ratio of correct to wrong words
        let correctWords = _.reduce(xs, (acc,x) => (acc += (x ? 1 : 0)), 0);
        return correctWords / xs.length;
      })
      .bufferWithCount(3, 1)
      .map((xs) => _.reduce(xs, (acc, x) => acc + x) / xs.length);

    // When the amount of correct words falls consistently below 10%, we're going
    // to try to derive the language from the content users are currently
    // communicating in.
    let languageForContent = correctlySpelledWordPercentage
      .where((x) => x < 0.1)
      .distinctUntilChanged()
      .selectMany(() => this.languageForRecentMessages().catch(rx.Observable.empty()));

    // NB: This observeOn is intentionally here because setting the spellchecker in a
    // spellchecker callout will result in us segfaulting Chrome
    languageForContent
      .observeOn(rx.Scheduler.timeout)
      .subscribe((x) => {
        let fullLang = this.getFullNameForLanguage(x);

        if (fullLang) {
          logger.info(`Too many spelling errors, falling back to content: ${fullLang}`);
          this.overrideKeyboardLanguage.onNext(fullLang);
        }
      });

    this.spellCheckers = DictionarySync.createDictionariesForInstalledLanguages();
  }

  // Public: Sets up hook where we listen to input boxes to switch the input
  // language when users start typing.
  //
  // Returns nothing.
  setupInputEventListener() {
    if (!document || !document.body) {
      // NB: We sometimes get set up too early before we have a document.body,
      // slow our roll
      console.log("Loaded too early, waiting to set up event listener");
      setTimeout(() => this.setupInputEventListener(), 10);
      return;
    }

    // If we're not in the client, bail out
    if (!window.location.pathname.match(/^.messages/)) {
      console.log("Spell check is disabled, we're not in the client");
      this.disp = rx.Disposable.empty;
      return;
    }

    let inputEvent = fromEventCapture(document.body, 'input').publish().refCount();

    // Here's how this works - basically the idea is, we want a notification
    // for when someone *starts* typing, but only at the beginning of a series
    // of keystrokes, we don't want to hear anything while they're typing, and
    // we don't want to hear about it when they're not typing at all, so we're
    // only calling getCurrentKeyboardLanguage when it makes sense.
    //
    // To do that, we're going to listen on event, then map that to an Observable
    // that returns a value then never ends. But! We're gonna *also* terminate that
    // Observable once the user stops typing (the takeUntil). Then, we're gonna
    // keep doing that forever (effectively waiting for the next inputEvent). The
    // startWith(true) makes sure that we have an initial value on startup, then we
    // map that
    let userStoppedTyping = inputEvent
      .concatMap(() => rx.Observable.return(true).concat(rx.Observable.never()))
      .takeUntil(inputEvent.throttle(750))
      .repeat()
      .startWith(true);

    let currentKeyboardLanguage = userStoppedTyping
      .map(() => this.getCurrentKeyboardLanguage())
      .distinctUntilChanged()
      .merge(this.overrideKeyboardLanguage)
      .distinctUntilChanged();

    this.disp = currentKeyboardLanguage.subscribe((lang) => {
      this.currentKeyboardLanguage.onNext(lang);

      const current = this.spellCheckers[lang];

      // NB: We intentionally dupe this here in the hope we can improve spellcheck
      // perf by a bit on non-English locales since this method will probably be called
      // a lot
      logger.debug(`Setting language to: ${lang}`);

      if (lang.match(/^en/)) {
        window.webFrame.setSpellCheckProvider(lang.replace(/_/, '-'), false, {
          spellCheck: (text) => {
            if (!current) return true;
            if (contractionMap[text.toLocaleLowerCase()]) return true;

            let val = !(current.isMisspelled(text));
            if (text.length > 2) {
              window.setTimeout(() => this.spellCheckResult.onNext(val), 10);
            }

            return val;
          }
        });
      } else {
        window.webFrame.setSpellCheckProvider(lang.replace(/_/, '-'), false, {
          spellCheck: (text) => {
            if (!current) return true;

            let val = !(current.isMisspelled(text));
            if (text.length > 2) {
              window.setTimeout(() => this.spellCheckResult.onNext(val), 10);
            }

            return val;
          }
        });
      }
    });
  }

  // Public: Returns the language that the last five messages in the current
  // channel were written in.
  //
  // Returns an Observable Promise with a two-letter language code ('en')
  languageForRecentMessages() {
    let msgs = this.fetchRecentMessages();

    let text = _.take(msgs, 5).join(' ');
    return this.languageForString(text);
  }

  // Public: Returns the language that an arbitrary string was written in. Note
  // that this method will likely fail if the string is too short.
  //
  // Returns an Observable Promise with a two-letter language code ('en')
  languageForString(text) {
    let ret = new rx.AsyncSubject();

    cld.detect(text, (err, result) => {
      if (err) {
        ret.onError(new Error(err));
        return;
      }

      if (!result.reliable || result.languages.length < 1) {
        ret.onError(new Error("Not enough text to reliably determine the language"));
        return;
      }

      ret.onNext(result.languages[0].code);
      ret.onCompleted();
    });

    return ret;
  }

  // Private: Converts a language code (either two or four-letter) to the
  // nearest language that we have a dictionary for.
  //
  // lang - the language code as a {String}
  //
  // Returns a language code which will be a present key in {spellCheckers},
  // or null if the language can't be found.
  getFullNameForLanguage(lang) {
    let langs = _.keys(this.spellCheckers);
    let exactMatch = _.find(langs, (x) => x === lang);
    if (exactMatch) return exactMatch;

    let langMatch = _.find(langs, (x) => x.substring(0, 2) === lang.substring(0, 2));
    if (langMatch) return langMatch;

    return null;
  }

  // Private: Calls out to the webapp to find all of the messages written by
  // the current user. If that doesn't return any content, we'll fall back to
  // all of the messages in the channel.
  //
  // userIdToFind - the User ID to return messages for (i.e. 'U03A234BF'). If
  //                this isn't given, we'll default to the current user.
  //
  // Returns an {Array} of strings, sorted in order of newness (i.e. index
  // zero is newest).
  fetchRecentMessages(userIdToFind="__current__") {
    let {user_id, msgs} = window.TSSSB.recentMessagesFromCurrentChannel();
    if (userIdToFind === "__current__") userIdToFind = user_id;

    let ret = _.reduce(msgs, (acc,x) => {
      if (!x || !x.text) return acc;
      if (userIdToFind && x.user !== userIdToFind) return acc;

      acc.push(x.text);
      return acc;
    }, []);

    // If we can't find enough messages written by the current user, just
    // return the latest messages
    let textLength = _.reduce(ret, (acc,x) => acc + x.length, 0);
    if (textLength < 10 && userIdToFind) return this.fetchRecentMessages(null);

    return ret;
  }

  // Private: Returns the current keyboard language or a dirty lie if we're
  // on Linux
  getCurrentKeyboardLanguage() {
    if (globalProcess.platform === 'linux') {
      return 'en_US';
    }

    // NB: We intentionally require this in super late so if it fails, we can
    // catch the Error
    return require('keyboard-layout').getCurrentKeyboardLanguage();
  }

  dispose() {
    this.disp.dispose();
  }
}

module.exports = SpellCheckingHelper;
