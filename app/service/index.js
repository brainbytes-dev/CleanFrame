'use strict';

// CleanFrame start service.
//
// Hidden web apps are frozen on retail TVs, so this runs as a Tizen web service started at
// boot. Two jobs: open CleanFrame shortly after the TV starts, and bring it back when the
// owner presses Home while CleanFrame is in front.
//
// Why it is cooperative rather than observant: on a 2019 Tizen 5.0 TV the local app API
// answers only for apps installed through developer mode. CleanFrame itself reports
// running/visible correctly, but every store app and Samsung's own home screen answer 404.
// The service therefore cannot see what covers the launcher, and relaunching on "not
// visible" alone would fight Netflix and every other app, which is exactly what the
// previous third-party launcher did on this TV.
//
// Instead CleanFrame announces a handover before it opens an app (POST /aside), and the
// service stands aside until CleanFrame is visible again. A disappearance without a
// handover is a Home press, and only that is reclaimed.
//
// Escape hatch: three reclaims inside a minute are treated as the owner deliberately
// wanting Samsung's menu (for example to delete apps), and the service stands down for
// five minutes.
//
// Derived from the AeroTizen watcher service (MIT, https://github.com/helalaou/AeroTizen),
// reduced and reworked for this TV's limitations.

var http = require('http');
var url = require('url');

var SELF = 'nClrkHome1.FrameHome';

var POLL = 900;
var BOOT_DELAY = 4000;               // let the TV settle before the first launch
var LAUNCH_GAP = 4000;               // ignore the screen right after our own launch
var HIDDEN_GRACE = 1200;             // Samsung's home screen needs a moment to appear
var BURST_WINDOW = 60000;
var BURST_LIMIT = 3;
var STAND_DOWN = 300000;             // five minutes hands-off after a burst
var REQUEST_TIMEOUT = 1500;
var CONTROL_PORT = 47791;            // loopback only; CleanFrame and diagnostics

var started = false;
var stopped = false;
var timer = null;
var bootTimer = null;
var server = null;
var busy = false;
var launches = [];                   // timestamps of our own launches
var standDownUntil = 0;
var aside = false;                   // CleanFrame handed the screen to another app
var asideApp = null;
var hiddenSince = 0;
var selfWasVisible = null;

// Diagnostics, read over the developer connection. Loopback only and read-only.
var diag = { startedAt: null, ticks: 0, launchCalls: 0, lastEvent: null, selfStatus: null, inputs: 'not probed' };

/* Read-only capability probe for video sources, to establish whether the documented
   systeminfo VIDEOSOURCE property returns usable data on this TV before any input-switching
   feature is designed around it. This only reads; it never changes the source. */
function probeInputs() {
  if (typeof tizen === 'undefined' || !tizen.systeminfo) {
    diag.inputs = 'unsupported: no systeminfo API';
    return;
  }
  try {
    tizen.systeminfo.getPropertyValue('VIDEOSOURCE', function (info) {
      var out = { connected: [], all: [] };
      try {
        (info.connected || []).forEach(function (src) {
          out.connected.push({ type: src.type, number: src.number, name: src.name || null });
        });
        (info.unconnected || info.disconnected || []).forEach(function (src) {
          out.all.push({ type: src.type, number: src.number, state: 'unconnected' });
        });
        diag.inputs = out;
      } catch (e) {
        diag.inputs = 'reply unreadable: ' + (e && e.message);
      }
      note('video sources: ' + JSON.stringify(diag.inputs).slice(0, 300));
    }, function (err) {
      diag.inputs = 'query failed: ' + (err && (err.name || err.message));
      note(diag.inputs);
    });
  } catch (e) {
    diag.inputs = 'threw: ' + (e && e.message);
    note(diag.inputs);
  }
}

var LOG = '/opt/usr/home/owner/apps_rw/nClrkHome1/data/cf-service.log';
var fs = null;
try { fs = require('fs'); } catch (e) { fs = null; }
function note(message) {
  diag.lastEvent = message;
  if (!fs) { return; }
  try {
    fs.appendFileSync(LOG, new Date().toISOString() + ' ' + message + '\n');
  } catch (e) { /* A full or read-only data directory must not stop the service. */ }
}

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
function selfStatus(cb) {
  get('/api/v2/applications/' + encodeURIComponent(SELF), function (value) {
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
  // Repeated reclaims mean the owner wants Samsung's menu, or our launch is not sticking.
  // Either way, stop fighting the screen for a while.
  if (launches.length >= BURST_LIMIT) {
    launches = [];
    standDownUntil = now + STAND_DOWN;
    note('standing down for five minutes after repeated reclaims');
    return;
  }
  launches.push(now);
  diag.launchCalls += 1;
  note('launch attempt (' + why + ')');
  try {
    tizen.application.launch(SELF, function () { note('launch ok (' + why + ')'); },
      function (err) { note('launch refused (' + why + '): ' + (err && (err.name || err.message))); });
  } catch (e) {
    // A failed launch is retried by the next poll, within the burst limit.
    note('launch threw (' + why + '): ' + (e && e.message));
  }
}

function lastLaunch() { return launches.length ? launches[launches.length - 1] : 0; }

function tick() {
  if (stopped || busy) { return; }
  var now = Date.now();
  diag.ticks += 1;
  if (now < standDownUntil) { return; }
  busy = true;
  var done = false;
  var watchdog = setTimeout(release, REQUEST_TIMEOUT * 2);
  function release() {
    if (done) { return; }
    done = true;
    clearTimeout(watchdog);
    busy = false;
  }
  selfStatus(function (me) {
    if (done || stopped) { release(); return; }
    diag.selfStatus = me ? ('visible=' + me.visible + ' running=' + me.running) : 'unavailable';
    if (!me) { release(); return; }                    // unknown state: never act
    var at = Date.now();
    if (me.visible) {
      // Back in front: the handover is over and the hidden timer restarts from scratch.
      if (aside) { note('handover cleared (' + asideApp + ')'); }
      aside = false; asideApp = null; hiddenSince = 0; selfWasVisible = true;
      release(); return;
    }
    if (selfWasVisible !== false) { hiddenSince = at; }
    selfWasVisible = false;
    if (aside) { release(); return; }                  // the owner opened an app: leave it alone
    if (at - hiddenSince < HIDDEN_GRACE) { release(); return; }
    if (at - lastLaunch() < LAUNCH_GAP) { release(); return; }
    launch('hidden without a handover');
    release();
  });
}

function control(req, res) {
  var parsed = url.parse(req.url, true);
  if (parsed.pathname === '/aside') {
    // CleanFrame is about to open an app. Stand aside until it is visible again.
    aside = true;
    asideApp = typeof parsed.query.id === 'string' ? parsed.query.id.slice(0, 120) : 'unknown';
    hiddenSince = 0;
    note('handover announced (' + asideApp + ')');
  } else if (parsed.pathname === '/home') {
    aside = false; asideApp = null; hiddenSince = 0;
    note('launcher reported itself in front');
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    service: 'cleanframe-start', self: SELF,
    startedAt: diag.startedAt, ticks: diag.ticks, launchCalls: diag.launchCalls,
    lastEvent: diag.lastEvent, selfStatus: diag.selfStatus, inputs: diag.inputs,
    aside: aside, asideApp: asideApp,
    standDownFor: Math.max(0, standDownUntil - Date.now()),
    tizenApi: typeof tizen !== 'undefined', fsAvailable: !!fs
  }));
}

module.exports.onStart = function () {
  if (started) { return; }
  started = true;
  diag.startedAt = new Date().toISOString();
  note('service onStart; tizen api ' + (typeof tizen !== 'undefined' ? 'present' : 'MISSING') +
       ', fs ' + (fs ? 'present' : 'MISSING'));
  try {
    server = http.createServer(control);
    server.listen(CONTROL_PORT, '127.0.0.1');
  } catch (e) {
    server = null;
    note('control endpoint unavailable: ' + (e && e.message));
  }
  probeInputs();
  bootTimer = setTimeout(function () {
    if (stopped) { return; }
    selfStatus(function (me) {
      if (stopped) { return; }
      note('boot check: ' + (me ? 'visible=' + me.visible + ' running=' + me.running : 'status unavailable'));
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
  if (server) {
    try { server.close(); } catch (e) { /* nothing left to do on exit */ }
    server = null;
  }
};
