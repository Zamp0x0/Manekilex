(function () {
  const body = document.body;
  const panelWrap = document.getElementById("pdfPanelWrap");
  const root = document.getElementById("lookupPanelRoot");
  const emptyEl = document.getElementById("lookupPanelEmpty");
  const hintEl = document.getElementById("lookupPanelHint");

  const params = new URLSearchParams(window.location.search);

  const controller = window.MKLookup.createController({
    win: window,
    doc: document,
    mountEl: root,
  });

  function setUiMode(mode) {
    const panel = mode === "panel";
    body.classList.toggle("mode-panel", panel);
    if (panelWrap) panelWrap.hidden = !panel;
  }

  function expandPanel() {
    setUiMode("panel");
  }

  function startLookup(text) {
    if (!text || !controller.lookupText(text)) return false;
    if (emptyEl) emptyEl.hidden = true;
    if (hintEl) hintEl.hidden = false;
    expandPanel();
    return true;
  }

  setUiMode("panel");
  const initialText = params.get("text") || "";
  if (initialText) startLookup(initialText);
})();
