'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tempHome } = require('./helpers');

const home = tempHome();
const skills = require('../lib/skills');

let srv;
test.before(async () => {
  srv = await startServer();
  fs.mkdirSync(path.join(home, 'skills'));
  fs.writeFileSync(path.join(home, 'skills', 'local-books.json'), JSON.stringify({
    id: 'local-books',
    description: 'test skill over the fixture server',
    domains: ['127.0.0.1'],
    intents: {
      list: {
        description: 'books on the list page',
        input: { base: { required: true, raw: true } },
        url: '{base}/books.html',
        format: 'html',
        rows: 'article.book',
        fields: {
          title: { selector: 'h3 a', attr: 'title' },
          price: { selector: '.price', type: 'number' },
          stock: { selector: '.stock' },
          url: { selector: 'h3 a', attr: 'href', type: 'url' },
        },
        required: ['title', 'price'],
      },
      data: {
        description: 'items from a JSON endpoint',
        input: { base: { required: true, raw: true } },
        url: '{base}/data.json',
        format: 'json',
        rows: 'items',
        fields: { name: {}, size: { type: 'number' }, link: { type: 'url' } },
        required: ['name'],
      },
      private: {
        description: 'a path robots.txt disallows',
        input: { base: { required: true, raw: true } },
        url: '{base}/private/secret.html',
        format: 'html',
        rows: 'p',
        fields: { text: {} },
      },
    },
  }));
});
test.after(async () => { await srv.close(); });

test('skills: user skills are listed with their argument names', () => {
  const l = skills.list();
  const mine = l.skills.find((s) => s.id === 'local-books');
  assert.deepEqual(Object.keys(mine.intents.list.input), ['base']);
  assert.deepEqual(mine.intents.list.fields, ['title', 'price', 'stock', 'url']);
});

test('skills: an HTML intent returns typed rows and drops incomplete ones', async () => {
  const r = await skills.run('local-books', 'list', { base: srv.base });
  assert.equal(r.count, 2);
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.rows[0], { title: 'First Book', price: 12.5, stock: 'In stock', url: `${srv.base}/b/1` });
});

test('skills: a JSON intent returns typed rows', async () => {
  const r = await skills.run('local-books', 'data', { base: srv.base });
  assert.deepEqual(r.rows, [
    { name: 'one', size: 10, link: `${srv.base}/x/1` },
    { name: 'two', size: 20.5, link: `${srv.base}/x/2` },
  ]);
});

test('skills: robots.txt and the domain list bind skills too', async () => {
  await assert.rejects(skills.run('local-books', 'private', { base: srv.base }), (e) => e.robots === true);
  await assert.rejects(skills.run('local-books', 'list', { base: 'http://localhost:1' }), /outside this skill's domains/);
  await assert.rejects(skills.run('local-books', 'nope', {}), /has no intent "nope"/);
});
