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
  };
}

// ----- polling -----

function pollAll() {
  var s = readSettings();
  if (!s.username || !s.apiKey) {
    console.log('[pulse.fm] no credentials yet — open settings');
    return;
  }
  console.log('[pulse.fm] polling for user ' + s.username);
  fetchTrack(s);
  fetchWeather();
}

function fetchTrack(s) {
  lastfm.getRecentTrack(s.username, s.apiKey, function(err, track) {
    if (err) {
      console.log('[pulse.fm] track err: ' + err.message);
      sendError('lastfm: ' + err.message);
      return;
    }
    if (!track) return;
    console.log('[pulse.fm] track: ' + track.artist + ' - ' + track.title +
                (track.nowPlaying ? ' (now)' : ''));
    Pebble.sendAppMessage({
      'TrackTitle':       track.title,
      'TrackArtist':      track.artist,
      'TrackAlbum':       track.album,
      'TrackNowPlaying':  track.nowPlaying ? 1 : 0,
      'TrackTimestamp':   track.timestamp || 0,
    }, function() {
      if (track.imageUrl) {
        imageXfer.sendImageFromUrl(track.imageUrl);
      } else {
        console.log('[pulse.fm] no image url after fallbacks, telling watch to use bundled');
        Pebble.sendAppMessage({ 'ImageSkipped': 1 });
        imageXfer.resetCache();
      }
    }, function() {
      console.log('[pulse.fm] track msg failed');
    });
  });
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
