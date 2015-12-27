import fs from 'fs';
import path from 'path';
import promisify from './promisify';

// NB: edge-loader is used super early, so we have to delay-initialize these libraries
let edge = null;

// Public: Runs an Edge.js script that contains C# code
//
// options - A hash containing the following options:
//
//           :absolutePath - The absolute path to the script
//
//           :isSync - True to run this script synchronously, false to return
//                     an awaitable {Promise}
//
//           :args - An object to pass to the script's Invoke method
//
// Returns the result of the script, if run synchronously, a {Promise} if run
// async, and null if the script could not be run.
export default function runScript(options) {
  if (process.platform !== 'win32') {
    throw new Error("Don't try to load Edge.js on non-Windows");
  }

  edge = edge || require('edge-atom-shell');
  
  let {absolutePath, isSync, args} = options;
  let script = edge.func({
    source: fs.readFileSync(absolutePath, 'utf8'),
    references: [path.join(path.dirname(process.execPath), 'SlackNotifier.dll')]
  });

  try {
    return isSync ?
      script(args, true) :
      promisify(script)(args).then((notifyOrError) => {
        if (typeof notifyOrError === 'string') {
          return Promise.reject(new Error(notifyOrError));
        } else {
          return promisify(notifyOrError);
        }
      });
  } catch (error) {
    console.log(`Unable to execute ${absolutePath}: ${error}`);
    return null;
  }
}
