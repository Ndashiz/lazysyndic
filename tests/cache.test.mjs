// Les scripts locaux d'index.html portent tous le même « ?v= » : ndashiz.be les sert avec quatre
// heures de cache navigateur, la page avec dix minutes. Lancer : node --test tests/cache.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('index.html : chaque script local a un ?v=, le même pour tous', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const local = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]).filter(s => !/^https?:/.test(s));
  assert.ok(local.length >= 11, 'les scripts locaux sont là');
  const versions = new Set(local.map(s => (/\?v=([\w.-]+)$/.exec(s) || [])[1]));
  assert.ok(!versions.has(undefined), 'un script local sans ?v= : ' + local.filter(s => !/\?v=/.test(s)).join(', '));
  assert.equal(versions.size, 1, 'plusieurs valeurs de ?v= : ' + [...versions].join(', '));
});
