const rx = require('rx');
const mkdirp = require('mkdirp');
const fs = require('fs');

const _ = require('lodash');
const path = require('path');
const nativeInterop = require('../native-interop');

const KeyboardLayout = require('keyboard-layout');
const {Spellchecker} = require('spellchecker');

const remoteDictionaryUrl = 'http://slack-ssb-updates.s3.amazonaws.com/dictionaries';

const possibleLinuxDictionaryPaths = [
  '/usr/share/hunspell',
  '/usr/share/myspell',
  global.loadSettings.fallbackDictionary
];

let logger = require('../browser/logger').init(__filename);

// NB: Request is gigantibig, don't load it unless we have to
let request = null;

// 1. Create the dictionary directory
// 2. Get the list of installed languages
// 3. Fetch the RELEASES file
// 4. Map installed languages <=> release entries
// 5. For Every Language
//    - If the dictionary exists locally and the size matches, bail
//    - Otherwise, downloadify

// Public: This class handles downloading Hunspell dictionaries and keeping
// them up-to-date (i.e. deleting old ones when we see that they exist but
// don't match the remote versions). We only use this code on Win7, it's a
// no-op on Win8 or above. If you want to test it, set the
// SPELLCHECKER_PREFER_HUNSPELL environment variable to 'true', then run the
// app.
class DictionarySync {
  // Public: Creates a {DictionarySync}
  //
  // languagesToFetch (optional) - an {Array} of language codes to fetch
  // dictionaries for - if not given, we'll look up the list from the user's
  // list of installed keyboards.
  constructor(languagesToFetch=null) {
    this.languagesToFetch = languagesToFetch;

    if (process.platform === 'linux') {
      this.languagesToFetch = [];
      return;
    }

    if (!languagesToFetch) {
      this.languagesToFetch = KeyboardLayout.getInstalledKeyboardLanguages();
    }
  }

  // Public: Determines whether we should use Hunspell (basically == Win7)
  //
  // Returns true if we should use Hunspell
  static shouldUseHunspell() {
    // On Linux? Yep.
    if (process.platform === 'linux') {
      return true;
    }

    // On a Mac? See ya.
    if (process.platform === 'darwin') {
      return false;
    }

    // For Testing - this env var is also used by node-spellchecker
    // to ignore Win8 spellchecker even if it's available
    if (process.env.SPELLCHECKER_PREFER_HUNSPELL) {
      return true;
    }

    let os = nativeInterop.getOSVersion();

    // Magical Crazy > Win10 version?
    if (os.major > 6) return false;

    // Win8 or greater? We use system dictionary API
    if (os.major === 6 && os.minor >= 2) return false;

    return true;
  }

  // Public: Download all languages, but only on operating systems that care
  //
  // Returns an Observable Promise that returns a completion when all the
  // dictionaries finish downloading.
  downloadAllLanguagesIfNeeded() {
    return DictionarySync.shouldUseHunspell() && process.platform !== 'linux' ?
      this.downloadAllLanguages() :
      rx.Observable.return(true);
  }

  // Public: Downloads all of the languages given in languagesToFetch
  //
  // Returns an Observable Promise that returns a completion when all the
  // dictionaries finish downloading.
  downloadAllLanguages() {
    if (!this.remoteDictionaryFetcher) {
      this.remoteDictionaryFetcher = DictionarySync.fetchRemoteDictionaryList()
        .retry(3)
        .do((x) => this.remoteDictionaries = x)
        .publishLast();

      this.remoteDictionaryFetcher.connect();
    }

    return this.remoteDictionaryFetcher
      .flatMap(() => rx.Observable.fromArray(this.languagesToFetch))
      .map((lang) => this.downloadLanguageLocally(lang).retry(3))
      .merge(4)
      .reduce((acc) => acc, true);
  }

  // Public: Downloads a single dictionary locally, exiting early if the Dictionary
  // already exists.
  //
  // Returns an Observable which signals completion.
  downloadLanguageLocally(language) {
    // NB: Work around en-US vs en_US silliness
    language = language.replace(/-/g, '_');

    // Does the dictionary already exist? Does its size match? If so, bail
    // early so that we're not constantly downloading dictionaries
    let canary = path.join(DictionarySync.getDictionaryDirectory(), `${language}.dic`);

    let stat = fs.statSyncNoException(canary);
    if (stat && stat.size === this.remoteDictionaries[language]) {
      return rx.Observable.return(true);
    }

    logger.debug(`Didn't find file ${canary} or ${stat ? stat.size : '(null)'} didn't match ${this.remoteDictionaries[language]}`);
    logger.debug(`${typeof(stat.size)} <=> ${typeof(this.remoteDictionaries[language])}`);

    // Create our dictionary directory if it doesn't exist
    var dictDir = DictionarySync.getDictionaryDirectory();
    mkdirp.sync(dictDir);

    // If we can't find an exact match for a dictionary, let's try to at least
    // find the same language but a different locale, similar to what
    // mapToDictionaryName does.
    if (!this.remoteDictionaries[language]) {
      logger.info(`Exact match for dict ${language} not found, falling back to other locale`);

      let langCode = language.substring(0,2);
      let newLanguage = _.find(
        _.keys(this.remoteDictionaries),
        (dict) => langCode === dict.substring(0,2));

      if (!newLanguage) {
        logger.error(`Language not found: ${language}`);
        return rx.Observable.return(true);
      }

      language = newLanguage;
    }

    // For every language we want to download, we need to grab three files,
    // return that download operation as a completion
    return rx.Observable.fromArray([`${language}.dic`, `${language}.aff`, `hyph_${language}.dic`])
      .flatMap((file) => {
        let target = path.join(dictDir, file);

        return this.downloadUrlToFile(`${remoteDictionaryUrl}/${file}`, target)
          .catch((e) => {
            logger.error(`Failed to download ${file}: ${e.message}`);
            return rx.Observable.empty();
          });
      })
      .reduce((acc) => acc, true);
  }

  // Private: Downloads a URL to a given path. Mostly existing so we can
  // replace it in a test runner.
  //
  // url - the URL to download as a {String}
  // file - the path to download the file to
  //
  // Returns an Observable Promise indicating if the operation was succesful.
  downloadUrlToFile(url, file) {
    logger.debug(`Downloading ${url} => ${file}`);

    request = request || require('../request-rx');
    return request.pipe(url, fs.createWriteStream(file));
  }

  // Public: Downloads the RELEASES file in the dictionaries directory and parses
  // the result
  //
  // Returns an Observable which yields a single value, an Object whose keys are
  // BCP47 language codes and values are file sizes.
  static fetchRemoteDictionaryList() {
    request = request || require('../request-rx');

    // This file is generated by the generate-dictionary-releases.rb script, and
    // has the format:
    //
    // SHA1 of file<TAB>File Name<TAB>File Size
    // Example:
    // fab09cf03dee88461d1be2cf666c09d5d0449693        he_IL.dic       7710550
    return request.get(`${remoteDictionaryUrl}/RELEASES`)
      .map((resp) => {
        return _.reduce(resp.body.split("\n"), (acc, line) => {
          let fields = line.split('\t');
          if (fields.length !== 3) return acc;

          let langName = fields[1].replace(/\.dic$/i, '');
          acc[langName] = parseInt(fields[2]);

          return acc;
        }, {});
      });
  }

  // Public: Creates a list of {Spellchecker} instances corresponding to the
  // list of installed languages. We do this here to handle mapping from actual
  // language to language for which we have a dictionary (if we had to fall back
  // to a different locale).
  //
  // installedLanguages (optional) - an {Array} of language identifiers to return
  // {Spellchecker} instances for.
  //
  // Returns an {Object} where the keys are the languages passed into
  // installedLanguages (or the list of system installed languages), and the values
  // are {Spellchecker} instances.
  static createDictionariesForInstalledLanguages(installedLanguages=null) {
    installedLanguages = installedLanguages || DictionarySync.getInstalledLanguages();

    let dictionaryPath = DictionarySync.getDictionaryDirectory();

    return _.reduce(installedLanguages, (acc, lang) => {
      let fixedLanguage = DictionarySync.mapToDictionaryName(lang);
      logger.debug(`Mapping ${lang} => ${fixedLanguage}`);

      let ret = new Spellchecker();

      if (fixedLanguage && ret.setDictionary(fixedLanguage, dictionaryPath)) {
        acc[lang] = ret;
      } else {
        logger.debug(`Failed to set dictionary: ${lang}`);
      }

      return acc;
    }, {});
  }

  // Private: Determines the actual dictionary to use given the passed in
  // language.
  //
  // Sometimes, we won't have an exact match for a language + locale, (i.e. 'en_ZA'
  // for South Africa), but we could provide 'en_BR' (UK English) which would still
  // be pretty good. This method handles that fallback.
  //
  // Returns the language code that we should use instead of the one passed in.
  static mapToDictionaryName(language) {
    if (!this.dictionaryInfo) {
      this.dictionaryInfo = {
        useHunspell: DictionarySync.shouldUseHunspell(),
        dictionaryDirectory: DictionarySync.getDictionaryDirectory()
      };

      if (fs.statSyncNoException(this.dictionaryInfo.dictionaryDirectory)) {
        let files = fs.readdirSync(this.dictionaryInfo.dictionaryDirectory);

        this.dictionaryInfo.localDictionaries = _.reduce(files, (acc,x) => {
          if (!x.match(/\.dic/i)) return acc;
          if (x.match(/hyph_/i)) return acc;

          // Normalize en_US => en-US
          let lang = x.substring(0, 5).replace(/_/, '-');
          acc[lang] = x;

          // Mark en => en-US
          acc[lang.substring(0,2)] = lang;

          return acc;
        }, {});
      }
    }

    if (!this.dictionaryInfo.useHunspell) return language;

    // If we've got an exact match, use that
    language = language.replace(/_/, '-');
    if (this.dictionaryInfo.localDictionaries[language]) return language;

    let fullLang = this.dictionaryInfo.localDictionaries[language.substring(0,2)];
    if (fullLang) return fullLang;

    return null;
  }

  // Public: Get list of installed languages - usually this is derived by the
  // list of keyboard layouts, but on Linux we'll just run down the Hunspell
  // directory
  static getInstalledLanguages() {
    if (process.platform !== 'linux') {
      return KeyboardLayout.getInstalledKeyboardLanguages();
    }

    let dir = DictionarySync.getDictionaryDirectory();
    return _.reduce(fs.readdirSync(dir), (acc,x) => {
      if (!x.match(/\.dic$/i)) return acc;

      acc.push(x.replace(/\.dic$/, ''));
      return acc;
    }, []);
  }

  // Public: Returns the root local dictionary directory
  //
  // Returns a fully-qualified path to the dictionary directory
  static getDictionaryDirectory() {
    if (process.platform === 'linux') {
      // TODO: Verify on 101230232x distros
      return _.find(possibleLinuxDictionaryPaths, (x) => fs.statSyncNoException(x));
    }

    return path.join(path.dirname(process.execPath), '..', 'dictionaries');
  }
}

module.exports = DictionarySync;
