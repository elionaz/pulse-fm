var BASE = 'https://ws.audioscrobbler.com/2.0/';

// Last.fm uses several MD5-named placeholder PNGs when no album art exists.
// Detected hashes (collected over time):
var PLACEHOLDER_HASHES = [
  '2a96cbd8b46e442fc41c2b86b821562f',
  '4128a6eb29f94943c9d206c08e625904',
  'c6f59c1e5e7240a4c0d427abd71f3dbb',
];

function isPlaceholderUrl(url) {
  if (!url) return true;
  for (var i = 0; i < PLACEHOLDER_HASHES.length; i++) {
    if (url.indexOf(PLACEHOLDER_HASHES[i]) !== -1) return true;
  }
  return false;
}

function pickLargestImage(images) {
  if (!images || !images.length) return null;
  var order = ['extralarge', 'large', 'medium', 'small'];
  for (var i = 0; i < order.length; i++) {
    for (var j = 0; j < images.length; j++) {
      if (images[j].size === order[i] && images[j]['#text']) {
        return images[j]['#text'];
      }
    }
  }
  return null;
}

function jsonGet(url, callback) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.timeout = 15000;
  xhr.onload = function() {
    if (xhr.status !== 200) return callback(new Error('http ' + xhr.status));
    try {
      callback(null, JSON.parse(xhr.responseText));
    } catch (e) {
      callback(new Error('parse: ' + e.message));
    }
  };
  xhr.onerror = function()   { callback(new Error('network')); };
  xhr.ontimeout = function() { callback(new Error('timeout')); };
  xhr.send();
}

function getAlbumImage(apiKey, artist, album, callback) {
  var url = BASE +
    '?method=album.getinfo' +
    '&artist=' + encodeURIComponent(artist) +
    '&album=' + encodeURIComponent(album) +
    '&api_key=' + encodeURIComponent(apiKey) +
    '&format=json';
  jsonGet(url, function(err, data) {
    if (err) return callback(err);
    var img = data && data.album && pickLargestImage(data.album.image);
    if (isPlaceholderUrl(img)) return callback(null, null);
    callback(null, img);
  });
}

function getArtistImage(apiKey, artist, callback) {
  var url = BASE +
    '?method=artist.getinfo' +
    '&artist=' + encodeURIComponent(artist) +
    '&api_key=' + encodeURIComponent(apiKey) +
    '&format=json';
  jsonGet(url, function(err, data) {
    if (err) return callback(err);
    var img = data && data.artist && pickLargestImage(data.artist.image);
    if (isPlaceholderUrl(img)) return callback(null, null);
    callback(null, img);
  });
}

// Sequentially try album → artist. Returns null if both fail; PKJS then tells
// the watch to render its bundled fallback bitmap.
function resolveFallbackImage(apiKey, artist, album, callback) {
  function tryArtist() {
    if (!artist) return callback(null);
    getArtistImage(apiKey, artist, function(err, img) {
      if (err)  console.log('[pulse.fm] lastfm: artist.getInfo err: ' + err.message);
      if (img) {
        console.log('[pulse.fm] lastfm: artist image ' + img);
        return callback(img);
      }
      console.log('[pulse.fm] lastfm: artist image missing too');
      callback(null);
    });
  }

  if (!artist || !album) return tryArtist();
  getAlbumImage(apiKey, artist, album, function(err, img) {
    if (err)  console.log('[pulse.fm] lastfm: album.getInfo err: ' + err.message);
    if (img) {
      console.log('[pulse.fm] lastfm: album image ' + img);
      return callback(img);
    }
    console.log('[pulse.fm] lastfm: album image missing, trying artist');
    tryArtist();
  });
}

function getRecentTrack(username, apiKey, callback) {
  if (!username || !apiKey) {
    return callback(new Error('missing credentials'));
  }
  var url = BASE +
    '?method=user.getrecenttracks' +
    '&user=' + encodeURIComponent(username) +
    '&api_key=' + encodeURIComponent(apiKey) +
    '&format=json' +
    '&limit=1';

  jsonGet(url, function(err, data) {
    if (err) return callback(err);
    var tracks = data && data.recenttracks && data.recenttracks.track;
    if (!tracks) return callback(new Error('no tracks'));
    var track = Array.isArray(tracks) ? tracks[0] : tracks;
    if (!track) return callback(new Error('no track'));

    var nowPlaying = track['@attr'] && track['@attr'].nowplaying === 'true';
    var ts = track.date && track.date.uts ? parseInt(track.date.uts, 10) : 0;
    var artist = ((track.artist && track.artist['#text']) || '').trim();
    var album  = ((track.album && track.album['#text'])  || '').trim();
    var title  = (track.name || '').trim();

    var trackImg = pickLargestImage(track.image);

    var base = {
      title:      title.slice(0, 99),
      artist:     artist.slice(0, 99),
      album:      album.slice(0, 99),
      nowPlaying: !!nowPlaying,
      timestamp:  ts,
    };

    if (!isPlaceholderUrl(trackImg)) {
      console.log('[pulse.fm] lastfm: track image ' + trackImg);
      base.imageUrl = trackImg;
      return callback(null, base);
    }

    console.log('[pulse.fm] lastfm: track image missing, resolving fallback chain');
    resolveFallbackImage(apiKey, artist, album, function(img) {
      base.imageUrl = img;
      callback(null, base);
    });
  });
}

module.exports = { getRecentTrack: getRecentTrack };
