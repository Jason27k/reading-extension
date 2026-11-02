"use strict";

// Background script: owns the API key and all calls to Google Cloud TTS, and
// forwards keyboard shortcuts, toolbar clicks and menu clicks to the active tab.

const TTS_BASE = "https://texttospeech.googleapis.com";

browser.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "synthesize":
      return synthesize(msg);
    case "list-voices":
      return listVoices();
    case "open-options":
      return browser.runtime.openOptionsPage();
  }
});

async function getApiKey() {
  const { apiKey } = await browser.storage.local.get("apiKey");
  return apiKey?.trim();
}

async function synthesize({ ssml, voice, rate }) {
  const apiKey = await getApiKey();
  if (!apiKey) return { error: "Add your Google Cloud API key in the settings.", code: "no-key" };

  const languageCode = voice.split("-").slice(0, 2).join("-");
  try {
    // v1beta1 is needed for enableTimePointing, which returns the time of each <mark>.
    const res = await fetch(`${TTS_BASE}/v1beta1/text:synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
      body: JSON.stringify({
        input: { ssml },
        voice: { languageCode, name: voice },
        audioConfig: { audioEncoding: "MP3", speakingRate: rate },
        enableTimePointing: ["SSML_MARK"],
      }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error?.message || `Google TTS error (HTTP ${res.status})`, code: res.status };
    recordUsage(ssml);
    return { audio: data.audioContent, timepoints: data.timepoints || [] };
  } catch (err) {
    return { error: `Couldn't reach Google TTS: ${err.message}`, code: "network" };
  }
}

async function listVoices() {
  const apiKey = await getApiKey();
  if (!apiKey) return { error: "Add your API key first.", code: "no-key" };
  try {
    const res = await fetch(`${TTS_BASE}/v1/voices`, { headers: { "X-Goog-Api-Key": apiKey } });
    const data = await res.json();
    if (!res.ok) return { error: data.error?.message || `HTTP ${res.status}` };
    // Only Standard and WaveNet voices support <mark> timepoints, which highlighting needs.
    const voices = data.voices
      .filter((v) => /-(Standard|Wavenet)-/.test(v.name) && v.languageCodes.some((c) => c.startsWith("en-")))
      .map((v) => ({ name: v.name, gender: v.ssmlGender }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { voices };
  } catch (err) {
    return { error: `Couldn't reach Google TTS: ${err.message}` };
  }
}

// Google bills every input character except <mark> tags. Each device counts
// under its own "usage-<id>" key in storage.sync, so devices never overwrite
// each other and the settings page can add them up. Writes are chained so
// concurrent prefetch requests don't overwrite each other's counts.
let usageWrite = Promise.resolve();
function recordUsage(ssml) {
  const chars = ssml.replace(/<mark name="[^"]*"\/>/g, "").length;
  usageWrite = usageWrite
    .then(async () => {
      const month = new Date().toISOString().slice(0, 7);
      const key = `usage-${await getDeviceId()}`;
      const { [key]: usage } = await browser.storage.sync.get(key);
      const previous = usage?.month === month ? usage.chars : 0;
      await browser.storage.sync.set({ [key]: { month, chars: previous + chars } });
    })
    .catch(console.error);
}

async function getDeviceId() {
  let { deviceId } = await browser.storage.local.get("deviceId");
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await browser.storage.local.set({ deviceId });
  }
  return deviceId;
}

// Counts from earlier months, including from devices that are gone, aren't
// shown anywhere, so drop them to stay well under the storage.sync quota.
async function pruneOldUsage() {
  const month = new Date().toISOString().slice(0, 7);
  const all = await browser.storage.sync.get(null);
  const old = Object.keys(all).filter((k) => k.startsWith("usage-") && all[k]?.month !== month);
  if (old.length) await browser.storage.sync.remove(old);
}

async function sendToActiveTab(command, tab) {
  tab ??= (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) return;
  browser.tabs.sendMessage(tab.id, { type: "command", command }).catch(() => {
    // No content script here (e.g. about: pages or the add-ons store).
  });
}

browser.commands.onCommand.addListener((command) => sendToActiveTab(command));
browser.action.onClicked.addListener((tab) => sendToActiveTab("toggle-bar", tab));

browser.runtime.onInstalled.addListener(() => {
  migrateToSync();
  usageWrite = usageWrite.then(migrateUsage).then(pruneOldUsage).catch(console.error);
  browser.menus.create({
    id: "read-from-here",
    title: "Read aloud from here",
    contexts: ["selection", "page", "link"],
  });
});

// Older versions kept preferences in storage.local. Move them to storage.sync,
// unless another device has already synced its own.
const SYNCED_KEYS = ["voice", "rate", "skipCode", "readCaptions"];
async function migrateToSync() {
  const old = await browser.storage.local.get(SYNCED_KEYS);
  if (!Object.keys(old).length) return;
  const synced = await browser.storage.sync.get(SYNCED_KEYS);
  if (!Object.keys(synced).length) await browser.storage.sync.set(old);
  await browser.storage.local.remove(SYNCED_KEYS);
}

// 0.1.0 counted usage in storage.local; carry this month's count over.
async function migrateUsage() {
  const { usage } = await browser.storage.local.get("usage");
  if (!usage) return;
  const month = new Date().toISOString().slice(0, 7);
  if (usage.month === month) {
    const key = `usage-${await getDeviceId()}`;
    const { [key]: current } = await browser.storage.sync.get(key);
    const chars = (current?.month === month ? current.chars : 0) + usage.chars;
    await browser.storage.sync.set({ [key]: { month, chars } });
  }
  await browser.storage.local.remove("usage");
}

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "read-from-here") sendToActiveTab("read-from-context", tab);
});
