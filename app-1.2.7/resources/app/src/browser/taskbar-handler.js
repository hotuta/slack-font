import rx from 'rx';
import ipc from './ipc-rx';

import {getIdleTimeInMs} from '../native-interop';

let logger = null;

// The amount of time (in milliseconds) that a user must be inactive before
// we'll flash their taskbar icon.
const idleThresholdMs = 10 * 1000;

export default class TaskbarHandler {
  // Public: Creates a new instance of {TaskbarHandler}.
  //
  // mainWindow - The main {SlackWindow} instance
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.currentAttach = new rx.SerialDisposable();

    logger = require('./logger').init(__filename);
  }

  // Public: Sets up the window flashing behavior based on the state of the
  // preference.
  //
  // whenToFlash - A preference that indicates when we should flash the window.
  //               One of 'always', 'idle', or 'never'
  // willRunFromTray - True if the app will run from the tray when its window
  //                   is closed
  //
  // Returns nothing
  attach(whenToFlash, willRunFromTray) {
    logger.info(`Window will flash: ${whenToFlash}`);

    // If 'never', we'll keep these as empty.
    let startFlash = rx.Observable.empty();
    let endFlash = rx.Observable.empty();

    switch (whenToFlash) {
    case 'always':
      // NB: If always set to flash, ignore the notification closed event and
      // keep the icon lit until the window is focused.
      startFlash = ipc.listen('notify:flash-start').map(() => true);
      endFlash = rx.Node.fromEvent(this.mainWindow.window, 'focus').map(() => false);
      break;
    case 'idle':
      // NB: If idle, only start flashing if the user has been inactive for
      // longer than our threshold duration.
      startFlash = ipc.listen('notify:flash-start')
        .where(() => getIdleTimeInMs() >= idleThresholdMs)
        .map(() => true);
      endFlash = rx.Observable.merge(ipc.listen('notify:flash-end'),
        rx.Node.fromEvent(this.mainWindow.window, 'focus'))
        .map(() => false);
      break;
    }

    let subscription = rx.Observable.merge(startFlash, endFlash)
      .distinctUntilChanged()
      .subscribe((isOn) => this.toggleFlash(isOn, willRunFromTray));

    this.currentAttach.setDisposable(subscription);
  }

  // Public: Cleans up this instance.
  //
  // Returns nothing
  dispose() {
    this.currentAttach.dispose();
  }

  // Private: Starts or stops the taskbar / window flashing.
  //
  // isOn - True to begin flashing, false to end
  // willRunFromTray - True if the app will run from the tray when its window
  //                   is closed
  //
  // Returns nothing
  toggleFlash(isOn, willRunFromTray) {
    logger.debug(`Window flashing: ${isOn}`);

    if (isOn) {
      let wasRestoredFromTray = false;
      // If running from the tray, first restore the window so that we have an
      // icon to flash.
      if (!this.mainWindow.isVisible()) {
        wasRestoredFromTray = true;
        this.mainWindow.minimize();
      }

      rx.Scheduler.timeout.scheduleWithRelative(20, () => {
        this.flashDisp = new rx.CompositeDisposable();

        this.flashDisp.add(this.mainWindow.flash());
        this.flashDisp.add(rx.Disposable.create(() => {
          // If we're still minimized when flashing has ended, put the window
          // back in the tray.
          if (this.mainWindow.isMinimized() && willRunFromTray && wasRestoredFromTray) {
            this.mainWindow.hide();
          }
        }));
      });
    } else {
      if (!this.flashDisp) return;
      this.flashDisp.dispose();
      this.flashDisp = null;
    }
  }
}
