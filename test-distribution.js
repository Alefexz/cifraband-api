const {test} = require('node:test');
const assert = require('node:assert/strict');
const {isEligible, parseRegistration} = require('./lib/update-push');
test('Play devices never receive GitHub release pushes; legacy and direct remain eligible', () => {
    const device = {platform: 'android', enabled: true, build: 1, token: 'sample'};
    for (const distribution of [undefined, 'direct']) {
        assert.equal(isEligible({...device, distribution}, {latestBuild: 27}), true);
    }
    assert.equal(isEligible({...device, distribution: 'play'}, {latestBuild: 27}), false);
});
test('registration accepts explicit channels and rejects unknown distributions', () => {
    const body = {platform: 'android', build: 27, token: 'a'.repeat(30)};
    assert.equal(parseRegistration({...body, distribution: 'play'}).distribution, 'play');
    assert.equal(parseRegistration({...body, distribution: 'direct'}).distribution, 'direct');
    assert.equal(parseRegistration({...body, distribution: 'unknown'}), null);
});
