class WindowBehavior {
  // Public: Sets up a window-specific behavior
  //
  // hostWindow - The {SlackWindow} to attach the behavior to
  //
  // Returns a {Disposable} which will undo whatever this behavior has set up
  setup(hostWindow) {
    throw new Error("Override this!");
  }
}

module.exports = WindowBehavior;
