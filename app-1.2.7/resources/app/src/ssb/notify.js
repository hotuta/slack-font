const ipc = require('ipc');

module.exports =
class NotificationIntegration {

  // Public: Occurs when the SSB needs to display a notification
  //
  // args - Contains the notification arguments, e.g., title, content
  notify(args) {
    // NB: We need to save the `webViewId` to identify which team this
    // notification belongs to
    args.webViewId = window.webViewId;
    ipc.send('notice:notify', args);
  }
};
