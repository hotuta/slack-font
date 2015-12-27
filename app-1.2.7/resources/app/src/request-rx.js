const rx = require('rx');
const request = require('request');
const fs = require('fs');

let wrapMethodInRx = (method) => {
  return function(...args) {
    return rx.Observable.create((subj) => {
      // Push the callback as the last parameter
      args.push((err, resp, body) => {
        if (err) {
          subj.onError(err);
          return;
        }

        if (resp.statusCode >= 400) {
          subj.onError(new Error(`Request failed: ${resp.statusCode}\n${body}`));
          return;
        }

        subj.onNext({response: resp, body: body});
        subj.onCompleted();
      });

      try {
        method(...args);
      } catch (e) {
        subj.onError(e);
      }

      return rx.Disposable.empty;
    });
  };
};

let requestRx = wrapMethodInRx(request);
requestRx.get = wrapMethodInRx(request.get);
requestRx.post = wrapMethodInRx(request.post);
requestRx.patch = wrapMethodInRx(request.patch);
requestRx.put = wrapMethodInRx(request.put);
requestRx.del = wrapMethodInRx(request.del);

requestRx.pipe = (url, stream) => {
  return rx.Observable.create((subj) => {
    try {
      request.get(url)
        .on('response', (resp) => {
          if (resp.statusCode > 399) subj.onError(new Error(`Failed request: ${resp.statusCode}`));
        })
        .on('error', (err) => subj.onError(err))
        .on('end', () => { subj.onNext(true); subj.onCompleted(); })
        .pipe(stream);
    } catch (e) {
      subj.onError(e);
    }
  });
};


let isHttpUrl = (pathOrUrl) => pathOrUrl.match(/^http/i);

// Public: Fetches a file or URL, then returns its content as an Observable
//
// pathOrUrl - Either a file path or an HTTP URL
//
// Returns: An Observable which will yield a single value and complete, the contents
// of the given path or URL.
requestRx.fetchFileOrUrl = (pathOrUrl) => {
  if (!isHttpUrl(pathOrUrl)) {
    try {
      return rx.Observable.return(fs.readFileSync(pathOrUrl, { encoding: 'utf8' }));
    } catch (e) {
      return rx.Observable.throw(e);
    }
  }

  return requestRx(pathOrUrl).map((x) => x.body);
};

// Private: Opens a file or URL, then returns a Readable Stream as an Observable
//
// pathOrUrl - Either a file path or an HTTP URL
//
// Returns: An Observable which will yield a single value and complete, which will
// be a Readable Stream that can be used with `pipe` or `read` / `readSync`
requestRx.streamFileOrUrl = (pathOrUrl) => {
  if (!isHttpUrl(pathOrUrl)) {
    return rx.Observable.create((subj) => {
      let s = fs.createReadStream(pathOrUrl);

      s.on('open', () => {
        subj.onNext(s);
        subj.onCompleted();
      });

      s.on('error', (err) => subj.onError(err));

      return rx.Disposable.empty;
    });
  }

  return rx.Observable.create((subj) => {
    let rq = null;
    try {
      rq = request(pathOrUrl);
    } catch (e) {
      subj.onError(e);
      return rx.Disposable.empty;
    }

    rq.on('response', (resp) => {
      subj.onNext(resp);
      subj.onCompleted();
    });

    rq.on('error', (err) => subj.onError(err));
    return rx.Disposable.empty;
  });
};

module.exports = requestRx;
