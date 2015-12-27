const ipc = require('ipc');
const shell = require('shell');
const uuid = require('node-uuid');
const _ = require('lodash');

const logger = require('../browser/logger').init(__filename);

module.exports =
class DownloadIntegration {
  startDownload(url) {
    let token = uuid.v4();
    ipc.sendToHost('downloads:start', {url: url, token: token});
    return token;
  }

  cancelDownloadWithToken(token) {
    ipc.sendToHost('downloads:cancel', {token: token});
  }

  retryDownloadWithToken(token) {
    ipc.sendToHost('downloads:retry', {token: token});
  }

  metadataForDownloads() {
    return localStorage.getItem('downloads:metadata') || '{}';
  }

  pruneTokensFromHistory(tokens) {
    ipc.sendToHost('downloads:prune', {tokens: JSON.parse(tokens)});
  }

  clearHistory() {
    let metadata = JSON.parse(this.metadataForDownloads());
    let tokens = _.keys(metadata);
    this.pruneTokensFromHistory(tokens);
  }

  revealDownloadWithToken(token) {
    ipc.sendToHost('downloads:reveal', {token: token});
  }

  revealFileAtPath(filePath) {
    shell.showItemInFolder(filePath);
  }

  openFileAtPath(filePath) {
    shell.openItem(filePath);
  }

  //
  // Trampolines for methods in download-manager
  //

  syncMetadata(base64EncodedJsonMetadata) {
    let str = null;
    try {
      str = decodeURIComponent(atob(base64EncodedJsonMetadata));
    } catch (e) {
      logger.error(`Tried to decode metadata but failed: ${base64EncodedJsonMetadata}`);
    }

    localStorage.setItem('downloads:metadata', str);
    window.TSSSB.downloadMetadataChanged();
  }

  downloadWithTokenDidSelectFilepath(token, b64FilePath) {
    let filePath = null;
    try {
      filePath = decodeURIComponent(atob(b64FilePath));
    } catch (e) {
      logger.error(`Tried to decode metadata but failed: ${b64FilePath}`);
    }

    window.TSSSB.downloadWithTokenDidSelectFilepath(token, filePath);
  }
};
