rx = require 'rx'
logger = require('../browser/logger').init(__filename)

module.exports =
class ObservableStorage
  # Public: Constructs a new Observable Storage object.
  #
  # localStorageKey - the key to persist the data under in local storage
  # options - an {Object} containing optional values for testing. Currently:
  #
  #     :initialState - The initial data in the cache (for testing)
  #     :localStorage - The Local Storage implementation to use
  constructor: (localStorageKey, options={}) ->
    @localStorageKey = localStorageKey
    {initialState, @localStorage} = options

    @data = initialState
    @localStorage ?= global.localStorage

    @data ?= @load()
    @data ?= {}
    @disp = rx.Disposable.create => @save()

  # Public: Reloads data from the backing storage. Normally not necessary to
  # call explicitly.
  #
  # Returns Nothing
  load: ->
    json = @localStorage.getItem(@localStorageKey)
    try
      @data = JSON.parse(json)
    catch e
      logger.error("Couldn't load storage for object: #{@localStorageKey}: #{e}")
      @data = {}

  # Public: Saves data to the backing storage. Normally not necessary to
  # call explicitly, as long as the class is Disposed properly
  #
  # Returns Nothing
  save: ->
    try
      logger.debug "Attempting to save key: #{@localStorageKey}"
      @localStorage.setItem(@localStorageKey, JSON.stringify(@data))
    catch e
      logger.error("Couldn't save storage for object: #{@localStorageKey}: #{e}")

  # Public: Clean up the subscriptions taken out by {ObservableStorage}
  #
  # Returns Nothing
  dispose: ->
    @disp.dispose()
