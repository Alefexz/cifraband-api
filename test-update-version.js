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
        assert.equal(v.latestBuild,24);
        assert.equal(v.latestVersion,'1.5.6');
        assert.equal(v.minimumBuild,24);
        assert.equal(v.updateRequired,true);
        assert.equal(v.apkBytes,67396066);
        assert.equal(v.apkSha256,'344e3374b2c4d277dc4856cdad55e876b569d361e40cd847f3a2e2041e2ad234');
        process.env.APP_LATEST_BUILD = '25';
        process.env.APP_LATEST_VERSION = '1.5.7';
        process.env.APP_UPDATE_REQUIRED = 'false';
        process.env.APP_APK_URL = 'https://example.com/build-25.apk';
        const future = getAppVersionPayload();
        assert.equal(future.updateRequired,false);
        assert.equal(future.minimumBuild,24);
        assert.equal(future.apkSha256,undefined);
        assert.equal(future.apkBytes,undefined);
    } finally { process.env = old; }
});
