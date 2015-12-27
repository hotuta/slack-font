_ = require 'lodash'
rx = require 'rx'

ObservableStorage = require './observable-storage'
logger = require('../browser/logger').init(__filename)

# Public: This class extends {ObservableStorage} to handle saving and loading
# theme data so that we can have a pretty good guess even on startup what the
# theme should be. It also dedupes setting the theme so that UI elements aren't
# constantly reloading themselves
module.exports =
class ThemeCache extends ObservableStorage
  # Public: Constructs a new theme cache. Some interesting options:
  #
  # :initialState - The initial data in the cache (for testing)
  # :localStorage - The Local Storage implementation to use
  constructor: (options={}) ->
    super('theme-cache', options)

    @persist = new rx.Subject()
    @iconsChanged = new rx.Subject()
    @themeChanged = new rx.Subject()
    @themeDisp = @persist.throttle(800).subscribe => @save()

    @data.themeInfo ?= {}

  # Public: Update the saved theme information. If the theme is changed, we'll
  # fire a notification to {themeChanged}
  #
  # team - The updated team from @teamList
  # themeInfo - The theme information provided by the webapp
  #
  # Returns Nothing
  updateTheme: (team, themeInfo) ->
    oldThemeJson = JSON.stringify(@data.themeInfo[team.team_id] ? {definitely: '__not_this_'})

    @data.themeInfo[team.team_id] = _.extend(@data.themeInfo[team.team_id] ? {}, themeInfo)
    @persist.onNext true

    @themeChanged.onNext(team.team_id) unless oldThemeJson is JSON.stringify(@data.themeInfo[team.team_id])

  # Public: Update the saved icon and initials information. If it has changed,
  # we'll fire a notification to {iconsChanged}
  #
  # team - The updated team from @teamList
  # iconInfo - The icon information provided by the webapp
  # initials - The fallback initials calculated by {TeamsViewController}
  #
  # Returns Nothing
  updateIconsAndInitials: (team, iconInfo, initials) ->
    @data.themeInfo ?= {}
    @data.themeInfo[team.team_id] ?= {}

    oldIconJson = JSON.stringify(@data.themeInfo[team.team_id].icons ? {definitely: '__not_this_'})

    @data.themeInfo[team.team_id].icons = _.extend(@data.themeInfo[team.team_id].icons ? {}, iconInfo)
    @data.themeInfo[team.team_id].initials = initials
    @persist.onNext true

    return if oldIconJson is JSON.stringify(@data.themeInfo[team.team_id].icons)

    logger.debug "Icons are different, sending change notification"
    @iconsChanged.onNext(team.team_id)

  # Public: Returns a hash that represents the current theme info for the current
  # team, suitable for bolting on via _.extend
  #
  # Returns the theme data as an Object (i.e. 'icons', 'initials', etc), or an empty
  # Object if the team isn't found
  fetchThemeInfoAndIconsForTeam: (team) ->
    themeData = @data.themeInfo[team.team_id]
    return themeData ? {}

  # Public: Clean up the subscriptions taken out by {ThemeCache}
  #
  # Returns Nothing
  dispose: ->
    @themeDisp.dispose()
    super()
