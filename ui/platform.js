/* Portal support is optional: local and desktop racing never wait for an ad SDK. */
(function () {
  let portal = /(^|\.)crazygames\.com$/i.test(location.hostname);
  try { portal ||= /(^|\.)crazygames\.com$/i.test(new URL(document.referrer).hostname); } catch {}
  const desktop = location.protocol === 'kbapp:';
  let ready = Promise.resolve();
  if (portal && !window.CrazyGames?.SDK) {
    ready = new Promise(resolve => {
      const script = document.createElement('script');
      script.src = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
      script.onload = script.onerror = resolve;
      document.head.append(script);
      setTimeout(resolve, 4000);
    });
  }
  window.KartBlitzPlatform = Object.freeze({ portal, desktop, ready });
})();
