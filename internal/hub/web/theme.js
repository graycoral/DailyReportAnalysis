// Runs in <head> before the stylesheet paints so the saved theme never flashes. CSP forbids inline scripts.
// Order: #...&theme=NAME in the URL (previews/tests) → saved choice → OS dark/light preference.
(function(){var ok=['apple','apple-dark','classic'],t='';
var m=/(?:^|[#&])theme=([a-z-]+)/.exec(location.hash);if(m)t=m[1];
if(!ok.includes(t)){try{t=localStorage.getItem('av_theme')||''}catch(e){}}
if(!ok.includes(t))t=matchMedia('(prefers-color-scheme: dark)').matches?'apple-dark':'apple';
document.documentElement.dataset.theme=t})();
