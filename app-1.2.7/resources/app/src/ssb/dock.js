const ipc = require('ipc');
const rx = require('rx-dom');
const remote = require('remote');
const app = remote.require('app');

class FakeDock{
  getBadge() {}
  bounce() { return -1; }
  cancelBounce() {}
  setBadge() {}
}

module.exports =
class DockIntegration {
  constructor() {
    this.disp = new rx.SerialDisposable();
    this.dock = app.dock || new FakeDock();
  }

  badge() { return this.dock.getBadge(); }

  bounceOnce() { this.bounce('informational'); }

  bounceIndefinitely() { this.bounce('critical'); }

  bounce(type) {
    let id = this.dock.bounce(type);

    this.disp.setDisposable(() => {
      if (id < 0) return;
      this.dock.cancelBounce(id);
    });
  }

  stopBouncing() {
    this.disp.setDisposable(rx.Disposable.empty);
  }

  setBadgeCount(unreadHighlights, unread) {
    ipc.sendToHost('setBadgeCount', {unreadHighlights, unread});
  }

  // Public: This method is called by the webapp whenever the connecting status
  // badge changes.
  //
  // status - a {String}, one of 'online', 'offline', or 'connecting'
  //
  // Returns nothing
  setConnectionStatus(status) {
    // TODO: Bring this back once we decide to do connection status overlays
    /*
    let validStates = ['online', 'offline', 'connecting'];

    if (validStates.indexOf(status) < 0) {
      throw new Error("WTF state??");
    }

    ipc.sendToHost('setConnectionStatus', status);
    */
  }
};
