import rx from 'rx';
import requestRx from '../request-rx';
import connect from 'connect';
import semver from 'semver';
import _ from 'lodash';
import http from 'http';

const logger = require('./logger').init(__filename);

// Public: This class handles updates via Squirrel for Mac (aka the 'auto-updater'
// module in Atom Shell). This class is complicated because we create a fake update
// server for Squirrel to find, so that we can just use S3 for updates.
export default class MacSquirrelUpdater {
  // Public: Constructs the object. Some interesting options are:
  //
  // options - A hash whose keys are:
  //       :version - The version of the running app (i.e. '0.1.0')
  //       :ssbUpdateUrl - The URL or file path to check for updates
  //       :autoUpdater - An instance of the Squirrel updater or a fake
  //       :port - The port to open the update server on
  constructor(options) {
    this.version = options.version;
    this.port = options.port || 10203;
    this.ssbUpdateUrl = options.ssbUpdateUrl || process.env.SLACK_UPDATE_URL || 'http://slack-ssb-updates.s3.amazonaws.com/mac_releases';
    this.autoUpdater = options.autoUpdater || require('auto-updater');
  }

  // Public: Initiates a check for updates
  //
  // Returns an Observable which produces one of:
  //     true - The update worked, we'll run a new version next execution
  //     false - There were no updates
  //     (OnError) - Something went pear-shaped while checking for updates
  checkForUpdates() {
    let releases = `${this.ssbUpdateUrl}/releases.json`;
    logger.info(`Checking for update against ${releases}`);

    // 1. Fetch the update file
    let shouldTryUpdate = requestRx.fetchFileOrUrl(releases)
      .map((x) => JSON.parse(x))
      .flatMap((versionJson) => {
        // The shape of versionJson is doc'd at http://is.gd/27TbWK, with an extra 'version'
        // field that we can use to find the latest version
        if (versionJson.length < 1) {
          return rx.Observable.return(null);
        }

        let newestRemoteUpdate = _.reduce(versionJson, (acc, x) => {
          return (x && x.version && semver.gt(x.version, acc.version)) ? x : acc;
        });

        // 2. Check the version
        if (!newestRemoteUpdate) return rx.Observable.return(null);
        if (!semver.gt(newestRemoteUpdate.version, this.version)) return rx.Observable.return(null);

        return rx.Observable.return(newestRemoteUpdate);
      });

    // 3. Spin up a server which will serve up fake updates
    let updateServer = shouldTryUpdate.flatMap((x) => {
      if (x) return rx.Observable.return(false);

      this.startUpdateServer(_.extend({}, x, { url: `${this.updateServerUrl()}/download` }), x.url);
    });

    // 4. Call autoUpdater, wait for it to finish
    let finished = this.autoUpdaterFinishedEvent(this.autoUpdater);
    return updateServer
      .do(() => {
        this.autoUpdater.setFeedUrl(`${this.updateServerUrl()}/json`);
        this.autoUpdater.checkForUpdates();
      })
      .takeUntil(finished)
      .concat(finished);
  }

  forceUpdateAndRestart(closeApp) {
    // NB: Too lazy to implement this properly
    return this.checkForUpdates()
      .timeout(2 * 1000).catch(rx.Observable.return(false))
      .subscribe(closeApp, closeApp);
  }

  // Private: Gets the *local* server URL that we'll / are using for updates.
  updateServerUrl(){
    return `http://localhost:${this.port}`;
  }

  // Private: Starts an update server that serves out the content that Squirrel
  // expects. Right now this consists of a '/json' endpoint which Squirrel checks
  // to get the download URL to use, and a '/download' endpoint which will serve
  // out the actual data (by proxying it from another source, like a URL or file).
  //
  // jsonToServe - the JSON object to serve on the '/json' endpoint
  // fileOrUrlToServe - The file path or URL to serve on the '/download' endpoint.
  //
  // Returns an Observable that *starts* the server when subscribing, then yields
  // a 'true' to indicate the server is started. When the Subscription is disposed,
  // the server will shut down. This means that it's important to dispose, either
  // implicitly via a `take` / `takeUntil` / etc, or explicitly via `dispose`.
  startUpdateServer(jsonToServe, fileOrUrlToServe) {
    let server = null;

    return rx.Observable.create((subj) => {
      try {
        let app = connect();
        app.use('/download', (req,res) => {
          logger.info(`Serving up download: ${fileOrUrlToServe}`);

          requestRx.streamFileOrUrl(fileOrUrlToServe)
            .subscribe(
              (stream) => stream.pipe(res),
              (ex) => { res.writeHead(500, ex.message); res.end(); });
        });

        app.use('/json', (req,res) => {
          logger.info(`Serving up JSON: ${JSON.stringify(jsonToServe)}`);
          res.end(JSON.stringify(jsonToServe));
        });

        logger.info(`Starting fake update server on port ${this.port}`);

        server = http.createServer(app);
        server.listen(this.port);
        subj.onNext(true);
      } catch (e) {
        logger.warn(`Couldn't start update server: ${e.message}`);
        subj.onError(e);
      }

      return rx.Disposable.create(() => {
        logger.info(`Shutting down fake update server on port ${this.port}`);
        if (server) server.close();
      });
    });
  }

  // Private: Returns an Observable that hooks several Squirrel events and turns
  // them into something that indicates update success.
  //
  // Returns an Observable which yields a single value, one of:
  //     true - Squirrel succeeded and applied an update
  //     false - Squirrel succeeded, but did not apply an update
  //     (OnError) - Squirrel failed while trying to download / apply the update
  autoUpdaterFinishedEvent(autoUpdater) {
    let notAvailable = rx.Node.fromEvent(autoUpdater, 'update-not-available');
    let downloaded = rx.Node.fromEvent(autoUpdater, 'update-downloaded');
    let error = rx.Node.fromEvent(autoUpdater, 'error').flatMap((e) => rx.Observable.throw(e));

    let ret = rx.Observable.merge(notAvailable, downloaded, error)
      .map(() => true)
      .take(1)
      .publishLast();

    ret.connect();
    return ret;
  }
}
