/* Tools are opened from the README, never from player menus or saved opt-ins. */
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const ml = params.get('tool') === 'ml';
  const official = params.get('tool') === 'official-ml';
  const models = params.get('tool') === 'ai-models';
  const track = params.get('admin') === 'track';
  const debug = params.get('debug') === '1' || params.get('netDebug') === '1';
  window.KartBlitzTools = Object.freeze({ ml, official, models, track, debug });

  if (official || models) {
    document.title = models ? 'AI Models · KartBlitz' : 'Official ML for AI · KartBlitz';
    const css = document.createElement('link'); css.rel='stylesheet'; css.href=models?'ui/ai-models.css':'ui/official-ml.css'; document.head.appendChild(css);
    document.addEventListener('DOMContentLoaded', () => {
      const script=document.createElement('script'); script.type='module'; script.src=models?'ui/ai-models.js':'ui/official-ml.js'; document.body.appendChild(script);
    }, {once:true});
    return;
  }

  if (!ml) return;
  document.title = 'KartBlitz ML Lab';
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = 'ml/lab.css?v=20261030';
  document.head.appendChild(style);
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not load ' + src));
      document.body.appendChild(script);
    });
  }
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      await loadScript('ml/runtime.js?v=20261030');
      await loadScript('ml/lab.js?v=20261030');
    } catch (error) {
      console.error(error);
      const message = document.createElement('p');
      message.setAttribute('role', 'alert');
      message.textContent = 'ML Lab could not load. Check your connection and reload this page.';
      document.getElementById('screen-menu').prepend(message);
    }
  }, { once: true });
})();
