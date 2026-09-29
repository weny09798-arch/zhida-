// 运行在页面的 MAIN world，hook fetch/XHR 截获最新 token
(function(){
  function saveToken(t) {
    if (!t) return;
    try { localStorage.setItem('__zhida_latest_token', t); } catch(e) {}
    try { chrome.storage.local.set({ __zhidaToken: t }); } catch(e) {}
  }
  var origFetch = window.fetch;
  window.fetch = function() {
    var args = Array.from(arguments);
    if (args[1] && args[1].headers) {
      var h = args[1].headers;
      var t = h['x-access-token'] || h['X-Access-Token'];
      if (!t && h.get) t = h.get('x-access-token') || h.get('X-Access-Token');
      if (t) { saveToken(t); }
    }
    return origFetch.apply(this, arguments);
  };
  var origXHR = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(header, val) {
    if (header && header.toLowerCase() === 'x-access-token') {
      saveToken(val);
    }
    return origXHR.apply(this, arguments);
  };
})();