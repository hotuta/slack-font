const rx = require('rx-dom');

const WebComponent = require('./web-component');
const SlackWebViewContext = require('./web-view-ctx');

// Public: This class is the ViewController for the multi-team sign-in experience
class LoginDialog extends WebComponent {
  // Public: Constructs a LoginDialog
  //
  // options - options passed to {WebComponent}, as well as:
  //
  //   :webViewFactory - a function that returns a {SlackWebViewContext} (or a mock)
  //   :reporter - A {Reporter} used to send login timings
  constructor(options={}) {
    super('login.html', options);

    this.webViewFactory = options.webViewFactory;
    this.reporter = options.reporter;
    this.currentWebViewDisposable = new rx.SerialDisposable();
    this.closed = new rx.Subject();
    this.signinRequestedClose = new rx.Subject();
    this.allowCancel = true;

    this.loginTime = rx.Disposable.empty;

    this.width = 790;
    this.height = 620;
  }

  // Internal: Sets up our dialog element to a fixed size
  ready() {
    this.dlg = this.content.querySelector('.login');
    this.dlg.style.height = `${this.height+40}px`;
    this.dlg.style.width = `${this.width}px`;

    this.backButton = this.content.querySelector('.login-back-button');

    rx.DOM.fromEvent(this.dlg, 'close').subscribe(() => this.close());
    rx.DOM.fromEvent(this.dlg, 'cancel')
      .where(() => !this.allowCancel)
      .subscribe((e) => e.preventDefault());

    let escHandler = (e) => {
      if (e.keyCode !== 27) return;
      if (!this.allowCancel) return;

      e.preventDefault();
      this.dlg.close();
    };

    this.content.addEventListener('keyup', escHandler, true);

    rx.DOM.fromEvent(this.content.querySelector('.login-close-button'), 'click')
      .where(() => this.allowCancel)
      .subscribe(() => this.dlg.close());

    rx.DOM.fromEvent(this.backButton, 'click')
      .where(() => this.webView && this.webView.wv)
      .subscribe(() => this.webView.wv.goBack());
  }

  // Public: Shows the dialog. Since the actual DOM content for dialog doesn't
  // officially exist until you call show, we have to defer creating the WebView
  // until it does exist, and make triple sure to trash the WebView before we close
  // the dialog
  show() {
    if (this.dlg.open) return;

    this.loginTime = rx.Disposable.empty;
    if (this.reporter) {
      this.loginTime = this.reporter.sendTimingDisposable('performance', 'loginTime');
    }

    // NB: Only show the back button when the user has navigated
    this.backButton.style.visibility = 'hidden';

    let disp = rx.Disposable.create(() => {
      if (this.webView) this.webView.dispose();

      this.webView = null;
      if (this.dlg.open) this.dlg.close();
    });


    let targetUrl = 'https://slack.com/signin';
    if (global.loadSettings.devEnv) {
      targetUrl = `https://${global.loadSettings.devEnv}.slack.com/signin`;
    }

    this.webView = new SlackWebViewContext({
      targetUrl: targetUrl,
      docRoot: this.dlg,
      webViewFactory: this.webViewFactory,
      disableSlackClientFeatures: true,
      disablePreload: true,
      waitForLoaded: false
    });

    this.webView.show();
    this.dlg.showModal();

    this.webView.requestedClose.subscribe(this.signinRequestedClose);

    let ret = this.webView.attachToDom()
      .do(() => {
        this.handleNavigation();
        this.webView.setSize(this.width, this.height);
        this.webView.show();
      })
      .publishLast();

    ret.connect();

    this.currentWebViewDisposable.setDisposable(disp);
    return ret;
  }

  // Public: Set the cancelable state of the dialog and the visibility of the
  // close button accordingly
  setCancelable(allowCancel=true) {
    this.allowCancel = allowCancel;

    var closeButton = this.content.querySelector('.login-close-button');
    closeButton.style.visibility = allowCancel ? 'visible' : 'hidden';
  }

  // Private: Shows or hides the back button based on `canGoBack`
  //
  // Returns a {Disposable} that will unsubscribe the event
  handleNavigation() {
    return rx.DOM.fromEvent(this.webView.wv, 'did-finish-load').subscribe(() => {
      if (this.webView.wv) {
        if (this.webView.wv.canGoBack()) {
          this.backButton.style.visibility = 'visible';
        } else {
          this.backButton.style.visibility = 'hidden';
        }
      }
    });
  }

  // Public: Closes the dialog.
  close() {
    this.loginTime.dispose();
    this.currentWebViewDisposable.setDisposable(rx.Disposable.empty);
    this.closed.onNext(true);
  }

  // Public: Closes the dialog and removes us from the DOM
  dispose() {
    this.currentWebViewDisposable.dispose();
    super.dispose();
  }
}

module.exports = LoginDialog;
