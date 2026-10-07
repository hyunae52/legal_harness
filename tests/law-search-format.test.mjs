import assert from 'node:assert/strict';
import test from 'node:test';
import { observeSearch } from '../dist/researchSearch.js';

const row = (id, name = '합성법') => `1. ${name} [현행]\n   - 법령ID: ${id}\n   - MST: ${id}01\n   - 공포일: 20260101 / 시행일: 20260101\n   - 구분: 법률\n`;
const response = text => ({ result: { content: [{ type: 'text', text }] } });
const args = { query: '합성법', display: 50 };

test('korean-law 4.15.6 display annotations preserve both exact and partial law hits', () => {
  const current = response('검색 결과 (총 2건, display=50 적용):\n📍 정확매칭 (1건):\n' + row('1') + '\n📂 부분매칭 (1건 중 1건 표시):\n' + row('2', '다른 합성법'));
  const old = response('검색 결과 (총 2건):\n' + row('1') + row('2', '다른 합성법'));
  const actual = observeSearch('search_law', args, current);
  assert.deepEqual(actual, observeSearch('search_law', args, old));
  assert.equal(actual.status, 'complete'); assert.equal(actual.total, 2); assert.equal(actual.hits.length, 2); assert.equal(actual.has_more, false);
});

test('display-limited, inconsistent or truncated law summaries never imply complete coverage', () => {
  const limited = observeSearch('search_law', { ...args, display: 1 }, response('검색 결과 (총 9건, display=1 적용):\n📍 정확매칭 (1건):\n' + row('1')));
  assert.equal(limited.status, 'complete'); assert.equal(limited.has_more, true); assert.equal(limited.total, 9);
  assert.equal(observeSearch('search_law', args, response('검색 결과 (총 9건, display=1 적용):\n' + row('1'))).status, 'partial');
  assert.equal(observeSearch('search_law', args, response('검색 결과 (총 2건, display=50 적용):\n' + row('1'))).status, 'partial');
  assert.equal(observeSearch('search_law', args, response('검색 결과 (총 1건, display=50 적용):\n' + row('1') + '응답 크기 제한')).status, 'partial');
});
