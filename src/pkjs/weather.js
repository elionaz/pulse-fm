function getCurrent(lat, lng, callback) {
  var url = 'https://api.open-meteo.com/v1/forecast' +
    '?latitude=' + lat +
    '&longitude=' + lng +
    '&current=temperature_2m,weather_code';

  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.timeout = 15000;
  xhr.onload = function() {
    if (xhr.status !== 200) return callback(new Error('http ' + xhr.status));
    try {
      var data = JSON.parse(xhr.responseText);
      if (!data.current) return callback(new Error('no current'));
      callback(null, {
        temperature: data.current.temperature_2m,
        weatherCode: data.current.weather_code,
      });
    } catch (e) {
      callback(new Error('parse: ' + e.message));
    }
  };
  xhr.onerror = function() { callback(new Error('network')); };
  xhr.ontimeout = function() { callback(new Error('timeout')); };
  xhr.send();
}

module.exports = { getCurrent: getCurrent };
