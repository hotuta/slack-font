var path = require('path');
var _ = require('lodash');

// Warning: You almost certainly do *not* want to edit this code - instead, you
// want to edit src/ssb/main.js instead
var start = function(loadSettings) {
  window.loadSettings = loadSettings;
  if (loadSettings.devMode) {
    require('electron-compile').init();
  } else {
    var cachePath = path.join(__dirname, '..', 'cache');
    require('electron-compile').initForProduction(cachePath);
  }

  require('../src/ssb/main');
};

const processRef = window.process;
process.nextTick(function() { 
  // Patch global back in
  window.process = processRef; 
});

// NB: For whatever reason, we have to wait longer to restore 'global'
setTimeout(function() { window.global = window; }, 10);

start(_.extend({}, require('remote').getGlobal('slackApplication').loadSettings));
