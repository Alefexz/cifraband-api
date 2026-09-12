const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getAppVersionPayload } = require('./server');
test('old mandatory-release variables do not force the new feature release', () => {
    const old = { ...process.env };
    try {
        process.env.APP_LATEST_BUILD = '21';
        process.env.APP_LATEST_VERSION = '1.5.3';
        process.env.APP_UPDATE_REQUIRED = 'true';
        process.env.APP_MINIMUM_BUILD = '21';
        const v = getAppVersionPayload();
        assert.equal(v.latestBuild,23);
        assert.equal(v.minimumBuild,21);
        assert.equal(v.updateRequired,false);
        process.env.APP_LATEST_BUILD = '23';
        process.env.APP_LATEST_VERSION = '1.5.5';
        assert.equal(getAppVersionPayload().updateRequired,true);
    } finally { process.env = old; }
});
