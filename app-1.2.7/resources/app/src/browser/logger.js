var winston = null;
const path = require('path');
const fs = require('fs');

// Facade over the logging implementation.
// Also adds some additional information to the log (e.g., filename).
class Logger {
  constructor(logApi, filename, remote) {
    this.logApi = logApi;
    this.filename = filename;
    this.remote = remote;
  }

  debug(message) {
    let msg = `[${this.filename}] - ${message}`;
    if (this.remote) console.log(msg);

    this.logApi.debug(msg);
  }

  info(message) {
    let msg = `[${this.filename}] - ${message}`;
    if (this.remote) console.log(msg);

    this.logApi.info(msg);
  }

  warn(message) {
    let msg = `[${this.filename}] - ${message}`;
    if (this.remote) console.log(msg);

    this.logApi.warn(msg);
  }

  error(message) {
    let msg = `[${this.filename}] - ${message}`;
    if (this.remote) console.log(msg);

    this.logApi.error(msg);
  }
}

module.exports = {
  // Expose the logger API through an initialization function.
  // This is used to prepend the source filename and get the correct logger instance.
  init: (sourceFile, slackApplication) => {
    let filename = path.basename(sourceFile);

    let app = slackApplication || global.slackApplication || require('remote').getGlobal('slackApplication');
    winston = require('winston');

    // NB: All of the remoting hurts performance, so in production we'll create
    // one file per process. In devMode (or non-Windows), keep it simple.
    let useSingleLogFile = app.devMode;

    if (process.type !== 'browser' && useSingleLogFile) {
      // Renderer / webview processes remote to the browser's logging instance
      // because it's way easier to debug from
      let logApi = require('remote').getGlobal('logApi');
      return new Logger(logApi, filename, true);
    }

    if (global.logApi) {
      // Winston is already created, reuse it.
      return new Logger(global.logApi, filename, app);
    }

    // First time; create the Winston instance.
    let logApi = new winston.Logger();
    if (process.type === 'browser' && app.devMode) {
      // TODO: We probably need to write an 'nslog' transport
      logApi.add(winston.transports.Console);
    }

    let atomApp = process.type === 'browser' ?
      require('app') :
      require('remote').require('app');

    // %AppData%/Slack/logs on Windows
    // ~/Library/Application Support/Slack/logs on OS X
    // ~/.config/Slack/logs on Linux
    //
    // NB: On early startup, the Data Path might not actually exist; we need to
    // call join here, then create it a few lines later
    let logLocation = path.join(atomApp.getDataPath(), 'logs');

    if (app.devMode) {
      logLocation = path.resolve(__dirname, '..', '..');
    }

    if (app.logFile) {
      logLocation = path.resolve(path.dirname(app.logFile));
    }

    // We might also need to create the Logs sub-directory.
    if (!fs.statSyncNoException(logLocation)){
      try {
        require('mkdirp').sync(logLocation);
      } catch (error) {
        logApi.error(`Unable to create Logs directory: ${error}`);
      }
    }

    if (useSingleLogFile) {
      logApi.add(winston.transports.File, {
        level: 'debug',
        json: false,
        filename: path.join(logLocation, `app.log`),
        colorize: false
      });
    } else {
      logApi.add(winston.transports.File, {
        filename: path.join(logLocation, `slack-winssb-${process.type}-${process.pid}.log`),
        maxSize: 5*1048576,
        maxFiles: 10,
        json: false
      });
    }

    global.logApi = logApi;
    return new Logger(logApi, filename, app);
  }
};
