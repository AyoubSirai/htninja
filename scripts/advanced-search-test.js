'use strict';

const assert = require('assert');
const { runAdvancedSearch } = require('../proxy/advancedSearch');

const history = [
  {
    id: 'one',
    seq: 1,
    source: 'proxy',
    method: 'POST',
    url: 'https://api.example.com/login',
    host: 'api.example.com',
    path: '/login',
    protocol: 'https',
    status: 401,
    contentType: 'application/json',
    requestHeaders: { 'content-type': 'application/json', authorization: 'Bearer bad-token' },
    requestBody: '{"username":"alice"}',
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"error":"Invalid token"}',
  },
  {
    id: 'two',
    seq: 2,
    source: 'proxy',
    method: 'GET',
    url: 'https://example.com/home',
    host: 'example.com',
    path: '/home',
    protocol: 'https',
    status: 200,
    contentType: 'text/html',
    requestHeaders: {},
    requestBody: '',
    responseHeaders: { 'content-type': 'text/html' },
    responseBody: '<h1>Welcome</h1>',
  },
  {
    id: 'repeat',
    seq: 3,
    source: 'resend',
    method: 'POST',
    url: 'https://api.example.com/login',
    status: 500,
    requestHeaders: {},
    responseHeaders: {},
    responseBody: 'Invalid token',
  },
];

const bodySearch = runAdvancedSearch(history, {
  pattern: 'invalid token',
  mode: 'text',
  scopes: ['responseBody'],
});
assert.equal(bodySearch.ok, true);
assert.deepEqual(bodySearch.matches.map((match) => match.id), ['one']);
assert.deepEqual(bodySearch.matches[0].matchedScopes, ['responseBody']);
assert.equal(bodySearch.totalSearched, 2);

const regexAndJs = runAdvancedSearch(history, {
  pattern: '^authorization:\\s+Bearer',
  mode: 'regex',
  scopes: ['requestHeaders'],
  jsCondition: "req.method === 'POST' && res.status >= 400",
});
assert.equal(regexAndJs.ok, true);
assert.deepEqual(regexAndJs.matches.map((match) => match.id), ['one']);

const jsOnly = runAdvancedSearch(history, {
  pattern: '',
  scopes: [],
  jsCondition: 'res.status === 200',
});
assert.equal(jsOnly.ok, true);
assert.deepEqual(jsOnly.matches.map((match) => match.id), ['two']);

const inScopeOnly = runAdvancedSearch(history, {
  pattern: 'application',
  mode: 'text',
  scopes: ['responseHeaders'],
  inScopeOnly: true,
  domainPattern: 'api.',
});
assert.equal(inScopeOnly.ok, true);
assert.deepEqual(inScopeOnly.matches.map((match) => match.id), ['one']);
assert.equal(inScopeOnly.totalSearched, 1);
assert.equal(inScopeOnly.totalAvailable, 2);

const wildcardScope = runAdvancedSearch(history, {
  pattern: 'welcome',
  mode: 'text',
  scopes: ['responseBody'],
  inScopeOnly: true,
  domainPattern: '*.example.com',
});
assert.equal(wildcardScope.ok, true);
assert.deepEqual(wildcardScope.matches.map((match) => match.id), ['two']);

const invalid = runAdvancedSearch(history, {
  pattern: '[',
  mode: 'regex',
  scopes: ['url'],
});
assert.equal(invalid.ok, false);
assert.match(invalid.error, /Invalid regular expression/);

console.log('Advanced search tests passed');
