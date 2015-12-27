ipc = require 'ipc'
fs = require 'fs-plus'
Pathwatcher = require 'pathwatcher'

rx = require 'rx'
_ = require 'lodash'

logger = require('../browser/logger').init(__filename)

# Public: This class works in developer mode to watch all of the source files
# and issue a refresh whenever any of them change
module.exports =
class LiveReload
  # Public: Constructs a new LiveReload object
  #
  # dirs - an {Array} of directory paths to watch
  constructor: (dirs) ->
    @dirs = dirs
    @startupTime = Date.now()

  # Public: Attaches LiveReload to the directories specified in the constructor
  #
  # Returns a {Disposable} that will clean up the path watchers
  attach: ->
    logger.info 'Starting up LiveReload'

    rx.Observable.fromArray(@dirs)
      .flatMap (x) => @getAllFiles(x)
      .flatMap (x) => @pathWatchObservable(x)
      .throttle 250
      .where => Date.now() - @startupTime > 5000
      .take 1
      .subscribe ->
        logger.info "Reloading!"
        ipc.send("window:reload")

  getAllFiles: (root) ->
    rx.Observable.create (subj) ->
      shouldContinue = true

      fs.traverseTree root,
        (x) -> subj.onNext(x),
        (-> shouldContinue),
        -> subj.onCompleted()

      -> shouldContinue = false

  pathWatchObservable: (fileOrFolder) ->
    rx.Observable.create (subj) ->
      try
        watcher = Pathwatcher.watch fileOrFolder, (event, path) ->
          logger.info "Got an event! #{event} on #{path}"
          subj.onNext {event, path}
        ->
          watcher.close()
      catch error
        logger.error "#{error}: #{fileOrFolder}"
