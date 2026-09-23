const {test} = require('node:test');
const assert = require('node:assert/strict');
const {receiptId, cleanSchedule} = require('./lib/account-deletion');
const {createAuthenticator, activeRequestsFor} = require('./lib/firebase-auth');
const {EventEmitter} = require('node:events');
test('receipt identifiers are one-way; schedules remove identity and preserve unrelated votes', () => {
    const input = {team_uids: ['a','b'], team_assignments: [{uid:'a'}, {uid:'b'}],
        suggested_songs: [{suggestedByUid:'a'}, {suggestedByUid:'b', upvotes:['a','b'], downvotes:['a']}],
        approved_songs: [{created_by:'a'}, {created_by:'b'}]};
    assert.deepEqual(cleanSchedule(input, 'a'), {team_uids:['b'], team_assignments:[{uid:'b'}],
        suggested_songs:[{suggestedByUid:'b',upvotes:['b'],downvotes:[]}],approved_songs:[{created_by:'b'}]});
    assert.equal(input.team_uids.length, 2);
    assert.equal(receiptId('a'.repeat(64)).length, 64);
    assert.notEqual(receiptId('a'.repeat(64)), 'a'.repeat(64));
});
test('deletion drain tracks admitted handlers even after client disconnects', async () => {
    const response = new EventEmitter(); response.end = () => {};
    const admin = {auth:()=>({verifyIdToken:async()=>({uid:'in-flight-user'})}),
        firestore:()=>({collection:()=>({doc:()=>({get:async()=>({exists:false})})})})};
    let admitted = false;
    await createAuthenticator(()=>admin)({headers:{authorization:'Bearer synthetic'}},response,()=>{admitted=true;});
    assert.equal(admitted,true);assert.equal(activeRequestsFor('in-flight-user'),1);
    response.emit('close');assert.equal(activeRequestsFor('in-flight-user'),1);
    response.end();response.emit('finish');assert.equal(activeRequestsFor('in-flight-user'),0);
});
