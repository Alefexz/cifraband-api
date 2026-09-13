const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getAppVersionPayload } = require('./server');
test('security release overrides stale variables without forcing future feature releases', () => {
    const old = { ...process.env };
    try {
        process.env.APP_LATEST_BUILD = '21';
        process.env.APP_LATEST_VERSION = '1.5.3';
        process.env.APP_UPDATE_REQUIRED = 'true';
        process.env.APP_MINIMUM_BUILD = '21';
        const v = getAppVersionPayload();
        assert.equal(v.latestBuild,25);
        assert.equal(v.latestVersion,'1.5.7');
        assert.equal(v.minimumBuild,25);
        assert.equal(v.updateRequired,true);
        assert.equal(v.apkBytes,67412454);
        assert.equal(v.apkSha256,'8c17637fbe1aeb5d10e6ae54582deaae6e6aa5bc78ee3924c3ceb53efed95935');
        process.env.APP_LATEST_BUILD = '26';
        process.env.APP_LATEST_VERSION = '1.5.8';
        process.env.APP_UPDATE_REQUIRED = 'false';
        process.env.APP_APK_URL = 'https://example.com/build-26.apk';
        const future = getAppVersionPayload();
        assert.equal(future.updateRequired,false);
        assert.equal(future.minimumBuild,25);
        assert.equal(future.apkSha256,undefined);
        assert.equal(future.apkBytes,undefined);
    } finally { process.env = old; }
});
