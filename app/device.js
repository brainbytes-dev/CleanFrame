/* Public Tizen application APIs. No Mac server, network address or credentials. */
(function () {
  'use strict';
  /* IDs verified against this TV's own app list. "Primary" entries bypass the name filter
     below, which is why CANAL+ is listed: its package name contains "Launcher" and the
     filter would otherwise hide a genuinely installed app. */
  var IDS = {
    netflix: 'org.tizen.netflix-app', youtube: '9Ur5IzDKqV.TizenYouTube',
    primevideo: 'evKhCgZelL.AmazonIgnitionLauncher2', disneyplus: 'MCmYXNxgcu.DisneyPlus',
    appletv: 'com.samsung.tv.aria-video', spotify: 'rJeHak5zRg.Spotify',
    ard: 'SrAoJxGQUf.ARD', zdf: 'yPSlpvfeTf.ZDFmediathek', arte: 'aLlph042JZ.arte',
    canalplus: 'QmpwflxWdt.CanalPlusLauncher'
  };
  var STREAMING = ['kIciSQlYEM.plex', 'CU6377fECH.player', 'testssiptv.SSIPTV'];
  var CONSUMER_SYSTEM = ['org.tizen.browser', 'com.samsung.tv.gallery'];
  var EXTRA_BRANDS = {'rJeHak5zRg.Spotify': 'spotify'};
  /* Samsung plumbing and bloat that should never appear as a choosable app. Package IDs are
     per-TV, so these are this TV's actual e-Manual, privacy and promotion packages. */
  var INTERNAL = ['adplatform.ADPlayer', 'WykOS4t4F0.cmsWebApp', 'sOCceB3uAn.emanual',
    'ZODRT12q2l.WebAccountExtension', 'ByJlgt0XeD.CastSettingsApp', 'jLU2jKvbyN.PrivacyChoices',
    'yL49PNFmjW.PromotionApp', 'DclHome001.Home'];
  var SELF = 'nClrkHome1.FrameHome';
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
  function launchApp(id, done) {
    if (!api()) { unavailable(done); return; }
    var finish = bounded(done);
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
  window.FrameDevice = { launch: launch, launchApp: launchApp, art: art, home: home, settings: settings, apps: apps };
}());
