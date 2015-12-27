var rx = require('rx');
rx = require('rx-dom');

let logger = require('../browser/logger').init(__filename);

let WebComponent = require('./web-component');

// Public: This class is the ViewController for the loading screen and associated
// subviews.
module.exports =
class LoadingScreen extends WebComponent {
  // Public: Creates a new LoadingScreen
  constructor(options={}) {
    super('loading.html', options);
    this.tryAgainObservable = new rx.Subject();
  }

  // Public: Hides all of the messages ("Slack Down", "Offline", "Trying")
  hideAll() {
    this.content.querySelector('.slackdown').style.display = 'none';
    this.content.querySelector('.slackdown').style.opacity = 0;

    this.content.querySelector('.offline').style.display = 'none';
    this.content.querySelector('.offline').style.opacity = 0;

    this.content.querySelector('.trying').style.display = 'none';
    this.content.querySelector('.trying').style.opacity = 0;
  }

  // Public: Shows the "User offline" message
  showOffline() {
    this.hideAll();

    logger.warn('Showing Slack offline element');
    this.content.querySelector('.offline').style.display = 'table-cell';

    rx.Scheduler.timeout.schedule(() =>
      this.content.querySelector('.offline').style.opacity = 1);
  }

  // Public: Shows the "Slack Is Down" message, also used for the "We Crashed"
  // message sometimes (but hopefully we will instead refresh the page at all
  // costs)
  showSlackDown() {
    this.hideAll();

    logger.warn('Showing Slack down element');
    this.content.querySelector('.slackdown').style.display = 'table-cell';

    rx.Scheduler.timeout.schedule(() =>
      this.content.querySelector('.slackdown').style.opacity = 1);
  }

  // Public: Shows the "Connecting..." message
  showTrying() {
    this.hideAll();

    this.content.querySelector('.trying').style.display = 'table-cell';
    rx.Scheduler.timeout.schedule(() =>
      this.content.querySelector('.trying').style.opacity = 1);
  }

  // Internal: Sets up the hooks for retrying a connection when someone clicks
  // the 'Try Again' button
  ready() {
    let elements = this.content.querySelectorAll('.retry');
    return rx.DOM.fromEvent(elements, 'click').multicast(this.tryAgainObservable).connect();
  }
};
