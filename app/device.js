/* Public Tizen application APIs. No Mac server, network address or credentials. */
(function () {
  'use strict';
  /* IDs verified against this TV's own app list. "Primary" entries bypass the name filter
     below, which is why CANAL+ is listed: its package name contains "Launcher" and the
     filter would otherwise hide a genuinely installed app. */
  /* Order here is the ranking used to fill an unconfigured Home (nine slots). Everything
     installed stays reachable under All apps regardless; this only decides what gets a
     Home slot by default. ARD, ZDF and Plex are deliberately not ranked: owner's choice. */
  var IDS = {
    netflix: 'org.tizen.netflix-app', youtube: '9Ur5IzDKqV.TizenYouTube',
    primevideo: 'evKhCgZelL.AmazonIgnitionLauncher2', disneyplus: 'MCmYXNxgcu.DisneyPlus',
    appletv: 'com.samsung.tv.aria-video', spotify: 'rJeHak5zRg.Spotify',
    arte: 'aLlph042JZ.arte', canalplus: 'QmpwflxWdt.CanalPlusLauncher',
    sunrise: 'CU6377fECH.player'
  };
  var STREAMING = ['testssiptv.SSIPTV'];
  var CONSUMER_SYSTEM = ['org.tizen.browser', 'com.samsung.tv.gallery'];
  var EXTRA_BRANDS = {'rJeHak5zRg.Spotify': 'spotify'};
  /* Samsung plumbing and bloat that should never appear as a choosable app. Package IDs are
     per-TV, so these are this TV's actual e-Manual, privacy and promotion packages. */
  var INTERNAL = ['adplatform.ADPlayer', 'WykOS4t4F0.cmsWebApp', 'sOCceB3uAn.emanual',
    'ZODRT12q2l.WebAccountExtension', 'ByJlgt0XeD.CastSettingsApp', 'jLU2jKvbyN.PrivacyChoices',
    'yL49PNFmjW.PromotionApp', 'DclHome001.Home'];
  var SELF = 'nClrkHome1.FrameHome';
  var SERVICE = 'nClrkHome1.Watch';
  function api() { return window.tizen && window.tizen.application; }
  function unavailable(done) {
    done({ message: 'Open CleanFrame on the TV to use this control.', detail: 'The web preview cannot control the TV.' });
  }
  function failure(err) {
    return { message: 'The TV could not open this screen.', detail: err && (err.message || err.name) || 'Try again, or press the remote’s Home button to return to CleanFrame.' };
  }
  function bounded(done) {
    var finished = false, timer = setTimeout(function () { finish({ message: 'The TV did not respond. Please try again.' }); }, 8000);
    function finish(err, value) { if (finished) return; finished = true; clearTimeout(timer); done(err, value); }
    return finish;
  }
  /* Tell the start service that this launcher is handing the screen to another app, so it
     does not treat the disappearance as a Home press and pull the launcher back over it.
     Fire and forget on the loopback address: if the service is not running, nothing here
     changes. See app/service/index.js for why the handover has to be announced. */
  function tellService(path) {
    try {
      var request = new XMLHttpRequest();
      request.open('GET', 'http://127.0.0.1:47791' + path, true);
      request.timeout = 1200;
      request.onerror = function () {};
      request.ontimeout = function () {};
      request.send();
    } catch (err) { /* The service is optional; never block a launch on it. */ }
  }
  function launchApp(id, done) {
    if (!api()) { unavailable(done); return; }
    var finish = bounded(done);
    tellService('/aside?id=' + encodeURIComponent(id));
    try { api().launch(id, function () { finish(null); }, function (err) { finish(failure(err)); }); }
    catch (err) { finish(failure(err)); }
  }
  function launch(brand, done) {
    if (!IDS[brand]) { done({message: 'This app has no launch target.'}); return; }
    launchApp(IDS[brand], done);
  }
  function art(done) {
    if (!api()) { unavailable(done); return; }
    var finish = bounded(done);
    try {
      var data = [new tizen.ApplicationControlData('mode', ['fullscreen']), new tizen.ApplicationControlData('requester', ['mobile'])];
      var control = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/default', null, null, null, data);
      api().launchAppControl(control, 'org.tizen.art-app', function () { finish(null); }, function (err) { finish(failure(err)); });
    } catch (err) { finish(failure(err)); }
  }
  function home(done) { launchApp('com.samsung.tv.csfs', done); }
  function settings(done) { launchApp('com.samsung.tv.coba.setting', done); }
  function apps(done) {
    if (!api()) { unavailable(done); return; }
    var finish = bounded(done);
    try {
      api().getAppsInfo(function (list) {
        var known = {}, seen = {}, result = [];
        Object.keys(IDS).forEach(function (brand) { known[IDS[brand]] = brand; });
        list.forEach(function (a) {
          var primary = !!known[a.id], stream = STREAMING.indexOf(a.id) >= 0;
          // Trust the TV: Tizen's own "show" flag already marks what belongs in an app menu.
          // The previous hand-kept package-shape rule hid genuinely installed apps, and its
          // name filter dropped anything containing "launcher" (for example CANAL+).
          var listed = a.show !== false && a.show !== 'false';
          if (a.id === SELF || INTERNAL.indexOf(a.id) >= 0 || seen[a.id] || !a.name) return;
          if (!primary && !stream && !listed && CONSUMER_SYSTEM.indexOf(a.id) < 0) return;
          if (!primary && /(?:\bservice\b|worker|plugin|sdk|factory|daemon)/i.test(a.name + ' ' + a.id)) return;
          if (/-dummy$/.test(a.id) || a.id === 'com.samsung.tv.cobalt-yt') return;
          seen[a.id] = true;
          result.push({ appId: a.id, name: a.name, brand: known[a.id] || EXTRA_BRANDS[a.id] || '', icon: a.iconPath || '', rank: primary ? Object.keys(IDS).indexOf(known[a.id]) : (stream ? 20 : 30) });
        });
        result.sort(function (a, b) { return a.rank - b.rank || a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
        finish(null, result);
      }, function (err) { finish(failure(err)); });
    } catch (err) { finish(failure(err)); }
  }
  /* Start our own background service, and tell it the launcher is in front.
     This TV does not honour on-boot for a web service, verified after a cold start, so the
     service would otherwise never run and nothing would bring the launcher back after a
     Home press. Starting it here means it is running for as long as the TV stays on.
     Launching a service that is already running is a no-op, and a failure is ignored: the
     launcher itself must keep working without it. */
  function startService() {
    if (!api()) { return; }
    try {
      api().launch(SERVICE, function () { tellService('/home'); }, function () {});
    } catch (err) { /* The service is optional. */ }
  }

  window.FrameDevice = {
    launch: launch, launchApp: launchApp, art: art, home: home, settings: settings,
    apps: apps, startService: startService
  };
  startService();
  // Re-ensure the service whenever the launcher comes back to the front, in case it was
  // reaped while another app had the screen.
  if (window.document && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { startService(); }
    }, false);
  }
}());
