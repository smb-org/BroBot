// StreamElements Custom Widget: paste into the JS tab.
/* global window, document, navigator, URL, URLSearchParams */
function buildValidatedOverlaySrc(overlayUrl, brobotAddress) {
  try {
    var address = String(brobotAddress || '').trim();
    var addressUrl = new URL(address);
    if (addressUrl.protocol !== 'https:' || addressUrl.username || addressUrl.password ||
        addressUrl.pathname !== '/' || addressUrl.search || addressUrl.hash ||
        address.indexOf('?') !== -1 || address.indexOf('#') !== -1) return null;

    var source = String(overlayUrl || '').trim();
    var parsedUrl = new URL(source);
    var sourceWithoutFragment = source.split('#', 1)[0];
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password ||
        parsedUrl.origin !== addressUrl.origin ||
        (parsedUrl.pathname !== '/overlay' && parsedUrl.pathname !== '/overlay.html') ||
        parsedUrl.search || sourceWithoutFragment.indexOf('?') !== -1) return null;

    var fragment = new URLSearchParams(parsedUrl.hash.slice(1));
    var tokens = fragment.getAll('token');
    var elements = fragment.getAll('element');
    if ((fragment.size !== 1 && fragment.size !== 2) || tokens.length !== 1 || elements.length > 1 ||
        (fragment.size === 2 && elements.length !== 1) || !/^[A-Za-z0-9_-]{43}$/.test(tokens[0])) return null;
    if (elements.length === 1 && !/^[A-Za-z0-9_-]{1,64}$/.test(elements[0])) return null;

    var safeUrl = new URL(parsedUrl.pathname, addressUrl.origin);
    var safeFragment = { token: tokens[0] };
    if (elements.length === 1) safeFragment.element = elements[0];
    safeUrl.hash = new URLSearchParams(safeFragment).toString();
    return safeUrl.href;
  } catch {
    return null;
  }
}

window.addEventListener('onWidgetLoad', function (event) {
  var frame = document.getElementById('brobotOverlayFrame');
  var error = document.getElementById('brobotOverlayError');
  var fields = event && event.detail && event.detail.fieldData ? event.detail.fieldData : {};
  var overlayUrl = String(fields.overlayUrl || '').trim();
  var brobotAddress = String(fields.brobotAddress || '').trim();
  var overlaySrc = buildValidatedOverlaySrc(overlayUrl, brobotAddress);

  if (overlaySrc === null) {
    frame.style.display = 'none';
    error.textContent = (navigator.language || '').toLowerCase().indexOf('de') === 0
      ? 'Bitte prüfe die BroBot-Adresse und Overlay-URL: HTTPS, dieselbe Adresse, /overlay oder /overlay.html und ein gültiges Token im Fragment sind erforderlich.'
      : 'Check the BroBot address and overlay URL. Use the same HTTPS address, /overlay or /overlay.html, and a valid token after #.';
    error.style.display = 'block';
    return;
  }

  error.style.display = 'none';
  frame.style.display = 'block';
  frame.src = overlaySrc;
});
