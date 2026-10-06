import assert from 'node:assert/strict';
import test from 'node:test';
import proxyaddr from 'proxy-addr';

test('mapped IPv6 trust ranges cannot turn an external IPv4 peer into a trusted proxy', () => {
  // GHSA-jqcg-44mw-7w3h: short IPv6 prefixes used to trust every IPv4 peer.
  const request = {
    socket: { remoteAddress: '198.51.100.42' },
    headers: { 'x-forwarded-for': '10.0.0.1' },
  };
  for (const subnet of ['::ffff:10.0.0.0/8', '::/1', '::ffff:10.0.0.0/104']) {
    const trust = proxyaddr.compile(subnet);
    assert.equal(trust(request.socket.remoteAddress), false, subnet);
    assert.equal(proxyaddr(request, trust), request.socket.remoteAddress, subnet);
  }
  const valid = proxyaddr.compile('::ffff:10.0.0.0/104');
  assert.equal(valid('10.1.2.3'), true, 'Correctly mapped private subnet still works');
});
