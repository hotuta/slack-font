const Menu = require('menu');
const MenuItem = require('menu-item');
const season = require('season');
const path = require('path');
const _ = require('lodash');
const {EventEmitter} = require('events');
const app = require('app');

let logger = null;

// Public: Used to manage the global application menu.
//
// It's created by {SlackApplication} upon instantiation and used to add, remove
// and maintain the state of all menu items.
class ApplicationMenu extends EventEmitter {

  // Public: Creates a new ApplicationMenu
  //
  // options - A hash containing the following options:
  //
  //           :devMode - True if this menu should contain developer-only items
  //
  //           :reporter - An instance of {Reporter} that is used to send menu
  //                       item invocation statistics to Google Anaytics
  constructor(options) {
    super();
    logger = require('./logger').init(__filename);

    let appMenu = path.join(process.resourcesPath, 'app.asar', 'menus', `${process.platform}.json`);

    let template = season.readFileSync(appMenu);
    this.checkAutoHideMenuBar(template, !options.autoHideMenuBar);
    this.template = this.translateTemplate(template.menu, options.reporter);

    let runningFromTempDir = (process.execPath.indexOf('slack-build') >= 0);
    if (!options.devMode && !runningFromTempDir) {
      this.removeDeveloperMenu();
    }
  }

  // Public: Attaches the ApplicationMenu to the given Window. Note that on OS X
  // this attaches to the global application.
  //
  // Returns nothing, but eventually a {Disposable} that will detach the menu
  attachToWindow(appWindow) {
    this.appWindow = appWindow;
    let menu = Menu.buildFromTemplate(_.cloneDeep(this.template));
    this.setApplicationMenu(menu);
  }

  // Public: Rebuilds the ApplicationMenu to add team-switching items
  //
  // teamList - The list of signed in teams
  //
  // Returns nothing, but eventually a {Disposable} that will detach the menu
  updateTeamItems(teamList) {
    if (!teamList || teamList.length === 0) return;
    if (!_.all(teamList, (team) => team.team_name && team.team_name.length > 2)) return;
    if (_.isEqual(this.teamList, teamList)) return;

    this.teamList = teamList;

    logger.info("Rebuilding team menu items");
    let dockMenu = new Menu();

    // Due to a limitation in Atom, we need to rebuild the entire menu.
    // The existing template is already wired up, so we'll start with that.
    let menu = Menu.buildFromTemplate(_.cloneDeep(this.template));

    let windowMenu = _.find(menu.items, (item) => item.label === 'Window');
    let startIndex = this.getIndexOfTeamMenu();

    windowMenu.submenu.insert(startIndex, new MenuItem({ type: 'separator' }));

    for (var index = 0; index < this.teamList.length; index++) {

      // Wrap this in a closure to ensure that indexes are captured properly.
      let addItem = (team, teamIndex) => {
        // Build a menu item for each team, incrementing the hotkey as we go
        let itemDesc = {
          label: team.team_name,
          accelerator: `CommandOrControl+${index+1}`,
          click: () => {
            this.appWindow.send('window:select-team', teamIndex);
            this.appWindow.bringToForeground();
          }
        };

        windowMenu.submenu.insert(startIndex + index, new MenuItem(itemDesc));
        dockMenu.insert(index, new MenuItem(itemDesc));
      };

      addItem(this.teamList[index], index);
    }

    dockMenu.insert(this.teamList.length, new MenuItem({ type: 'separator' }));
    dockMenu.insert(this.teamList.length+1,new MenuItem({
      label: "Sign in to another team...",
      click: () => {
        this.appWindow.send('window:signin');
        this.appWindow.bringToForeground();
      }
    }));

    this.setApplicationMenu(menu);

    if (process.platform === 'darwin') {
      app.dock.setMenu(dockMenu);
    }
  }

  // Private: We need to mirror the menu item's checked state with the state of
  // the preference
  //
  // Returns nothing
  checkAutoHideMenuBar(template, checked) {
    if (process.platform !== 'darwin') {
      template.menu[3].submenu[0].checked = checked;
    }
  }

  // Private: Sets the application menu on OS X or the menu for the main window
  // on Windows and Linux. `Menu.setApplicationMenu` overrides the menu for all
  // instances of {BrowserWindow}, so it is undesirable on non-Mac platforms.
  //
  // Returns nothing
  setApplicationMenu(menu) {
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(menu);
    } else {
      this.appWindow.setMenu(menu);
    }
  }

  // Private: Returns the starting index of the team-specific items.
  // This varies per platform due to differences in the Window menu.
  //
  // Returns the index
  getIndexOfTeamMenu() {
    switch (process.platform) {
    case 'darwin':
      return 3;
    case 'win32':
    case 'linux':
      return 2;
    }
  }

  // Private: Combines a menu template with a click handler. In the future, this
  // method will also wire up CanExecute handlers for menu items, should we need
  // them.
  //
  // template - An Object conforming to atom-shell's menu api but lacking
  //            click properties.
  //
  // Returns a complete menu configuration object for atom-shell's menu API.
  translateTemplate(template, reporter) {
    for (let item of template) {
      if (item.command) {
        this.wireUpMenu(item, item.command, reporter);
      }

      if (item.submenu) {
        this.translateTemplate(item.submenu, reporter);
      }
    }
    return template;
  }

  // Private: Sets up the menu to emit the command it is associated with.
  //
  // Returns nothing
  wireUpMenu(menu, command, reporter) {
    menu.click = (args) => {
      if (reporter) reporter.sendCommand(command);
      this.emit(command, args);
    };
  }

  // Private: Removes the View | Developer sub-menu from the template.
  //
  // Returns nothing
  removeDeveloperMenu() {
    let viewMenu = _.find(this.template, (item) => {
      return item.label.indexOf('View') !== -1;
    });

    let developerMenu = _.find(viewMenu.submenu, (item) => {
      return item.label && item.label.indexOf('Developer') !== -1;
    });

    // Splice out both the menu and the preceding separator
    let index = _.indexOf(viewMenu.submenu, developerMenu);
    viewMenu.submenu.splice(index - 1, 2);
  }
}

module.exports = ApplicationMenu;
