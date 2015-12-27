import _ from 'lodash';
import rx from 'rx-dom';

global.webComponentLinkCache = global.webComponentLinkCache || {};

// Public: WebComponent encapsulates a class that has some associated HTML and
// possibly CSS, that are loaded via the HTML Import tag mechanism
// (http://www.html5rocks.com/en/tutorials/webcomponents/imports), and can attach
// and detach the associated HTML to a DOM node.
//
// This class also manages automatic compilation of LESS stylesheets in Dev Mode;
// to load a LESS stylesheet, simply reference it directly in the HTML as if it were
// a CSS sheet. On first import, the CSS references will be fixed up and imported.
module.exports =
class WebComponent {
  // Public: Constructs a new WebComponent - you almost always want to call this via
  // super() in your derived class.
  //
  // href - The HTML page to load, relative to 'static' (i.e. 'main.html')
  // options - Extra options:
  //
  //     :docRoot - the root element to append content, or document.body if unspecified
  constructor(href, options={}) {
    _.extend(this, _.pick(options, 'docRoot'));

    this.href = href;
    this.docRoot = this.docRoot || global.document.body;
    this.currentAttach = new rx.SerialDisposable();
    this.content = null;

    // NB: We only ever want to import a *single* <link> tag for our HTML file
    // instead of importing it every time, since we can reuse it. So the idea
    // here is, that we effectively need an "async constructor". To do that,
    // we're going to create a new event, who will *replay* the result to anyone
    // else who asks, even if it's already finished. (This is the 'Async' part of
    // 'AsyncSubject')
    //
    // Then, we're going to write _our_ code assuming that we always have to wait
    // for the event, and in cases where it has already happened, it'll just fall
    // through
    if (global.webComponentLinkCache[href]) return;

    let linkTag = global.document.head.querySelector(`link[href='./${href}']`);

    if (!linkTag) {
      throw new Error(`Declaration missing, we can't find the import tag in the HTML file: ${href}`);
    }

    global.webComponentLinkCache[href] = { link: linkTag };
  }

  // Public: Attaches the HTML content associated to this content to the DOM.
  // Once the element is attached, {ready} will be called.
  //
  // Returns: An {Observable} Promise representing when the DOM element is
  // attached and ready. The value returned is a {Disposable} which will clean
  // up the actions taken in attachToDom.
  attachToDom (options={}) {
    var {link} = global.webComponentLinkCache[this.href];

    if (options.docRoot) this.docRoot = options.docRoot;

    // We say here, that the first child of the body element in the template
    // is always the thing we want to clone
    let origContent = link.import.querySelector('body *:first-child');
    let content = origContent ? origContent.cloneNode(true) : null;

    let disp = new rx.CompositeDisposable();
    disp.add(rx.Disposable.create(() => this.docRoot.removeChild(content)));

    // NB: We have to ensure that we first clear out the old content, *then*
    // add in the new content
    this.currentAttach.setDisposable(rx.Disposable.empty);
    if (content) this.docRoot.appendChild(content);

    this.content = content;
    let readyDisp = this.ready();
    if (readyDisp && readyDisp.dispose) disp.add(readyDisp);

    this.currentAttach.setDisposable(disp);

    // NB: The idea is that we want to clear currentAttach but leave it around.
    // This method was originally asynchronous but now it can run immediately,
    // so we use rx.Observable.return here which is why it's A Bit Odd™.
    let finalDisp = rx.Disposable.create(() =>
      this.currentAttach.setDisposable(rx.Disposable.empty));

    return rx.Observable.return(finalDisp);
  }

  // Public: This method must be overridden by subclasses, and is called once the
  // content has been attached to the DOM. Use it to set up event handlers, etc etc.
  //
  // Returns either null, or a Disposable which will be disposed when the content
  // is removed
  ready() {
    throw new Error("Override this in derived classes!");
  }

  // Public: Undoes everything that the class has currently done and cleans up
  // the attached DOM element
  dispose() {
    this.currentAttach.dispose();
  }
};
