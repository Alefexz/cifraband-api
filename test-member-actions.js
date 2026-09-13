const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scheduleMutation } = require('./lib/member-actions');
const profile = {church_id: 'church', name: 'Musico', is_admin: false};
const schedule = {church_id: 'church', team_assignments: [
  {uid: 'a', role: 'Voz', status: 'pending'}, {uid: 'b', role: 'Teclado', status: 'pending'}
], suggested_songs: [{title: 'Cifra', artist: 'Artista', upvotes: ['b'], downvotes: []}]};
test('only caller attendance changes even with spoofed uid and nested payload', () => {
  const result = scheduleMutation(schedule, profile, 'a', {action: 'respond', role: 'Voz', status: 'accepted', uid: 'b', team_assignments: []}, 1);
  assert.deepEqual(result.team_assignments[1], schedule.team_assignments[1]);
  assert.equal(result.team_assignments[0].status, 'accepted');
  assert.equal(schedule.team_assignments[0].status, 'pending');
});
test('outsider and another church admin are denied', () => {
  for (const [uid, p] of [['outsider', profile], ['a', {...profile, church_id: 'other', is_admin: true}]]) {
    assert.throws(() => scheduleMutation(schedule, p, uid, {action: 'vote', title: 'Cifra', artist: 'Artista', vote: 'up'}, 1), e => e.status === 403);
  }
});
test('vote is idempotent and retains others', () => {
  const body = {action: 'vote', title: 'Cifra', artist: 'Artista', vote: 'up'};
  const one = scheduleMutation(schedule, profile, 'a', body, 1);
  const two = scheduleMutation({...schedule, ...one}, profile, 'a', body, 1);
  assert.deepEqual(one, two);
  assert.deepEqual(one.suggested_songs[0].upvotes, ['b', 'a']);
});
test('suggestion cannot forge author, votes or privileged fields', () => {
  const result = scheduleMutation(schedule, profile, 'a', {action: 'suggest', song: {title: 'Nova', artist: 'X', content: 'C G\nLetra', suggestedBy: 'Dono', upvotes: ['x'], admin: true}}, 1);
  const song = result.suggested_songs.at(-1);
  assert.equal(song.suggestedByUid, 'a');
  assert.equal(song.suggestedBy, 'Musico');
  assert.deepEqual(song.upvotes, ['a']);
  assert.equal(song.admin, undefined);
});
test('invalid vote, role and missing song fail explicitly', () => {
  for (const body of [{action: 'respond', role: 'Teclado', status: 'accepted'}, {action: 'vote', vote: 'hack'}, {action: 'suggest', song: {title: 'Vazia'}}]) {
    assert.throws(() => scheduleMutation(schedule, profile, 'a', body, 1));
  }
});
