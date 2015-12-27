let rx = require('rx');
let _ = require('lodash');
let ipc = require('ipc');

module.exports =
_.extend({}, ipc, {
  listen: (channel) => {
    return rx.Observable.create((subj) => {
      let listener =
        (event, args) => subj.onNext(args);

      ipc.on(channel, listener);

      return rx.Disposable.create(() =>
        ipc.removeListener(channel, listener));
    });
  }
});
