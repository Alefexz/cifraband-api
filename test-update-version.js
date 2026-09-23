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
        assert.equal(v.latestBuild,28);
        assert.equal(v.latestVersion,'1.6.0');
        assert.equal(v.minimumBuild,27);
        assert.equal(v.updateRequired,false);
        assert.equal(v.apkBytes,68019046);
        assert.equal(v.apkSha256,'687579b3b35b5053653fe7a9497da2b6c22b9d39b587f08db63a86aab2525949');
        process.env.APP_LATEST_BUILD = '29';
        process.env.APP_LATEST_VERSION = '1.6.1';
        process.env.APP_UPDATE_REQUIRED = 'false';
        process.env.APP_APK_URL = 'https://example.com/build-29.apk';
        const future = getAppVersionPayload();
        assert.equal(future.updateRequired,false);
        assert.equal(future.minimumBuild,27);
        assert.equal(future.apkSha256,undefined);
        assert.equal(future.apkBytes,undefined);
    } finally { process.env = old; }
});
