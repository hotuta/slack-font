rx = require 'rx'
_ = require 'lodash'
ipc = require 'ipc'

module.exports =
_.extend {}, ipc,
  listen: (channel) ->
    rx.Observable.create (subj) ->
      listener = (args...) -> subj.onNext(args)

      ipc.on(channel, listener)

      return rx.Disposable.create ->
        ipc.removeListener(channel, listener)
