let panelWindow = null;
let pendingElementsSelection = false;

function deliverElementsSelection() {
  if (!pendingElementsSelection || !panelWindow) {
    return;
  }

  if (typeof panelWindow.captureElementsPanelSelection !== 'function') {
    panelWindow.addEventListener('DOMContentLoaded', deliverElementsSelection, { once: true });
    return;
  }

  pendingElementsSelection = false;
  panelWindow.captureElementsPanelSelection(true);
}

chrome.devtools.panels.elements.onSelectionChanged.addListener(() => {
  pendingElementsSelection = true;
  deliverElementsSelection();
});

chrome.devtools.panels.create('Dev Console AI', '', 'panel.html', (panel) => {
  panel.onShown.addListener((shownWindow) => {
    panelWindow = shownWindow;
    deliverElementsSelection();
  });
  panel.onHidden.addListener(() => {
    panelWindow = null;
  });
});
