let WebRTC = null;

export default class Calls {
  constructor() {
    WebRTC = WebRTC || require('@paulcbetts/slack-calls');
    this.callbacks = {};
  }

  init(obj) {
    this.callbacks = obj.callbacks;
  }

  startNewCall() {
    let version = `${window.TS.model.win_ssb_version}.${window.TS.model.win_ssb_version_minor}`;

    this.session = new WebRTC.SHSession(
      (j) => this.invokeJSMethod(j),
      () => this.onJanusDisconnected(),
      version);
  }

  invokeJSMethod(msg_json) {
    // console.log("NATIVE_TO_JS: " + msg_json);
    var msg = JSON.parse(msg_json);

    if (!this.callbacks[msg.method]) {
      console.log(`Call from NATIVE to invalid JS method: ${msg.method} - ${msg}`);
    } else {
      this.callbacks[msg.method](msg.args);
    }
  }

  invokeNativeMethod(json_str) {
    // console.log('JS_TO_NATIVE: ' + json_str);
    if (this.session) {
      this.session.invokeNativeFunction(json_str);
    } else {
      console.log("Calls.session is null/not defined; ignoring invokeNativeMethod()");
    }
  }

  setMiniPanelState(active, title, userid, info, muted) {
    console.log(`setMiniPanelState: ${active}, title: ${title}`);
  }

  closeWindow() {
    console.log('Close window called');
  }

  disconnectJanus(webview) {
    console.log(`disconnect webview ${webview}`);
  }

  onJanusDisconnected(session) {
    console.log(`Session ${session} disconnected`);

    this.session.destroy();
    this.session = null;
  }
}
