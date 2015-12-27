const fs = require('fs');
const ipc = require('ipc');
const rx = require('rx-dom');
const _ = require('lodash');
const path = require('path');
const shell = require('shell');
const mkdirp = require('mkdirp');
const {p} = require('../get-path');
const sanitize = require('sanitize-filename');
const contentDisposition = require('content-disposition');
import getKnownFolder from '../csx/known-folders';

const XmlHttpRequestRx = require('../xhr-rx');
const ObservableStorage = require('./observable-storage');

const logger = require('../browser/logger').init(__filename);

module.exports =
class DownloadManager {
  // Public: Creates a new instance of {DownloadManager}. This class intercepts
  // download-related messages from the SSB and initiates, cancels, and reports
  // progress for the actual HTTP requests.
  //
  // options - a hash containing the following keys:
  //
  //           :webView - The webView that created this manager, and can be
  //                      used for evaluating JavaScript
  //
  //           :requestFactory - A method used to create the request object,
  //                             overridable for unit testing purposes
  //
  //           :storage - Used for persisting the download metadata across
  //                      sessions
  //
  //           :downloadsDirectory - The path where downloads will be stored
  constructor(options={}) {
    this.webView = options.webView;
    this.requestFactory = options.requestFactory || (() => new XmlHttpRequestRx());
    this.storage = options.storage || new ObservableStorage('download-manager');
    this.downloadsByToken = {};
    
    // NB: Restore download metadata that was previously saved
    if (this.storage.data.downloadsByToken) {
      _.extend(this, this.storage.data);
    }

    this.webView.getSingleFinishedLoadObservable().subscribe(() => {
      let downloadDir = options.downloadsDirectory || process.platform !== 'win32' ?
        options.downloadsDirectory :
        getKnownFolder('Downloads');
  
      this.initializeDownloadsDirectory(downloadDir);
      
      // Once the webView is ready, sync the SSB metadata with what we just
      // retrieved from `localStorage`
      this.syncMetadata(this.downloadsByToken);
      this.retryFailedDownloads();
    });
  }

  // Private: Sets up the directory where downloads will be stored. We can't
  // completely rely on `Users\<User>\Downloads` existing, so we may need to
  // create it or (gods forbid) use a temp directory.
  //
  // directoryOverride - Used to override the download directory for testing
  initializeDownloadsDirectory(directoryOverride) {
    switch (process.platform) {
    case 'win32':
    case 'darwin':
      this.downloadsDirectory = directoryOverride || p`${'HOME'}/Downloads`;
      break;
    case 'linux':
      this.downloadsDirectory = directoryOverride ||
        process.env.XDG_DOWNLOAD_DIR ||
        p`${'HOME'}/Downloads`;
      break;
    }

    if (!fs.statSyncNoException(this.downloadsDirectory)) {
      logger.warn(`No download directory at ${this.downloadsDirectory}, creating one`);
      try {
        mkdirp.sync(this.downloadsDirectory);
      } catch (err) {
        let message = `Unable to create download directory: ${err.stack || err}`;
        logger.error(message);

        // NB: Fallback to the Desktop if possible, otherwise use a temp folder
        let fallbackDirectory = p`${'userDesktop'}`;
        
        try {
          mkdirp.sync(fallbackDirectory);
        } catch (e) {
          fallbackDirectory = p`${'TEMP'}`;
        }
        
        this.downloadsDirectory = fallbackDirectory;
        logger.warn(`Falling back to ${fallbackDirectory}`);
      }
    }
  }

  // Public: Starts a download of the resource at `url`, which is thereafter
  // tracked using the `token`
  //
  // url - The URL of the resource
  // token - A token with which this download can be managed
  async startDownload(url, token) {
    if (!url || !token) {
      logger.error(`Bad arguments passed to startDownload: ${url}, ${token}`);
      return;
    }

    let filePath = await this.getUniqueFileForUrl(url);
    this.onDestinationChosen(token, filePath);

    let metadata = {
      href: url,
      token: token,
      state: 'in_progress',
      progress: 0,
      'file_path': filePath,
      'start_ts': Date.now(),
      'file_exists': false
    };

    this.downloadsByToken[token] = metadata;
    this.save();

    let request = metadata.request = this.requestFactory();
    let observableForRequest = request.get(url);

    observableForRequest
      .takeWhile((x) => x.progress)
      .subscribe((x) => this.onDownloadProgress(token, x.progress),
        (err) => this.onDownloadErrorOrCanceled(token, err));

    // NB: The last request event will be the complete response; map it into a
    // byte array and write it to a local file. Once the file exists, reveal it
    // using the `shell` module.
    observableForRequest
      .last()
      .map((x) => new Buffer(new Uint8Array(x.response)))
      .flatMap((buf) => this.writeBufferToFile(buf, filePath))
      .subscribe(() => this.onDownloadComplete(token),
        (err) => logger.debug(`Download ${err.reason}, no action required`));
  }

  // Public: Cancels the download with the given token
  //
  // token - A download token
  cancelDownload(token) {
    let metadata = this.downloadsByToken[token] || {};

    if (metadata.state === 'in_progress') {
      if (metadata.request) {
        metadata.request.cancel();
      }

      metadata.state = 'canceled';
      this.save();
    } else {
      logger.info(`Cannot cancel a download that is ${metadata.state}`);
    }
  }

  // Public: Attempts to restart a download that failed or was canceled
  //
  // token - A download token
  async retryDownload(token) {
    let metadata = this.downloadsByToken[token] || {};

    if (metadata.state === 'in_progress' || metadata.state === 'completed') {
      logger.info(`Cannot retry a download that is ${metadata.state}`);
    } else {
      await this.startDownload(metadata.href, token);
    }
  }

  // Public: Trims the given tokens from our download history
  //
  // tokens - An array of download tokens
  pruneDownloads(tokens) {
    for (let token of tokens) {
      delete this.downloadsByToken[token];
    }
    this.save();
  }

  // Public: Reveals the download with the given token in the file system
  //
  // token - A download token
  revealDownload(token) {
    let metadata = this.downloadsByToken[token];
    if (metadata && fs.statSyncNoException(metadata.file_path)) {
      shell.showItemInFolder(metadata.file_path);
    }
  }

  // Public: Saves the download metadata to {ObservableStorage}
  save() {
    // NB: Create a copy of the download metadata dictionary, with the
    // {XMLHttpRequest} removed from each item
    let serializable = _.extend({}, this.downloadsByToken);
    for (let token of _.keys(serializable)) {
      let metadata = serializable[token];
      serializable[token] = _.omit(metadata, 'request');
    }

    this.storage.data = { downloadsByToken: serializable };
    this.storage.save();

    this.syncMetadata(serializable);
  }

  // Private: Persists the download metadata in the SSB `localStorage` context
  // for synchronous access
  //
  // metadata - The download metadata
  syncMetadata(metadata) {
    let jsonMetadata = JSON.stringify(metadata).replace(/\\/g, '\\\\');
    let command = `window.winssb.downloads.syncMetadata('${btoa(encodeURIComponent(jsonMetadata))}')`;

    this.webView.executeJavaScript(command);
  }

  // Private: Restarts any downloads that failed
  retryFailedDownloads() {
    for (let token of _.keys(this.downloadsByToken)) {
      let state = this.downloadsByToken[token].state;
      if (state === 'failed') {
        this.retryDownload(token);
      }
    }
  }

  // Private: Occurs when a unique filename has been chosen for this download;
  // we should create the file now to reserve it
  //
  // token - A download token
  // filePath - The full path to the file
  onDestinationChosen(token, filePath) {
    let command = `window.winssb.downloads.downloadWithTokenDidSelectFilepath('${token}', '${btoa(encodeURIComponent(filePath))}')`;
    this.webView.executeJavaScript(command);

    // NB: Create the file to reserve it, as it could take some time for the
    // download to finish and XHR doesn't support streaming to a file. This
    // also gives us a chance to update the SSB.
    try {
      fs.closeSync(fs.openSync(filePath, 'a'));
    } catch (err) {
      logger.error(`Unable to reserve file: ${filePath}`);
    }

    command = `TSSSB.downloadWithTokenDidCreateDestinationFile('${token}')`;
    this.webView.executeJavaScript(command);

    logger.info(`Destination chosen for download: ${filePath}`);
  }

  // Private: Occurs when the download progresses, in our case this corresponds
  // to the {XMLHttpRequest} `progress` event
  //
  // token - A download token
  // progress - Download progress, a value from 0.0 - 1.0, or -1 if the
  //            progress is indeterminate
  onDownloadProgress(token, progress) {
    let metadata = this.downloadsByToken[token];
    metadata.progress = progress;

    let command = `TSSSB.downloadWithTokenProgress('${token}', ${progress})`;
    this.webView.executeJavaScript(command);

    if (process.platform !== 'darwin') {
      ipc.send('window:progress', this.getTaskbarProgress());
    }

    logger.info(`Downloading item from ${metadata.href}: ${progress}`);
  }

  // Private: Occurs when the download has finished and its buffer has been
  // written to the file system
  //
  // token - A download token
  onDownloadComplete(token) {
    let metadata = this.downloadsByToken[token];
    metadata.state = 'completed';
    metadata.end_ts = Date.now();
    metadata.file_exists = true;

    let command = `TSSSB.downloadWithTokenDidFinish('${token}')`;
    this.webView.executeJavaScript(command);
    this.save();

    if (process.platform !== 'darwin' &&
      this.getInProgressDownloads().length === 0) {
      ipc.send('window:progress', -1);
    }

    logger.info(`Download complete, file saved at: ${metadata.file_path}`);
  }

  // Private: Occurs when the download encounters an error or was canceled by
  // the user. We only report failures to the SSB, and we must delete the
  // destination file that we created when the download was initiated.
  //
  // token - A download token
  // error - An error object that contains the keys `reason`, which is either
  //         'failed' or 'canceled', and `status`, which will return the HTTP
  //         status of the request in the case that it failed
  onDownloadErrorOrCanceled(token, error) {
    let metadata = this.downloadsByToken[token];
    metadata.state = error.reason;
    this.save();

    if (error.reason === 'failed') {
      metadata.http_status = error.status;

      let command = `TSSSB.downloadWithTokenDidFailWithReasonAndCode('${token}', '${error.reason}', ${error.status})`;
      this.webView.executeJavaScript(command);
    }

    fs.unlinkSync(metadata.file_path);
    logger.info(`Download ${error.reason}, file removed`);
  }

  // Private: Creates a unique filename for the URL using the
  // Content-Disposition header. This will append (1), (2), (n)... tags to the
  // the filename as needed, if the file already exists.
  //
  // url - The URL where the resource is located
  //
  // Returns the complete file path
  async getUniqueFileForUrl(url) {
    if (!fs.statSyncNoException(this.downloadsDirectory)) {
      // The user removed the download directory while the app was running?
      this.initializeDownloadsDirectory();
    }

    // NB: Use the filename field from the Content-Disposition header, if it
    // exists. Otherwise we'll put one together using the end of the URL.
    let fileName = sanitize(url.split('/').pop());
    try {
      let header = await XmlHttpRequestRx.getResponseHeader(url, 'Content-Disposition');
      let fields = contentDisposition.parse(header);

      if (fields.parameters && fields.parameters.filename) {
        fileName = sanitize(fields.parameters.filename);
      }
    } catch (status) {
      logger.warn(`Unable to retrieve Content-Disposition from ${url}: ${status}`);
    }

    let extension = path.extname(fileName);
    let baseName = path.basename(fileName, extension);
    let filePath = path.join(this.downloadsDirectory, fileName);
    let counter = 1;

    // Keep incrementing the counter until we get a unique filename.
    while (fs.statSyncNoException(filePath)) {
      filePath = path.join(this.downloadsDirectory, `${baseName} (${counter++})${extension}`);
    }

    return filePath;
  }

  // Private: Writes the provided buffer to a file
  //
  // buffer - The {Buffer} being written
  // filePath - The file to write to
  //
  // Returns an {Observable} representing completion
  writeBufferToFile(buffer, filePath) {
    // NB: This is subtle, but the OS will generate a preview based on the
    // empty placeholder file that we created when the download was initiated.
    // So remove the placeholder before writing the final result.
    fs.unlinkSync(filePath);

    return rx.Observable.create((subj) =>
      fs.writeFile(filePath, buffer, (err) => {
        if (err) {
          subj.onError(err);
        } else {
          subj.onNext(filePath);
          subj.onCompleted();
        }
      }));
  }

  // Private: Returns an array of downloads currently in progress.
  getInProgressDownloads() {
    let allMetadata = _.values(this.downloadsByToken);
    return _.filter(allMetadata, (m) => m.state === 'in_progress');
  }

  // Private: Returns a progress value for the taskbar icon. If there are
  // multiple downloads in progress, we'll use the maximum value.
  //
  // Returns a value from 0.0 - 1.0, or 2 if the progress is indeterminate
  getTaskbarProgress() {
    let progressValues = _.map(this.getInProgressDownloads(), (m) => m.progress);
    let maxProgress = _.max(progressValues);

    // NB: Webapp uses -1 to indicate indeterminate progress, but Electron
    // uses any value > 1 (so we'll send them 2)
    if (maxProgress === -1) return 2;
    return maxProgress;
  }
};
