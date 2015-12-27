import _ from 'lodash';
import runScript from '../edge-loader';
import nativeInterop from '../native-interop';

const logger = require('../browser/logger').init(__filename);
const notifier = runScript({
  absolutePath: require.resolve('./native-notifications.csx'), 
  args: nativeInterop.isWindows10OrHigher()
});

// Public: This class implements the HTML5 Notification class (mostly!), via
// communicating with a bundled C# DLL.
export default class SlackNativeNotification {
  // Public: Creates a notification and dispatches it (per HTML5 Notification)
  //
  // Note that options contains extra parameter that aren't technically
  // spec (initials, theme) but #yolo.
  constructor(title, options={}) {
    _.extend(this, options);
    _.extend(this, require('../renderer/event-listener'));

    let toSend = _.extend({title}, options);

    notifier.then((notify) => {
      logger.debug(`Creating notification: ${JSON.stringify(toSend)}`);
      return notify(JSON.stringify(toSend));
    }).then((result) => {
      this.result = result;
      this.dispatchEvent(result ? 'click' : 'close', { target: this });
    }).catch((e) => {
      this.dispatchError(e);
    });
  }

  // Public: Closes the notification early. Doesn't actually work.
  //
  // Returns nothing.
  close() {
  }

  // Private: This method marshals an {Error} to the 'error' event
  //
  // Returns nothing
  dispatchError(error) {
    logger.warn(`Error while showing notification: ${error.message}`);

    this.dispatchEventWithReplay('error', {
      target: this,
      type: 'error',
      error: error
    });

    this.clearListeners();
  }
}
