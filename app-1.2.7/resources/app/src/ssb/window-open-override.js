module.exports =
class WindowOpenOverride {
  // Public: Overrides `window.open` to use our {WindowApi} for certain URLs.
  // This gives us finer-grained control over those window interactions and
  // is necessary for some integrations.
  constructor() {
    // NB: Save off the original `window.open` for the default behavior
    this.windowDotOpen = window.open;

    window.open = this.windowOpenOverride;
  }

  // Private: Ask the SSB if we should handle this using our windows or dish
  // it out to Electron (it will end up in the `new-window` event)
  //
  // url - The URL being opened
  // frameName - (Optional) The suggested window title
  // features - (Optional) Additional information about the window
  //
  // Returns a reference to the newly created window
  windowOpenOverride(url, frameName, features) {
    console.log(`Got window.open with features: ${features}`);

    // NB: This is essentially a white-list that looks for certain third-party
    // URLs (e.g., Dropbox, Box)
    if (window.TSSSB.canUrlBeOpenedInSSBWindow(url)) {
      let windowCoords = WindowOpenOverride.getCoordinatesFromFeatures(features);
      let options = {
        url: url,
        x: windowCoords.left,
        y: windowCoords.top,
        width: windowCoords.width,
        height: windowCoords.height
      };

      let token = window.winssb.window.open(options);
      return window.winssb.window.windowList[token];
    } else {
      return this.windowDotOpen(url, frameName, features);
    }
  }

  // Private: Extracts window size and position from a string
  //
  // features - Additional information passed to `window.open`, e.g.,
  //            "width=660,height=440,left=-1212.5,top=197.5"
  //
  // Returns an Object with keys `left`, `top`, `width`, and `height`, or an
  // empty Object if the relevant features are not found
  static getCoordinatesFromFeatures(features) {
    if (!features || features === '') return {};

    let params = features.split(',');
    if (params.length === 1) return {};

    let result = {};
    let desiredKeys = ['left', 'top', 'width', 'height'];

    for (let param of params) {
      let expression = param.split('=');
      if (desiredKeys.indexOf(expression[0]) > -1) {
        result[expression[0]] = parseInt(expression[1]);
      }
    }
    return result;
  }
};
