import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseSheet, validate, toEventInput, cleanDupr, cleanLogoUrl, cleanText, detectDelimiter, initials, TEMPLATE_PLAYERS, TEMPLATE_TEAMS, LIMITS } from '../sheet-import.js';
import { cleanName } from '../api/_names.js';

const P = text => { const r = parseSheet(text); assert.ok(r.ok, r.error); return r; };
const names = t => t.players.map(p => p.name);

test('csv: quotes, commas, doubled quotes, line breaks inside a field, CRLF, CR and a byte-order mark', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n"two\nlines",z\rlast,'), [['a', 'b'], ['x, y', 'he said "hi"'], ['two\nlines', 'z'], ['last', '']]);
  assert.deepEqual(parseCsv('a,b\n\n\nc,d\n'), [['a', 'b'], ['c', 'd']]); // blank lines are skipped
  assert.deepEqual(parseCsv('"",x'), [['', 'x']]);
});

test('csv: tab (pasted from a spreadsheet) and semicolon delimiters are detected', () => {
  assert.equal(detectDelimiter('Player\tTeam\nAna\tNinjas'), '\t');
  assert.equal(detectDelimiter('Player;Team\nAna;Ninjas'), ';');
  assert.equal(detectDelimiter('Player,Team'), ',');
  assert.equal(detectDelimiter('"a, b"\tc'), '\t');
  const r = P('Player\tTeam\nAna\tNinjas\nBen\tNinjas');
  assert.equal(r.draft.teams.length, 1);
});

test('layout one row per player: rows sharing a team name form a team, others are loose', () => {
  const r = P('Player,Team,DUPR ID,Logo URL\nAna,Net Ninjas,k4m2p9,https://example.com/n.png\nBen,net ninjas,,\nCy,Drop Shots,,\nDi,Drop Shots,,\nEd,,,');
  assert.equal(r.layout, 'players');
  assert.equal(r.draft.teams.length, 2);
  assert.deepEqual(names(r.draft.teams[0]), ['Ana', 'Ben']);
  assert.equal(r.draft.teams[0].name, 'Net Ninjas');
  assert.equal(r.draft.teams[0].logo, 'https://example.com/n.png');
  assert.equal(r.draft.teams[0].players[0].dupr, 'K4M2P9'); // uppercased
  assert.deepEqual(r.draft.loose.map(p => p.name), ['Ed']);
  assert.equal(r.draft.teams[0].players[1].line, 3); // the sheet row, header is row 1
});

test('layout one row per team: Player 1 / Player 2 and their DUPR IDs', () => {
  const r = P(TEMPLATE_TEAMS);
  assert.equal(r.layout, 'teams');
  assert.equal(r.draft.teams.length, 2);
  assert.deepEqual(names(r.draft.teams[1]), ['Cy Park', 'Di Wu']);
  assert.equal(r.draft.teams[0].players[1].dupr, 'R7T3QX');
  assert.equal(r.draft.teams[1].logo, 'https://example.com/logos/drop-shots.png');
  const one = P('team,player 1,player 2\nSolo,Ana,\n,Cy,Di');
  assert.equal(one.draft.teams[0].players.length, 1);
  assert.equal(one.draft.teams[1].name, '');
});

test('the downloadable templates parse and pass their own checks', () => {
  for (const t of [TEMPLATE_PLAYERS, TEMPLATE_TEAMS]) {
    const r = P(t);
    const v = validate(r.draft, { format: 'single_elim' });
    assert.equal(v.players.length, 4);
    assert.equal(v.ok, true, JSON.stringify(v.errors));
  }
});

test('header variants: case, spaces, punctuation, order and extra columns do not matter', () => {
  const r = P('Email,  LOGO_url ,duPR  id, TEAM NAME ,Notes,PLAYER NAME\nx@y.z,,ab123c,Aces,hi,Ana\n');
  assert.equal(r.draft.teams[0].name, 'Aces');
  assert.equal(r.draft.teams[0].players[0].name, 'Ana');
  assert.equal(r.draft.teams[0].players[0].dupr, 'AB123C');
  assert.ok(r.found.includes('Player') && r.found.includes('Logo URL'));
  assert.equal(P('name\nAna').draft.loose[0].name, 'Ana'); // a Player column called Name
});

test('a sheet without a Player column says what it needs', () => {
  const r = parseSheet('Foo,Bar\n1,2');
  assert.equal(r.ok, false);
  assert.match(r.error, /Player column/);
  assert.match(r.error, /Foo, Bar/);
  assert.equal(parseSheet('').ok, false);
  assert.equal(parseSheet('   \n\n').ok, false);
  assert.equal(parseSheet('Player,Team').ok, false);
  assert.equal(parseSheet('Player,Team\n,,\n').ok, false);
});

test('row cap and size cap', () => {
  const many = 'Player\n' + Array.from({ length: LIMITS.rows + 1 }, (_, i) => 'P' + i).join('\n');
  assert.match(parseSheet(many).error, /201 rows/);
  assert.equal(parseSheet('Player\n' + Array.from({ length: LIMITS.rows }, (_, i) => 'P' + i).join('\n')).ok, true);
  assert.match(parseSheet('Player\n' + 'x'.repeat(LIMITS.bytes)).error, /too large/);
});

test('validation: duplicates (any case), missing names, odd team sizes, and the player count', () => {
  const r = P('Player,Team\nAna,A\nana,A\nBen,B\n,B\nCy,C\nDi,C\nEd,C');
  const v = validate(r.draft, { format: 'single_elim' });
  const msgs = v.errors.map(e => e.at + ' ' + e.msg);
  assert.ok(msgs.some(m => m.startsWith('t0p1') && /already in this sheet \(row 2\)/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some(m => m.startsWith('t1p1') && /Missing player name/.test(m)));
  assert.ok(msgs.some(m => m.startsWith('t2 ') && /3 players/.test(m)));
  assert.equal(v.ok, false);
  const lone = validate(P('Player,Team\nAna,A\nBen,').draft, { format: 'single_elim' });
  assert.ok(lone.errors.some(e => e.at === 'g' && /at least 4 players/.test(e.msg)));
  assert.ok(lone.errors.some(e => e.at === 'l0' && /no team/.test(e.msg)));
});

test('validation: team sizes only matter when the format uses the sheet teams', () => {
  const text = 'Player,Team\nA1,X\nA2,X\nA3,X\nB1,Y\nB2,Y\nB3,Y\nB4,Y\nC1,Z';
  const rot = validate(P(text).draft, { format: 'roundrobin', partners: 'rotating' });
  assert.equal(rot.usesTeams, false);
  assert.deepEqual(rot.errors, []);
  assert.equal(rot.players.length, 8);
  const fixed = validate(P(text).draft, { format: 'roundrobin', partners: 'fixed' });
  assert.equal(fixed.usesTeams, true);
  assert.ok(fixed.errors.some(e => /3 players/.test(e.msg)) && fixed.errors.some(e => /1 player\./.test(e.msg)));
});

test('validation: a sheet with no team column still works for fixed teams (the app pairs them)', () => {
  const v = validate(P('Player\nA\nB\nC\nD\nE\nF').draft, { format: 'single_elim' });
  assert.equal(v.usesTeams, false);
  assert.equal(v.ok, true);
  assert.equal(validate(P('Player\nA\nB\nC\nD\nE').draft, { format: 'single_elim' }).ok, false); // odd
});

test('validation: team counts per format', () => {
  const six = P('Player,Team\nA,1\nB,1\nC,2\nD,2\nE,3\nF,3').draft;
  assert.equal(validate(six, { format: 'double_elim' }).ok, true);
  assert.ok(validate(P('Player,Team\nA,1\nB,1\nC,2\nD,2').draft, { format: 'double_elim' }).errors.some(e => /at least 3 teams/.test(e.msg)));
  assert.ok(validate(six, { format: 'pool_knockout', partners: 'fixed' }).errors.some(e => /at least 4 teams/.test(e.msg)));
  assert.ok(validate(six, { format: 'pool_knockout', partners: 'rotating' }).errors.some(e => /at least 8 players/.test(e.msg)));
  const big = P('Player\n' + Array.from({ length: 34 }, (_, i) => 'P' + i).join('\n'));
  assert.ok(validate(big.draft, { format: 'roundrobin' }).errors.some(e => /at most 32/.test(e.msg)));
});

test('DUPR IDs: trimmed, uppercased, 5 to 10 letters and numbers; anything else is an error, repeats a warning', () => {
  assert.deepEqual(cleanDupr('  l8ew8w '), { value: 'L8EW8W' });
  assert.deepEqual(cleanDupr(''), { value: '' });
  assert.deepEqual(cleanDupr(null), { value: '' });
  for (const bad of ['abc', 'abcd', '12345678901', 'AB-123', 'A B C D E', '<script>', 'K4M2P9;DROP', 'ééééé']) assert.ok(cleanDupr(bad).error, bad);
  assert.equal(cleanDupr('ABCDE').value, 'ABCDE');
  assert.equal(cleanDupr('ABCDEFGHIJ').value, 'ABCDEFGHIJ');
  const r = P('Player,Team,DUPR ID\nA,1,K4M2P9\nB,1,K4M2P9\nC,2,xx\nD,2,');
  const v = validate(r.draft, { format: 'single_elim' });
  assert.ok(v.warnings.some(w => /also used on row 2/.test(w.msg)));
  assert.ok(v.errors.some(e => e.at === 't1p0' && /DUPR ID is 5 to 10/.test(e.msg)));
});

test('logo URLs: https only, no credentials, ports, IP addresses or local names', () => {
  assert.equal(cleanLogoUrl('https://example.com/logo.png').value, 'https://example.com/logo.png');
  assert.equal(cleanLogoUrl('').value, '');
  assert.equal(cleanLogoUrl('  https://cdn.example.org/a/b.svg?v=2  ').value, 'https://cdn.example.org/a/b.svg?v=2');
  for (const bad of ['http://example.com/a.png', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'ftp://example.com/a.png', '//example.com/a.png', 'example.com/a.png',
    'https://user:pw@example.com/a.png', 'https://user@example.com/a.png', 'https://example.com:8443/a.png', 'https://127.0.0.1/a.png', 'https://10.0.0.5/a.png', 'https://[::1]/a.png', 'https://localhost/a.png',
    'https://printer.local/a.png', 'https://intranet/a.png', 'https://exa mple.com/a.png', 'https://example.com/a b.png', 'https://' + 'a'.repeat(300) + '.com/x.png']) assert.ok(cleanLogoUrl(bad).error, bad);
  assert.equal(cleanLogoUrl('https://example.com/a\u0000b.png').value, 'https://example.com/ab.png'); // control characters are stripped
  assert.equal(cleanLogoUrl('https://example.com/a​b.png').value, 'https://example.com/ab.png');
  const r = P('Player,Team,Logo URL\nA,1,http://x.example.com/a.png\nB,1,\nC,2,\nD,2,');
  assert.ok(validate(r.draft, { format: 'single_elim' }).errors.some(e => e.at === 't0' && /https/.test(e.msg)));
});

test('a team logo that differs between rows is noted, the first is used; a logo on a row with no team is left out', () => {
  const r = P('Player,Team,Logo URL\nA,X,https://a.example.com/1.png\nB,X,https://a.example.com/2.png\nC,,https://a.example.com/3.png');
  assert.equal(r.draft.teams[0].logo, 'https://a.example.com/1.png');
  assert.equal(r.draft.notes.length, 2);
});

test('names: control characters and | are stripped, spacing collapsed, and the same as the server cleans them', () => {
  for (const s of ['  Ana   Lopez ', 'A|na', 'Ana​Lo\u0007pez', 'Ana\tLopez', '﻿Ana', 'x'.repeat(40)]) assert.equal(cleanText(s), cleanName(s), JSON.stringify(s));
  const long = P('Player,Team\n' + 'x'.repeat(41) + ',T');
  assert.ok(validate(long.draft, { format: 'roundrobin' }).errors.some(e => /too long/.test(e.msg))); // never silently cut
  assert.equal(initials('Net Ninjas'), 'NN');
  assert.equal(initials('Aces'), 'AC');
  assert.equal(initials('  '), '?');
});

test('formula-looking cells are plain text here (only the CSV export needs to defuse them)', () => {
  const r = P('Player,Team\n=1+1,@SUM(A1)\n+cmd,@SUM(A1)');
  assert.equal(r.draft.teams[0].players[0].name, '=1+1');
});

test('toEventInput: sheet teams in sheet order with names, logos and the private DUPR references', () => {
  const r = P('Player,Team,DUPR ID,Logo URL\nAna,Ninjas,k4m2p9,https://example.com/n.png\nBen,Ninjas,,\nCy,Shots,,\nDi,Shots,r7t3qx,');
  const out = toEventInput(r.draft, { format: 'single_elim' });
  assert.deepEqual(out.players, ['Ana', 'Ben', 'Cy', 'Di']);
  assert.deepEqual(out.teams, [['Ana', 'Ben'], ['Cy', 'Di']]);
  assert.deepEqual(out.teamMeta, [{ name: 'Ninjas', logo: 'https://example.com/n.png' }, { name: 'Shots', logo: '' }]);
  assert.equal(out.rotation, 'manual');
  assert.deepEqual(out.refs, { Ana: 'K4M2P9', Di: 'R7T3QX' });
  const rot = toEventInput(r.draft, { format: 'roundrobin', partners: 'rotating' });
  assert.deepEqual(rot.players, ['Ana', 'Ben', 'Cy', 'Di']);
  assert.equal(rot.teams, undefined);
  assert.equal(rot.teamMeta, undefined);
});
