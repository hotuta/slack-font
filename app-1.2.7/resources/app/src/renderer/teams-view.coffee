rx = require 'rx'
rx = require 'rx-dom'

logger = require('../browser/logger').init(__filename)

WebComponent = require './web-component'
TeamSelector = require './team-selector'

# Public: This class is the visual host for the team selector as well as the
# web views. It basically is just a host for the {SlackWebViewContexts} in
# @teamContent, as well as a host for the {TeamSelector}.
module.exports =
class TeamsView extends WebComponent
  # Public: Creates a new TeamsView
  constructor: (options={}) ->
    super('teams-view.html', options)
    @teamSelector = new TeamSelector()

  attachToDom: (options={}) ->
    ret = super(options).flatMap (disp) =>
      @teamContent = @content.querySelector '.team-content'

      ## NB: We just let the host get removed and it'll clean us up too
      return @teamSelector.attachToDom(docRoot: @content).map -> disp

    ret = ret.publishLast()
    ret.connect()
    ret

  ready: ->
