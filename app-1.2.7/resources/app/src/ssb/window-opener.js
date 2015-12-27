module.exports =
class WindowOpener {
  // Public: This method is an API that we add solely to popup windows opened
  // via winssb.window.open, that allows the popup to eval JavaScript in the
  // context of its parent (usually a WebView, but could be another popup
  // window).
  //
  // It's basically the same as executeJavaScriptInWindow, except that its
  // options are only 'code' and 'callback'.
  //
  // call it like:
  /*
  
  window.opener.executeJavaScript({
    code:'window.document.location.href',
    callback:function(err, data) {
      console.info(data);
    }
  });
  
  */
  // Returns an {Observable} indicating completion
  executeJavaScript(options) {
    if (!options.code) {
      throw new Error("Missing parameters, needs code");
    }

    if (!window.parentBrowserWindowId) {
      throw new Error("Parent window ID not set, calling this method too early?");
    }

    let opts = {
      code: options.code,
      browserWindowId: window.parentBrowserWindowId
    };

    if (window.parentGuestInstanceId) {
      opts.guestInstanceId = window.parentGuestInstanceId;
    }

    if (options.callback) {
      opts.callback = options.callback;
    }

    return window.winssb.window.executeJavaScriptInWindow(opts);
  }

  // Public: Dispatches an event from the popup window to its parent context,
  // using the `executeJavaScript` method
  //
  // data - The data that will attached to the {Event}
  // targetOrigin - The origin of the message
  //
  // Returns nothing
  postMessage(data, targetOrigin) {
    let opts = {
      code: `var evt = new Event('message'); evt.data = ${JSON.stringify(data)}; window.dispatchEvent(evt);`,
      callback: (result) => console.log(`postMessage result: ${result}`)
    };

    console.log(`Signaling parent from postMessage: ${opts.code}, ${targetOrigin}`);
    this.executeJavaScript(opts);
  }

  constructor() {
    let rx = require('rx');
    let disp = new rx.CompositeDisposable();
    let remote = require('remote');
    let app = remote.require('app');

    disp.add(rx.Node.fromEvent(app, 'before-quit').subscribe(() => {
      window.opener = null;
      window.close();
    }));
  }
};
