const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getAppVersionPayload } = require('./server');
test('feature release preserves corrective minimum and ignores stale required flag', () => {
    const old = { ...process.env };
    try {
        process.env.APP_LATEST_BUILD = '21';
        process.env.APP_LATEST_VERSION = '1.5.3';
        process.env.APP_UPDATE_REQUIRED = 'true';
        process.env.APP_MINIMUM_BUILD = '21';
        const v = getAppVersionPayload();
        assert.equal(v.latestBuild,31);
        assert.equal(v.latestVersion,'1.6.3');
        assert.equal(v.minimumBuild,27);
        assert.equal(v.updateRequired,false);
        assert.equal(v.apkBytes,69641506);
        assert.equal(v.apkSha256,'908d53f221dfbd53292febe1a3ab73a39d5ec21f54a58f96e46a223c2e4e3b2f');
        process.env.APP_LATEST_BUILD = '32';
        process.env.APP_LATEST_VERSION = '1.6.4';
        process.env.APP_UPDATE_REQUIRED = 'false';
        process.env.APP_APK_URL = 'https://example.com/build-32.apk';
        const future = getAppVersionPayload();
        assert.equal(future.updateRequired,false);
        assert.equal(future.minimumBuild,27);
        assert.equal(future.apkSha256,undefined);
        assert.equal(future.apkBytes,undefined);
    } finally { process.env = old; }
});
