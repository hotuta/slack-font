import rx from 'rx';
const spawnOg = require('child_process').spawn;

// Public: Maps a process's output into an {Observable}
//
// exe - The program to execute
// params - Arguments passed to the process
// opts - Options that will be passed to child_process.spawn
//
// Returns an {Observable} with a single value, that is the output of the
// spawned process
export default function spawn(exe, params, opts=null) {
  let spawnObs = rx.Observable.create((subj) => {
    let proc = null;

    if (!opts) {
      proc = spawnOg(exe, params);
    } else {
      proc = spawnOg(exe, params, opts);
    }

    let stdout = '';
    let bufHandler = (b) => {
      let chunk = b.toString();

      stdout += chunk;
      subj.onNext(chunk);
    };

    proc.stdout.on('data', bufHandler);
    proc.stderr.on('data', bufHandler);
    proc.on('error', (e) => subj.onError(e));

    proc.on('close', (code) => {
      if (code === 0) {
        subj.onCompleted();
      } else {
        subj.onError(new Error(`Failed with exit code: ${code}\nOutput:\n${stdout}`));
      }
    });
  });

  return spawnObs.reduce((acc, x) => acc += x, '');
}
