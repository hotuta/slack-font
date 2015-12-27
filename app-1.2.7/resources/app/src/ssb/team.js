const ipc = require('ipc');

module.exports =
class TeamIntegration {
  displayTeam(teamId) {
    ipc.sendToHost('displayTeam', teamId);
  }

  signInTeam(){
    this.reason = 'didSignIn';
    ipc.sendToHost('signInTeam');
  }

  update(teamInfo) {
    ipc.sendToHost('update', teamInfo);
  }

  refreshTileColors() {
    ipc.sendToHost('refreshTileColors');
  }

  setImage(imageUrl){
    ipc.sendToHost('setImage', imageUrl);
  }

  didSignIn() {
    this.reason = 'didSignIn';
    ipc.sendToHost('didSignIn');
  }

  didSignOut() {
    this.reason = 'didSignOut';
    ipc.sendToHost('didSignOut');
  }
  
  invalidateAuth() {
    ipc.sendToHost('invalidateAuth');
  }

  // Public: This method isn't actually called by the SSB JS code, it is a proxy
  // that {SlackWebViewContext} calls as part of the secret handshake documented
  // in {mergeTeamList}. If we're on the signin page or the post signin empty page,
  // we won't have a TS object to call 'refreshTeams' on, so we need to fake out
  // some data to send instead.
  refreshTeams() {
    if (window.TS) {
      window.TS.refreshTeams();
      return;
    }

    ipc.sendToHost('update', [
      { id: '__signin__', team_id: '__signin__', reason: this.reason }
    ]);
  }
};
