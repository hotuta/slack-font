rx = require 'rx'
rx = require 'rx-dom'

logger = require('./browser/logger').init(__filename)

# Public: This class provides a better interface over the native offline API
# that is more reliable.
module.exports =
class NetworkStatus
  # Public: Constructs a new NetworkStatus
  #
  # options - (Optional) allows you to inject replacements for the DOM APIs we
  #           use during unit testing. Useful ones include:
  #   :checkNow - an Observable that when signalled, will force a network check.
  #               Use a Subject to fake the check
  #   :onlineEvent - an Observable that signals that we are now Online
  #   :offlineEvent - an Observable that signals that we are now Offline
  #   :isOnline - a {Function} that returns whether we are online (i.e. the
  #               default is to return `navigator.isOnline`)
  constructor: (options={}) ->
    {@checkNow, @onlineEvent, @offlineEvent, @isOnline, @scheduler} = options

    @checkNow ?= rx.Observable.empty()
    @onlineEvent ?= rx.DOM.fromEvent(window, 'online')
    @offlineEvent ?= rx.DOM.fromEvent(window, 'offline')
    @isOnline ?= (-> navigator.onLine)
    @scheduler ?= rx.Scheduler.timeout

  # Public: Returns the current network status as a boolean (true = online)
  currentStatus: -> @_currentStatus

  # Public: Returns the reason if an internet check fails
  #
  # Returns one of:
  #   'offline' - The network is down / DNS doesn't resolve
  #   'slackDown' - The network is up, but the request to Slack failed,
  #                 indicating that the site might be hosed
  reason: -> @_reason

  # Public: Returns whether the *browser* thinks we are online. This isn't
  # generally reliable - if it's 'false', you're definitely offline, but a 'true'
  # value doesn't mean that you're good to go.
  browserIsOnline: -> @isOnline()

  # Public: statusObservable gives you an ongoing update of the current state
  # of the network. Yields 'true' or 'false' as to whether the network is both
  # connected, and functional (i.e. Slack is online)
  #
  # Returns an Observable which keeps yielding values when the network goes
  # online/ offline
  statusObservable: ->
    # The status that the browser reports to us is generally believable if
    # they say we're *offline*, but not super trustworthy when they say we're
    # *online*. We're gonna try to debounce their nonsense a bit, so that code
    # trying to make decisions about connectivity don't have to think about it
    kickoffOnline = if @isOnline() then rx.Observable.return(true) else rx.Observable.empty()
    kickoffOffline = if @isOnline() is false then rx.Observable.return(true) else rx.Observable.empty()

    online = kickoffOnline.concat(@onlineEvent.merge(@checkNow))
      .switchMap (x) => @repeatCheckUntilInternetWorks().startWith(@isOnline())

    offline = kickoffOffline.concat(@offlineEvent)
      .select(-> false)

    rx.Observable.merge(online, offline)
      .throttle(600, @scheduler)
      .distinctUntilChanged()
      .startWith(@isOnline())
      .do (x) => @_currentStatus = x
      .publish()
      .refCount()

  # Private: Checks for an Internet connection via {checkInternetConnection}. If
  # the call succeeds, we quit; if it fails, we keep trying until it succeeds.
  #
  # Returns an Observable which will keep yielding 'false' until the network is
  # connected until it works, then it will yield 'true' and complete.
  repeatCheckUntilInternetWorks: ->
    rx.Observable.timer(0, 2500, @scheduler)
      .selectMany (x) => @checkInternetConnection().catch(rx.Observable.return(false))
      .takeWhile (x) -> x is false
      .concat(rx.Observable.return(true))

  # Private: Makes a single request to Slack's API to verify if the network
  # is up. This method also sets the {reason} variable to give a hint as to why
  # the network might be broken
  #
  # Returns an Observable Promise indicating the network state. Either 'true'
  # if it is up, or onError if the network isn't working.
  checkInternetConnection: ->
    logger.info "Checking network connection to Slack..."

    ret = rx.DOM.post('https://slack.com/api/api.test?error=')
      .selectMany (x) =>
        # NB: DNS failure
        if (x.status is 0)
          @_reason = 'offline'
          return rx.Observable.throw(new Error("Bad Status"))

        if (x.status > 499)
          @_reason = 'slackDown'
          return rx.Observable.throw(new Error("Bad Status")) if (x.status > 399 or x.status is 0)

        result = JSON.parse(x.responseText)
        unless result.ok is true
          @_reason = 'slackDown'
          return rx.Observable.throw(new Error("Bad Response")) unless result.ok is true

        rx.Observable.return(true)
      .publishLast()

    ret.connect()
    ret
