rx = require 'rx'

browser = require './ipc-rx'
remote = require 'remote'
app = remote.require('app')

logger = require('../browser/logger').init(__filename)

# Public: This class is a proxy class that just sends to tray-handler.coffee
class TrayHandler
  # Public: Sets the tray icon ToolTip if it is visible
  #
  # tip - the Tooltip as a {String}
  #
  # Returns nothing
  setToolTip: (tip) ->
    browser.send 'tray:set-tool-tip', tip

  # Public: Sets the icon visibility / icon type
  #
  # state - A {String}, one of:
  #   'rest' - Tray icon is the normal Slack logo
  #   'hidden' - Tray icon is removed from the tray completely
  #   'unread' - Tray icon shows blue dot for unread messages
  #   'highlight'  - Tray icon shows red dot for highlight messages
  #
  # Returns nothing
  setState: (state) ->
    browser.send 'tray:set-state', state

  # Public: Sets the taskbar overlay connection status
  #
  # state - A {String}, one of:
  #   'online' - Overlay icon is cleared
  #   'offline' - Overlay icon is red and angry
  #   'connecting' - Overlay icon is yellow
  #   'unread' - Overlay icon has a blue dot for unread messages
  #   'highlight' - Overlay icon has a ??? for highlight messages
  #
  # Returns nothing
  setConnectionStatus: (status) ->
    browser.send 'tray:set-connection-status', status

# Public: This is a shim Dock class that we use on non-OSX so that we don't
# have to put null checks everywhere
class FakeDock
  getBadge: ->
  bounce: -> -1
  cancelBounce: ->
  setBadge: ->

# Public: This class manages handling aggregated requests from the webapp (i.e. the
# sum of the unread messages across N teams), and sets the dock / tray icons and
# messages
module.exports =
class BadgeManager
  constructor: ->
    @disp = new rx.SerialDisposable()
    @dock = app.dock or new FakeDock()
    @tray = new TrayHandler()

  # Public: Sets the badge count given the information from summing up all of the
  # teams
  #
  # unreadHighlights - count of messages that mention you or DMs
  # unread - count of unread messages, including ones that don't mention you
  #
  # Returns nothing
  setGlobalBadgeCount: (unreadHighlights, unread, connectionStatus) ->
    logger.debug "setGlobalBadgeCount: #{unreadHighlights}, #{unread}, #{connectionStatus}"

    if unreadHighlights > 0
      @tray.setState('highlight')
    else if unread > 0
      @tray.setState('unread')
    else
      @tray.setState('rest')

    if unreadHighlights and connectionStatus is 'online'
      connectionStatus = 'highlight'
    else if unread and connectionStatus is 'online'
      connectionStatus = 'unread'

    unless @connectionStatus is connectionStatus
      @connectionStatus = connectionStatus
      @tray.setConnectionStatus(connectionStatus)

    if (not unreadHighlights?) or (not unread?)
      @dock.setBadge('')

    if unreadHighlights > 0
      @dock.setBadge(String(unreadHighlights))
      @tray.setToolTip("#{unreadHighlights} unread mention" + (if unreadHighlights > 1 then 's' else ''))
      return

    if unread > 0
      @tray.setToolTip("#{unread} unread message" + (if unread > 1 then 's' else ''))
      @dock.setBadge('•')
      return

    @tray.setToolTip("No unread messages")
    @dock.setBadge('')
