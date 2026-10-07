// Atlas SRV/TXT discovery can fail on phone hotspots even when HTTPS works.
// Recover only that lookup, without changing DNS for private backend services.
const RESOLVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
const DNS_ERRORS = new Set(['ECONNREFUSED', 'ETIMEOUT', 'ESERVFAIL', 'EREFUSED', 'EAI_AGAIN', 'ENOTFOUND']);
const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const atlasSrv = (uri) => {
  try {
    const url = new URL(uri);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'mongodb+srv:' || url.port || url.hash || !DNS_NAME.test(host) || !host.endsWith('.mongodb.net')) return null;
    return { url, host };
  } catch { return null; }
};

const isSeedDnsError = (error) => {
  for (let depth = 0; error && depth < 3; depth++, error = error.cause) {
    if (DNS_ERRORS.has(error.code) && /^query(?:srv|txt)$/i.test(error.syscall || '')) return true;
  }
  return false;
};

const queryDns = async (endpoint, name, type, fetchImpl) => {
  const url = new URL(endpoint);
  url.searchParams.set('name', name);
  url.searchParams.set('type', type);
  const response = await fetchImpl(url, {
    headers: { accept: 'application/dns-json' },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('HTTPS DNS lookup failed');
  const data = await response.json();
  // No TXT record is valid; a failed lookup must not silently lose authSource.
  if (type === 'TXT' && data.Status === 3) return [];
  if (data.Status !== 0 || (data.Answer !== undefined && !Array.isArray(data.Answer))) throw new Error('Invalid HTTPS DNS answer');
  return (data.Answer || []).filter((record) => record.type === (type === 'SRV' ? 33 : 16));
};

const txtOptions = (records) => {
  if (records.length > 1) throw new Error('Multiple Atlas TXT records are not allowed');
  if (!records.length) return new URLSearchParams();
  const text = records[0].data;
  if (typeof text !== 'string') throw new Error('Invalid Atlas TXT record');
  const quoted = /"(?:[^"\\]|\\.)*"/g;
  const chunks = text.match(quoted);
  if (!chunks?.length || text.replace(quoted, '').trim()) throw new Error('Invalid Atlas TXT record');
  const params = new URLSearchParams(chunks.map((chunk) => JSON.parse(chunk)).join(''));
  const seen = new Set();
  for (const [key, value] of params) {
    if (!['authSource', 'replicaSet', 'loadBalanced'].includes(key) || !value || seen.has(key)) throw new Error('Invalid Atlas TXT options');
    seen.add(key);
  }
  return params;
};

const standardUri = (uri, parsed, srv, txt) => {
  if (!srv.length || srv.length > 32) throw new Error('Invalid Atlas SRV records');
  const parent = `.${parsed.host.split('.').slice(1).join('.')}`;
  const seeds = srv.map((record) => {
    const match = typeof record.data === 'string' && /^(\d+)\s+(\d+)\s+(\d+)\s+([^\s]+)$/.exec(record.data);
    if (!match) throw new Error('Invalid Atlas SRV record');
    const host = match[4].replace(/\.$/, '').toLowerCase();
    const port = Number(match[3]);
    if (!DNS_NAME.test(host) || !(`.${host.split('.').slice(1).join('.')}`).endsWith(parent) || port < 1 || port > 65535) {
      throw new Error('Atlas SRV target is outside the cluster domain or has an invalid port');
    }
    return `${host}:${port}`;
  });

  const params = new URLSearchParams(parsed.url.search);
  const names = new Map([...params.keys()].map((key) => [key.toLowerCase(), key]));
  const get = (key) => params.get(names.get(key) || key);
  if (get('srvmaxhosts') !== null && get('srvmaxhosts') !== '0') throw new Error('HTTPS DNS fallback does not support srvMaxHosts');
  for (const name of ['srvmaxhosts', 'srvservicename']) {
    if (names.has(name)) params.delete(names.get(name));
  }
  if (['tls', 'ssl'].some((key) => get(key) === 'false') ||
      ['tlsinsecure', 'tlsallowinvalidcertificates', 'tlsallowinvalidhostnames'].some((key) => get(key) === 'true')) {
    throw new Error('Atlas HTTPS DNS fallback requires verified TLS');
  }
  if (!names.has('tls') && !names.has('ssl')) params.set('tls', 'true');
  const externalAuth = ['GSSAPI', 'MONGODB-AWS', 'MONGODB-OIDC', 'MONGODB-X509'].includes(get('authmechanism'));
  for (const [key, value] of txtOptions(txt)) {
    if (key === 'authSource' && externalAuth) continue;
    if (!names.has(key.toLowerCase())) params.set(key, value);
  }
  // Keep percent-encoded credentials byte for byte. Never log this URI or
  // send credentials, database names, or query options to a DNS provider.
  const authority = uri.slice('mongodb+srv://'.length).split(/[/?#]/, 1)[0];
  const credentials = authority.includes('@') ? authority.slice(0, authority.lastIndexOf('@') + 1) : '';
  return `mongodb://${credentials}${[...new Set(seeds)].join(',')}${parsed.url.pathname || '/'}?${params}`;
};

export const resolveAtlasMongoUri = async (uri, { fetchImpl = globalThis.fetch } = {}) => {
  const parsed = atlasSrv(uri);
  if (!parsed) throw new Error('HTTPS DNS fallback supports Atlas mongodb+srv URIs only');
  const params = new URLSearchParams(parsed.url.search);
  const service = [...params].find(([key]) => key.toLowerCase() === 'srvservicename')?.[1] || 'mongodb';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(service)) throw new Error('Invalid Atlas SRV service name');
  for (const endpoint of RESOLVERS) {
    try {
      const [srv, txt] = await Promise.all([
        queryDns(endpoint, `_${service}._tcp.${parsed.host}`, 'SRV', fetchImpl),
        queryDns(endpoint, parsed.host, 'TXT', fetchImpl),
      ]);
      return standardUri(uri, parsed, srv, txt);
    } catch {
      // A second independent resolver can recover from an unavailable first.
      // Provider errors and the private connection string never enter logs.
    }
  }
  const error = new Error('Atlas DNS recovery failed: HTTPS resolvers are unavailable or returned invalid records. Check your network and Atlas cluster availability.');
  error.code = 'ATLAS_DNS_FALLBACK_FAILED';
  throw error;
};

export const connectWithMongoDnsFallback = async (uri, options, {
  connect, enabled = false, fetchImpl = globalThis.fetch, warn = console.warn,
}) => {
  try {
    return await connect(uri, options);
  } catch (error) {
    if (!enabled || !atlasSrv(uri) || !isSeedDnsError(error)) throw error;
    warn('MongoDB SRV/TXT DNS lookup failed; retrying Atlas discovery over HTTPS.');
    const fallbackUri = await resolveAtlasMongoUri(uri, { fetchImpl });
    return connect(fallbackUri, options);
  }
};
