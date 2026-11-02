// Sunstone export: the optional behaviour of an exported page. A classic
// script (not a module) so it runs from `file://`; every page reads fine
// without it.
(function () {
  var root = document.documentElement;

  // The theme toggle; the choice outlives the page (the inline head script
  // applies it before first paint).
  var toggle = document.querySelector('.theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try {
        localStorage.setItem('sunstone-export-theme', next);
      } catch (e) {}
    });
  }

  // Narrow screens: the Explorer is a drawer behind the ☰ button.
  var nav = document.querySelector('.nav-toggle');
  if (nav) {
    nav.addEventListener('click', function () {
      root.classList.toggle('nav-open');
    });
  }

  // Keep the open page's Explorer row in view.
  var current = document.querySelector('.tree [aria-current="page"]');
  if (current) current.scrollIntoView({ block: 'nearest' });

  // Remote Embeds load on click only, as in the web reader (remoteEmbed.ts):
  // opening a page must not fetch an author's third-party image.
  document.addEventListener('click', function (e) {
    var button = e.target.closest && e.target.closest('button.embed-remote');
    if (!button) return;
    var img = document.createElement('img');
    img.className = 'embed-image';
    img.loading = 'lazy';
    img.alt = button.dataset.embedAlt || '';
    if (button.dataset.embedStyle) img.setAttribute('style', button.dataset.embedStyle);
    img.src = button.dataset.embedSrc;
    button.replaceWith(img);
  });
})();
