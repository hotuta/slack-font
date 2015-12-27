rx = require 'rx'
rx = require 'rx-dom'
_ = require 'lodash'
themeHelpers = require '../theme-helpers'
$ = require '../../static/zepto'

WebComponent = require './web-component'
TeamSelector = require './team-selector'

logger = require('../browser/logger').init(__filename)

# Public: This class is the View for each team in the Team Selector list
module.exports =
class TeamSelectorItem extends WebComponent
  _.extend @prototype, themeHelpers

  # Public: Constructs a {TeamSelectorItem}, options are generic
  # {WebComponent} options
  constructor: (options={}) ->
    super('team-selector-item.html', options)
    @clicked = rx.Observable.never()

  # Internal: Called on ready, fixes up the initial state. Mainly all we do here
  # is set up the clicked event
  #
  # Returns nothing
  ready: ->
    @clicked = rx.DOM.fromEvent(@content, 'click')
      .do -> logger.debug "Clicked a team selector item!"

    return null

  # Public: Called to update the actual content of the selector item (i.e.
  # when the order or team icons change)
  #
  # Returns nothing
  updateFromTeam: (team, index) ->
    if team.icons?
      @setIcons team.icons, team.initials, '32px'
    else
      @setInitials team.initials

    @content.id = team.team_id

    shortcut = if process.platform is 'darwin' then "⌘#{index}" else "^#{index}"
    shortcut = '' if index > 9
    $('.team-shortcut', @content).text(shortcut) if index?

  # Public: Sets the selection markers - since all of the transitions we use
  # are animated, we add and remove CSS classes here instead of using Zepto to
  # set values explictly. Explicitly setting properties in the base CSS class will
  # stomp animations, (especially display: none), so be careful to not do that.
  #
  # unreadHighlights - The number to put on the stamp, or '0' to hide the stamp
  #
  # unread - The number of unread messages that aren't highlights. If non-zero, a
  #          small dot is shown next to the team icon
  #
  # isCurrentTeam - A {Boolean} that if true, the selection will be shown as the
  #                 current team.
  #
  # Returns nothing
  setSelectionStatus: (unreadHighlights, unread, isCurrentTeam) ->
    sel = $('.team-item-icon', @content)

    prev = {@unreadHighlights, @hasUnread, @isCurrentTeam}
    now =
      unreadHighlights: unreadHighlights
      hasUnread: unread + unreadHighlights > 0
      isCurrentTeam: isCurrentTeam

    if _.isEqual(prev, now)
      _.extend(this, now)
      return

    unless prev.isCurrentTeam is now.currentTeam
      if now.isCurrentTeam
        sel.addClass('team-item-icon-selected')
      else
        sel.removeClass('team-item-icon-selected')

    unless prev.unreadHighlights is now.unreadHighlights
      sel = $('.team-item-unread-highlights', @content)
      if now.unreadHighlights > 0
        sel.removeClass('team-item-unread-highlights-hidden')
        sel.addClass('team-item-unread-highlights-visible')
        sel.text(unreadHighlights).show()
      else
        sel.removeClass('team-item-unread-highlights-visible')
        sel.addClass('team-item-unread-highlights-hidden')

    sel = $('.team-selected-element', @content)

    unless prev.isCurrentTeam is now.isCurrentTeam
      if now.isCurrentTeam
        sel.removeClass('team-selected-element-unread')
        sel.removeClass('team-selected-element-neither')
        sel.addClass('team-selected-element-selected')

        _.extend(this, now)
        return

    unless prev.hasUnread is now.hasUnread and prev.isCurrentTeam is now.isCurrentTeam
      unless now.isCurrentTeam
        if now.hasUnread
          sel.removeClass('team-selected-element-selected')
          sel.removeClass('team-selected-element-neither')
          sel.addClass('team-selected-element-unread')
        else
          sel.removeClass('team-selected-element-selected')
          sel.removeClass('team-selected-element-unread')
          sel.addClass('team-selected-element-neither')

    _.extend(this, now)
