// StreamElements Custom Widget: paste into the JS tab.
/* global window, document, navigator, URL, URLSearchParams */
window.addEventListener('onWidgetLoad', function (event) {
  var frame = document.getElementById('brobotOverlayFrame');
  var error = document.getElementById('brobotOverlayError');
  var fields = event && event.detail && event.detail.fieldData ? event.detail.fieldData : {};
  var overlayUrl = String(fields.overlayUrl || '').trim();
  var messages = (navigator.language || '').toLowerCase().indexOf('de') === 0
    ? 'Die BroBot-Overlay-URL fehlt oder ist ungültig.'
    : 'The BroBot overlay URL is missing or invalid.';

  try {
    var parsedUrl = new URL(overlayUrl);
    var token = new URLSearchParams(parsedUrl.hash.slice(1)).get('token');
    if (parsedUrl.protocol !== 'https:' || !token) throw new Error('Invalid overlay URL.');
  } catch {
    frame.style.display = 'none';
    error.textContent = messages;
    error.style.display = 'block';
    return;
  }

  frame.src = parsedUrl.href;
});
