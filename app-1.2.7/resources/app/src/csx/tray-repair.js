import runScript from '../edge-loader';

export default async function repairTrayRegistryKey() {
  // Not Windows? Seeya
  if (process.platform !== 'win32') {
    return null;
  }

  return await runScript({
    absolutePath: require.resolve('./tray-repair.csx'),
    args: process.execPath
  });
}
