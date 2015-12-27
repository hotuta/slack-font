path = require 'path'
crypto = require 'crypto'
fs = require 'fs'
ipc = require './ipc-rx'

_ = require 'lodash'
rx = require 'rx'
logger = require('../browser/logger').init(__filename)

# Public: Reporter handles sending metrics and command information to Google
# Analytics.
module.exports =
class Reporter
  constructor: ->
    @reporterStartTime = Date.now()

    @getCachedUserId().subscribe (userId) =>
      ga('set', 'appId', 'slack-winssb')
      ga('set', 'appVersion', @version())
      ga('set', 'userId', userId)
      ga('set', 'forceSSL', true)
      ga('set', 'useBeacon', true)
      ga('send', 'pageview')
      
    @disp = rx.Disposable.create(=>
      @sendEvent 'session', 'ended', Date.now() - @reporterStartTime)

  # Public: Sends an event to GA. An event is a single instance of something
  # happening with an associated optional integer value with it
  #
  # category - Typically the object that was interacted with (e.g. button)
  # action - The type of interaction (e.g. click)
  # label - (Optional) Useful for categorizing events (e.g. nav buttons)
  # value - An optional value that must be a non-negative {Number} (specifically, an int)
  #
  # Returns an {Observable} that signals completion
  sendEvent: (category, action, label, value) ->
    ga('send', 'event', category, action, label, value)

  # Public: Send a performance-related timing event, whose timing is determined
  # by a {Disposable}. The clock starts when you call the method, and stops when
  # you Dispose the return value
  #
  # category - the category of event to bucket the event under.
  # name - the name of the perfomance event to log.
  #
  # Returns a {Disposable} that will log the event when disposed.
  sendTimingDisposable: (category, name) ->
    start = Date.now()

    return rx.Disposable.create =>
      elapsed = Date.now() - start
      @sendTiming(category, name, elapsed)

  # Public: Disposes the reporter and sends an event indicating the session has
  # completed.
  dispose: ->
    @disp.dispose()

  # Public: Sets us up to handle events remoted from the browser process.
  #
  # Returns a {Disposable} which unhooks the events
  handleBrowserEvents: ->
    ret = new rx.CompositeDisposable()

    ret.add ipc.listen('reporter:sendEvent').subscribe (args) =>
      {category, action, label, value} = args[0]
      @sendEvent(category, action, label, value)

    ret.add ipc.listen('reporter:sendTiming').subscribe (args) =>
      {category, name, label, value} = args[0]
      @sendTiming(category, name, value, label)

    ret

  # Private: Sends a performance-related event via an explicit value.
  # category - A string for categorizing all user timing variables into logical
  #            groups (e.g jQuery).
  # name - A string to identify the variable being recorded. (e.g. JavaScript
  #        Load).
  # value - The elapsed time in milliseconds
  # label - (Optional) A string that can be used to add flexibility in visualizing user
  #         timings in the reports. (e.g. Google CDN)
  #
  # Returns an {Observable} that signals completion
  sendTiming: (category, name, value, label) ->
    ga('send', 'timing', category, name, value, label)

  # Private: Determines the app version via the package.json
  #
  # Returns a version {String}
  version: ->
    return @_currentVersion if @_currentVersion?

    verInfo = require('../../package.json').version
    return (@_currentVersion = verInfo)

  # Private: Creates a unique ID that we can correlate users under. We use a
  # combination of MAC address and user ID, but combined in such a way so that
  # it's not identifiable
  #
  # Returns an {Observable} Promise which provides a user ID
  createUserId: ->
    ret = new rx.AsyncSubject()

    callback = (error, macAddress) ->
      username = process.env.USER ? process.env.USERNAME ? 'dunnolol'

      if error?
        ret.onNext require('node-uuid').v4()
      else
        # NB: If we don't include another piece of information, the MAC address
        # could be extracted from this SHA1 simply by generating all SHA1s from
        # every possible MAC address
        ret.onNext crypto.createHash('sha1').update(macAddress+username, 'utf8').digest('hex')

      ret.onCompleted()
    
    try
      require('getmac').getMac callback
    catch error
      callback error
      
    ret

  getCachedUserId: ->
    @_userId ?= @createUserId()
    return @_userId
