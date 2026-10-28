/* Informational branch marker only; this never changes service endpoints. */
(function mountUiPreviewMarker() {
  let isPreview = false;
  try {
    isPreview = location.hostname.startsWith('testing-ui-extra--') ||
      new URLSearchParams(location.search).get('uiPreview') === '1';
  } catch (error) {
    isPreview = false;
  }
  if (!isPreview) return;

  const mount = () => {
    if (document.getElementById('kb-ui-preview-marker')) return;
    const marker = document.createElement('div');
    marker.id = 'kb-ui-preview-marker';
    marker.textContent = 'UI PREVIEW · testing-ui-extra';
    marker.setAttribute('aria-label', 'UI preview for testing-ui-extra');
    document.body.appendChild(marker);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
