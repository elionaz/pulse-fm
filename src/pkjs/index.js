var Clay        = require('pebble-clay');
var clayConfig  = require('./clay-config');
var lastfm      = require('./lastfm');
var weather     = require('./weather');
var imageXfer   = require('./image_transfer');

// Default Clay handlers: opens config page, saves submitted values to
// localStorage['clay-settings'], and forwards them to the watch via AppMessage.
var clay = new Clay(clayConfig);

// ----- read settings from Clay's localStorage -----

function readSettings() {
  var raw = {};
  try {
    raw = JSON.parse(localStorage.getItem('clay-settings')) || {};
  } catch (e) {}
  return {
    username: String(raw.LastfmUsername || '').trim(),
    apiKey:   String(raw.LastfmApiKey   || '').trim(),
    mode:     String(raw.Mode || 'realtime'),
  };
}

var PERIOD_BY_MODE = { top7: '7day', top30: '1month' };

// ----- polling -----

function pollAll() {
  var s = readSettings();
  if (!s.username || !s.apiKey) {
    console.log('[pulse.fm] no credentials yet — open settings');
    return;
  }
  console.log('[pulse.fm] polling for user ' + s.username + ' mode=' + s.mode);
  fetchAndPush(s);
  fetchWeather();
}

function fetchAndPush(s) {
  function handle(err, data) {
    if (err) {
      console.log('[pulse.fm] fetch err: ' + err.message);
      sendError('lastfm: ' + err.message);
      return;
    }
    if (!data) return;

    console.log('[pulse.fm] data: ' + data.artist + ' - ' + data.title +
                (data.nowPlaying ? ' (now)' : ''));
    Pebble.sendAppMessage({
      'TrackTitle':       data.title,
      'TrackArtist':      data.artist,
      'TrackAlbum':       data.album,
      'TrackNowPlaying':  data.nowPlaying ? 1 : 0,
      'TrackTimestamp':   data.timestamp || 0,
    }, function() {
      if (data.imageUrl) {
        imageXfer.sendImageFromUrl(data.imageUrl);
      } else {
        console.log('[pulse.fm] no image url after fallbacks, telling watch to use bundled');
        Pebble.sendAppMessage({ 'ImageSkipped': 1 });
        imageXfer.resetCache();
      }
    }, function() {
      console.log('[pulse.fm] track msg failed');
    });
  }

  var period = PERIOD_BY_MODE[s.mode];
  if (period) {
    lastfm.getTopAlbum(s.username, s.apiKey, period, handle);
  } else {
    lastfm.getRecentTrack(s.username, s.apiKey, handle);
  }
}

function fetchWeather() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(function(pos) {
    weather.getCurrent(pos.coords.latitude, pos.coords.longitude, function(err, data) {
      if (err) {
        console.log('[pulse.fm] weather err: ' + err.message);
        return;
      }
      console.log('[pulse.fm] weather: ' + data.temperature + '°C code=' + data.weatherCode);
      Pebble.sendAppMessage({
        'Temperature': Math.round(data.temperature),
        'WeatherCode': data.weatherCode | 0,
      });
    });
  }, function(err) {
    console.log('[pulse.fm] geo err: ' + err.message);
  }, { timeout: 10000, maximumAge: 600000 });
}

function sendError(msg) {
  try { Pebble.sendAppMessage({ 'ErrorMsg': msg }); } catch (e) {}
}

// ----- pebble events -----

Pebble.addEventListener('ready', function() {
  console.log('[pulse.fm] PKJS ready');
  // Initial fetch shortly after boot. From here on, the watch drives the
  // refresh schedule by sending RefreshNow on its own tick handler — that's
  // more reliable than setInterval, since PKJS can be suspended between
  // messages on the phone.
  setTimeout(pollAll, 1500);
});

Pebble.addEventListener('appmessage', function(e) {
  if (e.payload && e.payload.RefreshNow) {
    console.log('[pulse.fm] refresh requested by watch');
    pollAll();
  }
});

// Clay's auto handler runs first on webviewclosed: it parses, saves to
// localStorage['clay-settings'], and sends settings to the watch. We just
// trigger an immediate fresh fetch with the new credentials.
Pebble.addEventListener('webviewclosed', function(e) {
  if (!e || !e.response) return;
  console.log('[pulse.fm] settings updated, re-polling');
  imageXfer.resetCache();
  setTimeout(pollAll, 500);
});
