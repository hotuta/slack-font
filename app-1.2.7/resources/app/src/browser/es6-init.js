var fs = require('fs');
var path = require('path');
var _ = require('lodash');

var cachePath = path.join(__dirname, '..', '..', 'cache');
var devMode = _.find(process.argv, function(x) { return x === '-r'; });

if (fs.statSyncNoException(cachePath) && !devMode) {
  require('electron-compile').initForProduction(cachePath);
} else {
  require('electron-compile').init();
}

require('./main');
