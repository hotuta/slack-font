import ipc from '../ipc-rx';
import rx from 'rx';
import WindowBehavior from './window-behavior';

export default class EditingCommandsWindowBehavior extends WindowBehavior { 
  // Public: Sets the window up to handle editing commands.
  //
  // hostWindow - The {SlackWindow} to attach the behavior to
  //
  // Returns a {Disposable} which will undo whatever this behavior has set up
  setup(hostWindow) {
    let webContents = hostWindow.window.webContents;

    let disp = new rx.CompositeDisposable();

    disp.add(ipc.listen('core:undo').subscribe(() => 
      webContents.undo()
    ));

    disp.add(ipc.listen('core:redo').subscribe(() =>
      webContents.redo()
    ));

    disp.add(ipc.listen('core:cut').subscribe(() =>
      webContents.cut()
    ));

    disp.add(ipc.listen('core:copy').subscribe(() =>
      webContents.copy()
    ));

    disp.add(ipc.listen('core:paste').subscribe(() =>
      webContents.paste()
    ));

    disp.add(ipc.listen('core:select-all').subscribe(() =>
      webContents.selectAll()
    ));

    return disp;
  }
}
