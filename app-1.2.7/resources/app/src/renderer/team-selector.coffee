rx = require 'rx'
rx = require 'rx-dom'
$ = require '../../static/zepto'
_ = require 'lodash'
TeamSelectorItem = require './team-selector-item'

logger = require('../browser/logger').init(__filename)

WebComponent = require './web-component'

Color = require 'color'

# Public: This class is the ViewController for the loading screen and associated
# subviews. Its goals are to translate requests to update Teams into updating
# {TeamSelectorItem} instances, to manage the list of teams, as well as marshaling
# clicks from said instances into clicked teams.
module.exports =
class TeamSelector extends WebComponent
  # Public: Creates a new TeamSelector, options are the same as {WebComponent}
  constructor: (options={}) ->
    super('team-selector.html', options)

    @disp = new rx.CompositeDisposable()
    @clicked = new rx.Subject()
    @sorted = new rx.Subject()
    @teamAddClicked = rx.Observable.never()
    @teamSelectorMap = {}
    @teamBadgeInfo = {}
    @currentFullUpdateSub = new rx.SerialDisposable()
    
    if global.loadSettings['title-bar-style']
      link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = './team-selector-yosemite.less'
      document.head.appendChild link
      
      @yosemiteTitleBars = true

  # Public: Sets up the add team click event
  #
  # Returns nothing
  ready: ->
    @teamAddClicked = rx.DOM.fromEvent(@content.querySelector('.team-add-button'), 'click')

  # Public: Clear and recreate the list of teams displayed in the selector.
  # This method is called when the team list itself changes, as well as on
  # startup.
  #
  # teamList - The list of teams to create items for
  # primaryTeam - The team in teamList which is currently active
  #
  # Returns nothing
  updateTeamList: (teamList, primaryTeam) ->
    teamListElement = @content.querySelector('.team-list')
    @teamSelectorMap = {}

    if (teamList.length < 2 and not @yosemiteTitleBars)
      @currentFullUpdateSub.setDisposable rx.Disposable.empty
      @content.style.display = 'none'
    else
      @content.style.display = 'flex'

    loadTeamList = rx.Observable.create (subj) =>
      $('.team-list .team-item').remove()
      index = 0

      # NB: The idea here is, we're gonna roll through the list in-order and add
      # all of the TeamSelectorItems, in order (i.e. not using flatMap because that
      # would run them all at once). We'll then use the subscribe to build a map of
      # Teams => Views. At the end, we'll recompute the Clicked event once we've got
      # all the teams loaded.
      obs = rx.Observable.fromArray(teamList)
        .concatMap (item) ->
          ret = new TeamSelectorItem()
          index++

          thisIndex = index

          rx.Observable.defer ->
            ret.attachToDom(docRoot: teamListElement).map ->
              ret.updateFromTeam(item, thisIndex)
              [item, ret]

      return obs.subscribe(subj)

    @currentFullUpdateSub.setDisposable(loadTeamList.subscribe(
      (kvp) =>
        @teamSelectorMap[kvp[0].team_id] = kvp[1]
        @setSelectionStatus(kvp[0], kvp[0].team_id is primaryTeam.team_id)
      (ex) ->
      =>
        @disp.add @buildClickedEvent()
        @disp.add @buildSortedEvent()))

  # Public: Update the icon, theme information, and initials from the given
  # team. Called when the webapp signals this information has changed.
  #
  # team - the team to update, including the theme information
  # index - (Optional) the index of the team within the list
  #
  # Returns nothing
  updateExistingTeamInList: (team, index) ->
    logger.debug "Updating existing team: #{team.team_id}"
    return unless @teamSelectorMap?

    view = @teamSelectorMap[team.team_id]
    return unless view?

    view.updateFromTeam(team, index)

  # Public: Sets the selection markers, such as the white marker on the left, as
  # well as the red highlight marker
  #
  # team - the team to update, including the badgeInfo information
  #
  # isCurrentTeam - A {Boolean} that if true, the selection will be shown as the
  #                 current team.
  #
  # Returns nothing
  setSelectionStatus: (team, isCurrentTeam) ->
    selItem = @teamSelectorMap[team.team_id]
    return unless selItem?

    @teamBadgeInfo[team.team_id] ?= (team.badgeInfo ? {})
    badgeInfo = team.badgeInfo ? @teamBadgeInfo[team.team_id]
    selItem.setSelectionStatus(badgeInfo.unreadHighlights, badgeInfo.unread, isCurrentTeam)

    if isCurrentTeam
      bgString = team.theme.column_bg if team.theme?
      bgString ?= '#3e313c'

      @content.style.backgroundColor = Color(bgString).darken(0.33).rgbaString()

  # Private: Builds a Clicked event that represents when any one of the current
  # teams are clicked, and the value provided is the team id. This event is multicast
  # to the @clicked subject.
  #
  # Returns a {Disposable} that disconnects the current Observable from the
  # @clicked Subject
  buildClickedEvent: ->
    logger.info "Rebuilding the clicked observable"

    rx.Observable.fromArray(_.keys(@teamSelectorMap))
      .flatMap (teamId) => @teamSelectorMap[teamId].clicked.map(-> teamId)
      .multicast(@clicked)
      .connect()

  # Private: Builds a Sorted event that represents when any one of the current
  # teams are rearranged
  #
  # Returns a {Disposable} that cleans up any subscription used by this method
  buildSortedEvent: ->
    $('.team-list').sortable(
      items: '.team-item'
      placeholder: 'team-item-placeholder'
    )

    # NB: Zepto fires two update events for each drop, so we throttle here to
    # avoid duplication
    rx.DOM.fromEvent(@content, 'sortable:update')
      .throttle(100)
      .subscribe => @rearrangeTeams()

  # Private: Retrieve the `li` items that pertain to each team, in order, and
  # forward their team ID's to listeners via the `sorted` {Observable}
  #
  # Returns nothing
  rearrangeTeams: ->
    teamList = @content.querySelectorAll('.team-item')

    teamList = _.filter teamList, (teamItem) -> teamItem.id
    sortedIds = _.map teamList, (teamItem) -> teamItem.id

    @sorted.onNext(sortedIds)

  # Public: Cleans up our events
  #
  # Returns nothing
  dispose: ->
    super()
    @disp.dispose()
