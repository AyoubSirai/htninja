'use strict';

/**
 * Preload — secure bridge between renderer and main process.
 */

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('smartnet', {
  // Proxy controls
  getState: () => ipcRenderer.invoke('proxy:getState'),
  start: () => ipcRenderer.invoke('proxy:start'),
  pause: () => ipcRenderer.invoke('proxy:pause'),
  resume: () => ipcRenderer.invoke('proxy:resume'),
  toggle: () => ipcRenderer.invoke('proxy:toggle'),
  setHolding: (enabled) => ipcRenderer.invoke('proxy:setHolding', enabled),
  updateHeldRequest: (id, payload, forward = false) =>
    ipcRenderer.invoke('proxy:updateHeldRequest', id, payload, forward),
  setResponseIntercepting: (enabled) =>
    ipcRenderer.invoke('proxy:setResponseIntercepting', enabled),
  updateHeldResponse: (id, payload, forward = false) =>
    ipcRenderer.invoke('proxy:updateHeldResponse', id, payload, forward),
  replaceHeldResponseText: (id, payload) =>
    ipcRenderer.invoke('proxy:replaceHeldResponseText', id, payload),
  transformHeldResponse: (id, source) =>
    ipcRenderer.invoke('proxy:transformHeldResponse', id, source),
  abortHeldResponse: (id, mode = 'reset') =>
    ipcRenderer.invoke('proxy:abortHeldResponse', id, mode),
  getResponseTransform: () => ipcRenderer.invoke('responseTransform:get'),
  validateResponseTransform: (source) =>
    ipcRenderer.invoke('responseTransform:validate', source),
  setResponseTransform: (source, enabled = true, inScope = true) =>
    ipcRenderer.invoke('responseTransform:set', source, enabled, inScope),
  stop: () => ipcRenderer.invoke('proxy:stop'),
  clearHistory: (keepIds = []) => ipcRenderer.invoke('proxy:clearHistory', keepIds),
  getHistory: () => ipcRenderer.invoke('proxy:getHistory'),
  exportCA: () => ipcRenderer.invoke('proxy:exportCA'),
  getCAPath: () => ipcRenderer.invoke('proxy:getCAPath'),
  openCAFolder: () => ipcRenderer.invoke('proxy:openCAFolder'),

  // Filters (JS hook runs in main-process vm sandbox)
  setJsFilter: (source, options = {}) => ipcRenderer.invoke('filter:setJs', source, options),
  getJsFilter: () => ipcRenderer.invoke('filter:getJs'),

  // Application configuration
  openConfig: () => ipcRenderer.invoke('config:open'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (settings) => ipcRenderer.invoke('config:save', settings),
  closeConfig: () => ipcRenderer.invoke('config:close'),
  openHelp: () => ipcRenderer.invoke('help:open'),

  // Advanced history search
  openSearch: () => ipcRenderer.invoke('search:open'),
  setSearchDomainScope: (pattern) => ipcRenderer.invoke('search:setDomainScope', pattern),
  getAdvancedSearchState: () => ipcRenderer.invoke('search:getState'),
  runAdvancedSearch: (query) => ipcRenderer.invoke('search:run', query),
  setSearchFocus: (enabled) => ipcRenderer.invoke('search:setFocus', enabled),
  clearAdvancedSearch: () => ipcRenderer.invoke('search:clear'),
  selectSearchResult: (id) => ipcRenderer.invoke('search:select', id),

  // Multi-request Repeater window
  openRepeater: () => ipcRenderer.invoke('repeater:open'),
  getRepeaterSessions: () => ipcRenderer.invoke('repeater:list'),
  addRepeaterSession: (request) => ipcRenderer.invoke('repeater:add', request),
  updateRepeaterSession: (id, patch) => ipcRenderer.invoke('repeater:update', id, patch),
  removeRepeaterSession: (id) => ipcRenderer.invoke('repeater:remove', id),

  // Edit & resend
  resendRequest: (payload) => ipcRenderer.invoke('request:resend', payload),

  // Browsers
  launchChrome: (opts) => ipcRenderer.invoke('browser:launchChrome', opts),
  launchFirefox: (opts) => ipcRenderer.invoke('browser:launchFirefox', opts),

  // Event subscriptions — return unsubscribe functions
  onEntry: (cb) => on('traffic:entry', cb),
  onEntryRemoved: (cb) => on('traffic:entryRemoved', cb),
  onCleared: (cb) => on('traffic:cleared', cb),
  onState: (cb) => on('proxy:state', cb),
  onError: (cb) => on('proxy:error', cb),
  onFilterError: (cb) => on('filter:error', cb),
  onResponseTransformError: (cb) => on('responseTransform:error', cb),
  onConfigChanged: (cb) => on('config:changed', cb),
  onRepeaterChanged: (cb) => on('repeater:changed', cb),
  onSearchResults: (cb) => on('search:results', cb),
  onSearchSelect: (cb) => on('search:select', cb),
  onSearchDomainScope: (cb) => on('search:domainScope', cb),
});
