// background.js
//
// MV3 service worker. Opens the Sidecar side panel when the toolbar icon
// is clicked, so it stays open while the user works in Sidekick.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
