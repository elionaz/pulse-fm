// Adapted from alex523ap/Playback-for-Spotify (MIT-style watchapp).
// Pipeline: download JPEG → decode (jpeg-js) → resize+quantize to Pebble 8bpp
// (0xC0|RRGGBB, 2 bits per channel) → chunked AppMessage.

var jpeg = require('jpeg-js');

// Pebble allocates bitmap rows aligned to 4 bytes. Keep target dims as
// multiples of 4 so PKJS can send pixel data as one contiguous blob and
// the watch's row stride matches naturally.
var TARGET_W = 128;
var TARGET_H = 128;
var CHUNK_BYTES = 2000;

// Single guard covering the whole pipeline. Prevents two transfers from
// interleaving their chunks. We do NOT dedup by URL: same album across
// multiple tracks costs an extra ~17KB transfer per refresh, but guarantees
// the cover always reflects the current track's resolved image.
//
// We also track when the flag was set: the phone OS can suspend PKJS
// mid-XHR-callback, leaving `inProgress` permanently true. If the flag is
// older than STUCK_TIMEOUT_MS, we assume the prior pipeline died and force
// a fresh start instead of skipping forever.
var inProgress = false;
var inProgressStart = 0;
var STUCK_TIMEOUT_MS = 30000;

function downloadAndSend(url) {
  if (!url) {
    console.log('[pulse.fm] image: no url, skipping');
    return;
  }
  if (inProgress) {
    var elapsed = Date.now() - inProgressStart;
    if (elapsed < STUCK_TIMEOUT_MS) {
      console.log('[pulse.fm] image: pipeline busy (' + Math.round(elapsed/1000) + 's), skipping');
      return;
    }
    console.log('[pulse.fm] image: prior transfer stuck ' + Math.round(elapsed/1000) + 's, force-resetting');
  }
  inProgress = true;
  inProgressStart = Date.now();
  console.log('[pulse.fm] image: downloading ' + url);

  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.responseType = 'arraybuffer';
  xhr.timeout = 20000;
  xhr.onload = function() {
    if (xhr.status === 200) {
      console.log('[pulse.fm] image: downloaded ' + xhr.response.byteLength + ' bytes');
      processJpeg(new Uint8Array(xhr.response));
    } else {
      inProgress = false;
      sendError('img http ' + xhr.status);
    }
  };
  xhr.onerror   = function() { inProgress = false; sendError('img network'); };
  xhr.ontimeout = function() { inProgress = false; sendError('img timeout'); };
  xhr.send();
}

function processJpeg(bytes) {
  try {
    var raw = jpeg.decode(bytes, { useTArray: true });
    console.log('[pulse.fm] image: jpeg decoded ' + raw.width + 'x' + raw.height);
    var quantized = resizeAndQuantize(raw.data, raw.width, raw.height, TARGET_W, TARGET_H);
    sendImageToWatch(quantized, TARGET_W, TARGET_H);
  } catch (e) {
    inProgress = false;
    sendError('img decode: ' + e.message);
  }
}

// Center-crop scale (cover): fill destination, crop overflow.
function resizeAndQuantize(srcPixels, sw, sh, dw, dh) {
  var dst = new Uint8Array(dw * dh);
  var scale = Math.max(dw / sw, dh / sh);
  var scaledW = sw * scale, scaledH = sh * scale;
  var ox = (dw - scaledW) / 2, oy = (dh - scaledH) / 2;

  for (var y = 0; y < dh; y++) {
    for (var x = 0; x < dw; x++) {
      var sx = Math.floor((x - ox) / scale);
      var sy = Math.floor((y - oy) / scale);
      var r = 0, g = 0, b = 0;
      if (sx >= 0 && sx < sw && sy >= 0 && sy < sh) {
        var i = (sy * sw + sx) * 4;
        r = srcPixels[i]; g = srcPixels[i + 1]; b = srcPixels[i + 2];
      }
      dst[y * dw + x] = 0xC0 | ((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6);
    }
  }
  return dst;
}

function sendImageToWatch(data, w, h) {
  var totalChunks = Math.ceil(data.length / CHUNK_BYTES);
  console.log('[pulse.fm] image: sending ' + w + 'x' + h + ' (' + data.length + 'B, ' + totalChunks + ' chunks)');
  Pebble.sendAppMessage({
    'ImageWidth':       w,
    'ImageHeight':      h,
    'ImageDataSize':    data.length,
    'ImageChunksTotal': totalChunks,
  }, function() {
    sendChunk(data, 0, totalChunks);
  }, function() {
    inProgress = false;
    sendError('img header fail');
  });
}

function sendChunk(data, index, totalChunks) {
  var start = index * CHUNK_BYTES;
  var end   = Math.min(start + CHUNK_BYTES, data.length);
  var chunk = [];
  for (var i = start; i < end; i++) chunk.push(data[i]);

  function onSuccess() {
    if (index + 1 < totalChunks) {
      sendChunk(data, index + 1, totalChunks);
    } else {
      inProgress = false;
      console.log('[pulse.fm] image: transfer complete');
    }
  }

  Pebble.sendAppMessage({
    'ImageChunkIndex': index,
    'ImageChunkData':  chunk,
  }, onSuccess, function() {
    // single retry then give up
    setTimeout(function() {
      Pebble.sendAppMessage({
        'ImageChunkIndex': index,
        'ImageChunkData':  chunk,
      }, onSuccess, function() {
        inProgress = false;
        sendError('img chunk fail @' + index);
      });
    }, 500);
  });
}

function sendError(msg) {
  console.log('[pulse.fm] ' + msg);
  try { Pebble.sendAppMessage({ 'ErrorMsg': msg }); } catch (e) {}
}

function forceReset() {
  if (inProgress) {
    console.log('[pulse.fm] image: force reset (was in progress)');
    inProgress = false;
  }
}

module.exports = {
  sendImageFromUrl: downloadAndSend,
  isTransferring:   function() { return inProgress; },
  // forces the inProgress flag to false; useful when settings change
  // and we want to drop any potentially-stuck state.
  resetCache:       forceReset,
};
