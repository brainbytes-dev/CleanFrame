'use strict';

// CleanFrame start service.
//
// Hidden web apps are frozen on retail TVs, so this runs as a Tizen web service started at
// boot. Two jobs: open CleanFrame shortly after the TV starts, and bring it back when
// Samsung's own home screen appears.
//
// It only acts when Samsung's home screen is actually reported visible. Any other app that
// owns the screen is left alone, so opening Netflix or YouTube is never interrupted. A
// failed or unclear status reply never triggers a relaunch.
//
// Escape hatch: three relaunches inside a minute are treated as the owner deliberately
// wanting Samsung's menu (for example to delete apps), and the service stands down for five
// minutes.
//
// Derived from the AeroTizen watcher service (MIT, https://github.com/helalaou/AeroTizen),
// reduced to the non-Frame fast path.

var http = require('http');

// Diagnostics. The service has no UI and no open port, so a log file on the TV is the only
// way to tell "never started" apart from "started but the launch was refused". Pulled with
// sdb from the app's own data directory. Best-effort: logging never breaks the service.
var LOG = '/opt/usr/home/owner/apps_rw/nClrkHome1/data/cf-service.log';
var fs = null;
try { fs = require('fs'); } catch (e) { fs = null; }
function log(message) {
  if (!fs) { return; }
  try {
    fs.appendFileSync(LOG, new Date().toISOString() + ' ' + message + '\n');
  } catch (e) { /* A full or read-only data directory must not stop the service. */ }
}

var SELF = 'nClrkHome1.FrameHome';
var STOCK = 'com.samsung.tv.csfs';   // Samsung's built-in home screen

var POLL = 700;
var BOOT_DELAY = 4000;               // let the TV settle before the first launch
var LAUNCH_GAP = 3000;               // ignore the screen right after our own launch
var BURST_WINDOW = 60000;
var BURST_LIMIT = 3;
var STAND_DOWN = 300000;             // five minutes hands-off after a burst
var REQUEST_TIMEOUT = 1500;

var started = false;
var stopped = false;
var timer = null;
var bootTimer = null;
var busy = false;
var launches = [];                   // timestamps of our own launches
var standDownUntil = 0;

function get(path, cb) {
  var settled = false;
  var req = null;
  var guard = setTimeout(function () {
    finish(null);
    if (req) { req.destroy(); }
  }, REQUEST_TIMEOUT);
  function finish(value) {
    if (settled) { return; }
    settled = true;
    clearTimeout(guard);
    cb(value);
  }
  try {
    req = http.get({ host: '127.0.0.1', port: 8001, path: path }, function (res) {
      var body = '';
      res.on('data', function (chunk) {
        body += chunk;
        if (body.length > 65536) { finish(null); req.destroy(); }
      });
      res.on('error', function () { finish(null); });
      res.on('end', function () {
        if (res.statusCode !== 200) { finish(null); return; }
        var value = null;
        try { value = JSON.parse(body); } catch (e) { value = null; }
        finish(value);
      });
    });
    req.on('error', function () { finish(null); });
  } catch (e) { finish(null); }
}

// Resolves to null when the TV did not give a usable answer. Callers must not act on null.
function appStatus(id, cb) {
  get('/api/v2/applications/' + encodeURIComponent(id), function (value) {
    var usable = value && typeof value.running === 'boolean' && typeof value.visible === 'boolean';
    cb(usable ? value : null);
  });
}

function launch(why) {
  if (stopped) { return; }
  var now = Date.now();
  var recent = [];
  for (var i = 0; i < launches.length; i += 1) {
    if (now - launches[i] < BURST_WINDOW) { recent.push(launches[i]); }
  }
  launches = recent;
  // Repeated relaunches mean the owner wants Samsung's menu, or our launch is not sticking.
  // Either way, stop fighting the screen for a while.
  if (launches.length >= BURST_LIMIT) {
    launches = [];
    standDownUntil = now + STAND_DOWN;
    return;
  }
  launches.push(now);
  log('launch attempt (' + why + ')');
  try {
    tizen.application.launch(SELF, function () { log('launch ok (' + why + ')'); },
      function (err) { log('launch refused (' + why + '): ' + (err && (err.name || err.message))); });
  } catch (e) {
    // A failed launch is retried by the next poll, within the burst limit.
    log('launch threw (' + why + '): ' + (e && e.message));
  }
}

function tick() {
  if (stopped || busy) { return; }
  var now = Date.now();
  if (now < standDownUntil) { return; }
  busy = true;
  var done = false;
  var watchdog = setTimeout(release, REQUEST_TIMEOUT * 3);
  function release() {
    if (done) { return; }
    done = true;
    clearTimeout(watchdog);
    busy = false;
  }
  appStatus(SELF, function (me) {
    if (done || stopped) { release(); return; }
    if (!me) { release(); return; }                 // unknown state: do nothing
    if (me.visible) { release(); return; }          // already on screen
    if (Date.now() - (launches.length ? launches[launches.length - 1] : 0) < LAUNCH_GAP) {
      release(); return;                            // our own launch may not have landed yet
    }
    appStatus(STOCK, function (stock) {
      if (done || stopped) { release(); return; }
      // Only Samsung's own home screen is reclaimed. Any other app keeps the screen.
      if (stock && stock.visible) { launch('samsung home visible'); }
      release();
    });
  });
}

module.exports.onStart = function () {
  if (started) { return; }
  started = true;
  log('service onStart; tizen api ' + (typeof tizen !== 'undefined' ? 'present' : 'MISSING') +
      ', fs ' + (fs ? 'present' : 'MISSING'));
  bootTimer = setTimeout(function () {
    if (stopped) { return; }
    appStatus(SELF, function (me) {
      if (stopped) { return; }
      log('boot check: self status ' + (me ? 'visible=' + me.visible + ' running=' + me.running : 'UNAVAILABLE'));
      if (!me || !me.visible) { launch('boot'); }
    });
  }, BOOT_DELAY);
  timer = setInterval(tick, POLL);
};

module.exports.onRequest = function () {};

module.exports.onExit = function () {
  stopped = true;
  clearInterval(timer);
  clearTimeout(bootTimer);
  timer = null;
  bootTimer = null;
};
