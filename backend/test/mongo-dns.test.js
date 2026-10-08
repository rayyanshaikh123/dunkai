import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import mongoose from 'mongoose';
import { connectWithMongoDnsFallback, resolveAtlasMongoUri } from '../src/config/mongoDns.js';

const URI = 'mongodb+srv://test%40user:p%40ss%3Aword%2F%25@demo.example.mongodb.net/dunkai?retryWrites=true&w=majority&appName=Dunk%20AI';
const seedError = (syscall = 'querySrv') => Object.assign(new Error(`${syscall} ECONNREFUSED`), { code: 'ECONNREFUSED', syscall });
const mockDns = ({ srv = ['0 0 27017 node-00.example.mongodb.net.', '0 0 27017 node-01.example.mongodb.net.'],
  txt = ['"authSource=admin&replicaSet=atlas-test"'], txtStatus = 0, onCall = () => {},
} = {}) => async (url, options) => {
  onCall(url, options);
  const type = url.searchParams.get('type');
  return new Response(JSON.stringify({ Status: type === 'TXT' ? txtStatus : 0,
    Answer: (type === 'SRV' ? srv : txt).map((data) => ({ type: type === 'SRV' ? 33 : 16, data })),
  }), { headers: { 'content-type': 'application/dns-json' } });
};

test('healthy database connection keeps the original URI and performs no public DNS lookup', async () => {
  const options = { maxPoolSize: 5 };
  const result = await connectWithMongoDnsFallback(URI, options, {
    enabled: true,
    connect: async (uri, receivedOptions) => {
      assert.equal(uri, URI);
      assert.equal(receivedOptions, options);
      return 'connected';
    },
    fetchImpl: () => assert.fail('Healthy connections must not use HTTPS DNS'),
    warn: () => assert.fail('Healthy connections must not warn'),
  });
  assert.equal(result, 'connected');
});

test('refused SRV and TXT lookups retry once with authenticated, verified TLS replica-set connections', async () => {
  for (const syscall of ['querySrv', 'queryTxt']) {
    let attempts = 0;
    const requests = [];
    const warnings = [];
    const options = { serverSelectionTimeoutMS: 10000 };
    const client = await connectWithMongoDnsFallback(URI, options, {
      enabled: true,
      connect: async (uri, receivedOptions) => {
        assert.equal(receivedOptions, options);
        if (++attempts === 1) throw seedError(syscall);
        return new mongoose.mongo.MongoClient(uri);
      },
      fetchImpl: mockDns({ onCall: (url, settings) => {
        requests.push(url.toString());
        assert.equal(settings.headers.accept, 'application/dns-json');
        assert.equal(settings.redirect, 'error');
        assert.ok(settings.signal instanceof AbortSignal);
      } }),
      warn: (message) => warnings.push(message),
    });
    assert.equal(attempts, 2);
    assert.equal(requests.length, 2);
    assert.equal(warnings.length, 1);
    assert.equal(client.options.dbName, 'dunkai');
    assert.equal(client.options.credentials.username, 'test@user');
    assert.equal(client.options.credentials.password, 'p@ss:word/%');
    assert.equal(client.options.credentials.source, 'admin');
    assert.equal(client.options.replicaSet, 'atlas-test');
    assert.equal(client.options.tls, true);
    // The driver leaves these unset by default, which enables verification.
    assert.notEqual(client.options.tlsAllowInvalidCertificates, true);
    assert.notEqual(client.options.tlsAllowInvalidHostnames, true);
    assert.equal(client.options.appName, 'Dunk AI');
    assert.equal(client.options.retryWrites, true);
    assert.deepEqual(client.options.hosts.map((host) => host.toString()), ['node-00.example.mongodb.net:27017', 'node-01.example.mongodb.net:27017']);
    for (const text of [...requests, ...warnings]) {
      assert.ok(!text.includes('test%40user') && !text.includes('p%40ss') && !text.includes('dunkai') && !text.includes('retryWrites'));
    }
  }
});

test('URI options override DNS defaults regardless of option capitalization; TXT chunks concatenate', async () => {
  const uri = `${URI}&AUTHSource=custom&ReplicaSet=custom-set&srvMaxHosts=0&srvServiceName=mongodb&SSL=true`;
  const resolved = await resolveAtlasMongoUri(uri, { fetchImpl: mockDns({ txt: ['"authSource=admin&" "replicaSet=atlas-test"'] }) });
  assert.ok(!/srvMaxHosts|srvServiceName/.test(resolved));
  const client = new mongoose.mongo.MongoClient(resolved);
  assert.equal(client.options.credentials.source, 'custom');
  assert.equal(client.options.replicaSet, 'custom-set');
  assert.equal(client.options.tls, true);
});

test('external authentication retains its external auth database', async () => {
  const uri = 'mongodb+srv://demo.example.mongodb.net/dunkai?authMechanism=MONGODB-X509';
  const client = new mongoose.mongo.MongoClient(await resolveAtlasMongoUri(uri, { fetchImpl: mockDns() }));
  assert.equal(client.options.credentials.source, '$external');
});

test('missing TXT records preserve the normal database authentication default', async () => {
  const client = new mongoose.mongo.MongoClient(await resolveAtlasMongoUri(URI, { fetchImpl: mockDns({ txt: [], txtStatus: 3 }) }));
  assert.equal(client.options.credentials.source, 'dunkai');
  assert.equal(client.options.tls, true);
});

test('an unavailable first HTTPS resolver falls back to the second', async () => {
  const requests = [];
  const fetchImpl = mockDns({ onCall: (url) => {
    requests.push(url.toString());
    if (url.hostname === 'cloudflare-dns.com') throw new Error('Network unavailable');
  } });
  const uri = await resolveAtlasMongoUri(URI, { fetchImpl });
  assert.equal(new mongoose.mongo.MongoClient(uri).options.replicaSet, 'atlas-test');
  assert.equal(requests.length, 4);
  assert.ok(requests.some((url) => url.startsWith('https://dns.google/resolve')));
});

test('disabled fallback, private/local database URIs, and non-DNS connection errors are not retried', async () => {
  const cases = [
    { uri: URI, enabled: false, error: seedError() },
    { uri: 'mongodb://127.0.0.1:27017/dunkai', enabled: true, error: seedError() },
    { uri: 'mongodb+srv://mongo.internal/dunkai', enabled: true, error: seedError() },
    { uri: URI, enabled: true, error: Object.assign(new Error('Authentication failed'), { code: 18 }) },
    { uri: URI, enabled: true, error: Object.assign(new Error('Database port refused'), { code: 'ECONNREFUSED', syscall: 'connect' }) },
    { uri: URI, enabled: true, error: Object.assign(new Error('Node hostname lookup failed'), { code: 'ENOTFOUND', syscall: 'getaddrinfo' }) },
  ];
  for (const { uri, enabled, error } of cases) {
    let attempts = 0;
    await assert.rejects(connectWithMongoDnsFallback(uri, {}, {
      enabled, connect: async () => { attempts++; throw error; },
      fetchImpl: () => assert.fail('Unrelated connection errors must not query public DNS'),
      warn: () => assert.fail('Unrelated connection errors must not warn'),
    }), (received) => received === error);
    assert.equal(attempts, 1);
  }
});

test('unsafe DNS answers cannot create a connection or expose the private URI', async () => {
  const responses = [
    { srv: ['0 0 27017 database.attacker.example'] },
    { srv: ['0 0 27017 node-00.other.mongodb.net'] },
    { srv: ['0 0 27017 node-00.fake-example.mongodb.net'] },
    { srv: ['0 0 0 node-00.example.mongodb.net'] },
    { srv: ['0 0 65536 node-00.example.mongodb.net'] },
    { srv: [] },
    { txt: ['"tls=false"'] },
    { txt: ['"authSource=admin"', '"replicaSet=atlas-test"'] },
    { txt: ['"authSource="'] },
    { txt: ['"authSource=admin&authSource=evil"'] },
    { txt: ['authSource=admin'] },
    { txtStatus: 2 },
  ];
  for (const response of responses) {
    let attempts = 0;
    await assert.rejects(connectWithMongoDnsFallback(URI, {}, {
      enabled: true, connect: async () => { attempts++; throw seedError(); }, fetchImpl: mockDns(response), warn: () => {},
    }), (error) => error.code === 'ATLAS_DNS_FALLBACK_FAILED' && !error.message.includes('p%40ss'));
    assert.equal(attempts, 1);
  }
});

test('fallback never disables TLS verification and does not reinterpret srvMaxHosts', async () => {
  for (const param of ['tls=false', 'ssl=false', 'tlsInsecure=true', 'tlsAllowInvalidCertificates=true', 'tlsAllowInvalidHostnames=true', 'srvMaxHosts=1']) {
    await assert.rejects(resolveAtlasMongoUri(`${URI}&${param}`, { fetchImpl: mockDns() }), { code: 'ATLAS_DNS_FALLBACK_FAILED' });
  }
});

test('a rejected recovered connection is propagated without further attempts', async () => {
  let attempts = 0;
  const authenticationError = Object.assign(new Error('Authentication failed'), { code: 18 });
  await assert.rejects(connectWithMongoDnsFallback(URI, {}, {
    enabled: true,
    connect: async () => { if (++attempts === 1) throw seedError(); throw authenticationError; },
    fetchImpl: mockDns(), warn: () => {},
  }), (error) => error === authenticationError);
  assert.equal(attempts, 2);
});

test('HTTPS resolver failures return a safe actionable error', async () => {
  await assert.rejects(resolveAtlasMongoUri(URI, { fetchImpl: async () => { throw new Error(`Provider failed: ${URI}`); } }), (error) => {
    assert.equal(error.code, 'ATLAS_DNS_FALLBACK_FAILED');
    assert.ok(!error.message.includes('p%40ss'));
    return true;
  });
});

test('DNS recovery defaults to development only and allows an explicit override', () => {
  for (const [environment, override, expected] of [
    ['development', undefined, true], ['production', undefined, false], ['test', undefined, false],
    ['development', 'false', false], ['production', 'true', true],
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import {env} from './src/config/env.js';console.log(env.mongoDnsFallback)"], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000,
      env: { ...process.env, DOTENV_CONFIG_PATH: '.dunkai-dns-test-no-env', NODE_ENV: environment, MONGODB_DNS_FALLBACK: override,
        LOCAL_RUNTIME_ENABLED: 'true', JWT_ACCESS_SECRET: 'test-access-secret', JWT_REFRESH_SECRET: 'test-refresh-secret', BYOK_ENCRYPTION_KEY: 'test-key' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), String(expected));
  }
});
