import runScript from '../edge-loader';

export function register() {
  if (process.platform !== 'win32') {
    return null;
  }
  
  return runScript({
    absolutePath: require.resolve('./protocol-handler.csx'),
    isSync: true,
    args: {register: true, exePath: process.execPath}
  });
}

export function unregister() {
  if (process.platform !== 'win32') {
    return null;
  }

  return runScript({
    absolutePath: require.resolve('./protocol-handler.csx'),
    isSync: true,
    args: {register: false}
  });
}