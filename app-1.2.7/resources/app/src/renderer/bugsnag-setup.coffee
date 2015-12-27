# The API key linked to slack-winssb.
api_key = 'acaff8df67924f677747922423057034'

sanitizeStacks = require '../sanitize-stacks'

nslog = require 'nslog'

module.exports = (shouldSuppressErrors, version) ->
  logger = require('../browser/logger').init(__filename)

  Bugsnag.apiKey = api_key
  Bugsnag.appVersion = version ? global.loadSettings.version
  Bugsnag.releaseStage = if shouldSuppressErrors then 'development' else 'production'
  Bugsnag.projectRoot = 'https://renderer'

  Bugsnag.beforeNotify = (payload) ->
    if shouldSuppressErrors
      nslog("Unhandled Exception: \n")
      nslog(payload.stacktrace + '\n')

    payload.context = sanitizeStacks(payload.context)
    payload.stacktrace = sanitizeStacks(payload.stacktrace)
    payload.file = sanitizeStacks(payload.file)
    delete url

    logger.info "Bugsnag payload: #{JSON.stringify(payload)}"
    return payload
