class NotificationHelpers {

  // Public: Calculates the size and position of the host window.
  //
  // options - A hash containing the following options:
  //          :size - The size of individual notifications
  //          :parent - The parent window
  //          :screenPosition - Determines where notifications appear, contains
  //                            keys `corner` and `display`
  //          :maxCount - The maximum number of notifications to display
  //          :screenApi - An API used to retrieve display information
  //
  // Returns an object containining size and position, with keys:
  // x, y, width, and height
  static calculateHostCoordinates(options) {
    let {size, parent, screenPosition, maxCount, screenApi} = options;

    let display = NotificationHelpers.getDisplayForHost(parent, screenPosition, screenApi);
    let bounds = display.workArea;

    // We don't resize the window dynamically, so pick a height that will fit
    // our maximum number of notifications.
    let targetHeight = maxCount * size.height;

    // In multi-monitor scenarios, `workArea` can contain negative coordinates.
    // Be sure to add x or y to the height or width.
    var targetX, targetY;

    switch (screenPosition.corner) {
    case 'top_left':
      targetX = bounds.x;
      targetY = bounds.y;
      break;
    case 'top_right':
      targetX = bounds.x + bounds.width - size.width;
      targetY = bounds.y;
      break;
    case 'bottom_left':
      targetX = bounds.x;
      targetY = bounds.y + bounds.height - targetHeight;
      break;
    case 'bottom_right':
      targetX = bounds.x + bounds.width - size.width;
      targetY = bounds.y + bounds.height - targetHeight;
      break;
    }

    return {
      x: targetX,
      y: targetY,
      width: NotificationHelpers.ensureEven(size.width),
      height: NotificationHelpers.ensureEven(targetHeight)
    };
  }

  // Public: Returns the display that notifications should be positioned on,
  // based on the `screenPosition.display` preference.
  //
  // parent - The parent window
  // screenPosition - Determines where notifications appear, contains keys
  //                  `corner` and `display`
  // screenApi - An API used to retrieve display information
  //
  // Returns a display object
  static getDisplayForHost(parent, screenPosition, screenApi) {
    switch (screenPosition.display) {
    case 'same_as_app':
      // NB: Pick the display based on the center point of the main window.
      // The top-left can be negative for maximized windows.
      let position = parent.getPosition();
      let windowSize = parent.getSize();
      let centerPoint = {
        x: Math.round(position[0] + windowSize[0] / 2.0),
        y: Math.round(position[1] + windowSize[1] / 2.0)
      };

      let sameDisplayAsApp = screenApi.getDisplayNearestPoint(centerPoint);
      return sameDisplayAsApp || screenApi.getPrimaryDisplay();
    default:
      return screenApi.getPrimaryDisplay();
    }
  }

  // Private: Ensures that the given number is even, incrementing it if
  // necessary. Atom Shell transparent windows have rendering glitches when
  // the window size is odd.
  // Refer to https://github.com/atom/atom-shell/issues/1366.
  //
  // number - An integer value
  //
  // Returns the incremental even number if given an odd number.
  static ensureEven(number) {
    return (number % 2 === 0) ? number : number + 1;
  }
}

module.exports = NotificationHelpers;
