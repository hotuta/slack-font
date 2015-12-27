const _ = require('lodash');
const NotificationHost = require('./notification-host');

let logger = require('../browser/logger').init(__filename);

var options = _.pick(global.loadSettings, 'maxCount', 'screenPosition');

var host = global.notificationHost = new NotificationHost(options);

host.attachToDom().subscribe(() =>
  logger.info(`NotificationHost loaded with options: ${JSON.stringify(options)}`));

window.onbeforeunload = () => {
  logger.debug("Saving off the theme info before we die!");
  host.save();
  return true;
};
