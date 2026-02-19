/* global chrome */
"use strict";

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "play-notification-sound") {
    const audio = new Audio(chrome.runtime.getURL("sounds/notification-sound.mp3"));
    audio.volume = typeof message.volume === "number" ? Math.min(1, Math.max(0, message.volume)) : 1;
    audio.play();
  }
});
